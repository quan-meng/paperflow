import { loadPdfJs, normalizePath } from "obsidian";

import type { Paper } from "./arxiv";
import {
	DEFAULT_READING_PROMPT,
	formatHighlightCategoriesForPrompt,
	type PaperImporterPluginSettings,
} from "./setting_tab";
import {
	addPdfSelectionsToCallouts,
	applyPdfCalloutCategoryColors,
} from "./pdf_selection";

const CODEX_TIMEOUT_MS = 420000;
const PDF_TEXT_TIMEOUT_MS = 30000;
const MAX_PDF_TEXT_CHARS = 60000;

type ExecFailure = NodeJS.ErrnoException & {
	killed?: boolean;
	signal?: string | null;
};

interface TextContentItem {
	str: string;
}

interface PdfJsPage {
	getTextContent(): Promise<{ items: TextContentItem[] }>;
}

interface PdfJsDocument {
	numPages: number;
	getPage(page: number): Promise<PdfJsPage>;
	destroy?: () => void;
}

interface VaultAdapterLike {
	getFullPath(path: string): string;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	remove(path: string): Promise<void>;
}

interface AppLike {
	vault: {
		configDir?: string;
		adapter: VaultAdapterLike;
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function getCodexCommands(settings: PaperImporterPluginSettings): string[] {
	const commands = [
		settings.codexCommand.trim(),
		"codex",
		"/opt/homebrew/bin/codex",
		"/usr/local/bin/codex",
	].filter(Boolean);

	return Array.from(new Set(commands));
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
	return match ? match[1].trim() : trimmed;
}

function formatCodexFailure(
	command: string,
	error: ExecFailure,
	stdout: string,
	stderr: string
): string {
	const details = [stderr.trim(), stdout.trim()]
		.filter(Boolean)
		.join("\n")
		.trim();

	if (error.killed && error.signal === "SIGTERM") {
		return `Codex command timed out after ${Math.round(
			CODEX_TIMEOUT_MS / 1000
		)} seconds (${command}).`;
	}

	const status = error.code ? `, code ${error.code}` : "";
	const signal = error.signal ? `, signal ${error.signal}` : "";
	const suffix = details ? `:\n${details}` : "";

	return `Codex command failed (${command}${status}${signal})${suffix}`;
}

function fillPromptTemplate(
	template: string,
	pdfFullPath: string,
	pdfVaultPath: string,
	paper: Paper,
	pdfText: string,
	settings: PaperImporterPluginSettings
): string {
	const pdfName = pdfVaultPath.split("/").pop() || pdfVaultPath;
	const titleWithoutExt = pdfName.replace(/\.pdf$/i, "");
	const replacements: Record<string, string> = {
		reader: "Codex",
		pdf_full_path: pdfFullPath,
		pdf_vault_path: pdfVaultPath,
		pdf_name: pdfName,
		pdf_title: titleWithoutExt,
		title: paper.title,
		paper_id: paper.paperId,
		authors: paper.authors.join(", "),
		abstract: paper.abstract,
		pdf_text: pdfText,
		highlight_categories: formatHighlightCategoriesForPrompt(
			settings.highlightCategories
		),
	};

	return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
		return replacements[key] ?? "";
	});
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
	abortSignal?: AbortSignal
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("Read with Codex canceled."));
			return;
		}

		let settled = false;
		const timeoutId = window.setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(message));
		}, timeoutMs);

		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timeoutId);
			reject(new Error("Read with Codex canceled."));
		};

		abortSignal?.addEventListener("abort", abort);

		operation.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				abortSignal?.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				abortSignal?.removeEventListener("abort", abort);
				reject(error);
			}
		);
	});
}

async function extractPdfText(
	app: AppLike,
	pdfVaultPath: string,
	abortSignal?: AbortSignal
): Promise<string> {
	const pdfjsLib = await loadPdfJs();
	const data = await app.vault.adapter.readBinary(normalizePath(pdfVaultPath));
	const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
	const document = (await withTimeout(
		loadingTask.promise,
		PDF_TEXT_TIMEOUT_MS,
		"Timed out while loading PDF text.",
		abortSignal
	)) as PdfJsDocument;

	try {
		const pages: string[] = [];
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			if (abortSignal?.aborted) {
				throw new Error("Read with Codex canceled.");
			}

			const page = await withTimeout(
				document.getPage(pageNumber),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while loading PDF page text.",
				abortSignal
			);
			const textContent = await withTimeout(
				page.getTextContent(),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while extracting PDF page text.",
				abortSignal
			);
			const pageText = (textContent.items as TextContentItem[])
				.map((item) => item.str)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();

			if (pageText) {
				pages.push(`Page ${pageNumber}\n${pageText}`);
			}

			if (pages.join("\n\n").length >= MAX_PDF_TEXT_CHARS) {
				break;
			}
		}

		return pages.join("\n\n").slice(0, MAX_PDF_TEXT_CHARS);
	} finally {
		document.destroy?.();
	}
}

function runCodexCommand(
	command: string,
	app: AppLike,
	vaultRoot: string,
	prompt: string,
	abortSignal?: AbortSignal
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("Read with Codex canceled."));
			return;
		}

		const { execFile } = require("child_process") as typeof import("child_process");
		let settled = false;
		const outputVaultPath = normalizePath(
			`${app.vault.configDir || ".obsidian"}/plugins/paperflow/codex-output-${Date.now()}-${Math.random()
				.toString(16)
				.slice(2)}.md`
		);
		const outputFullPath = app.vault.adapter.getFullPath(outputVaultPath);
		const cleanupOutput = () => {
			void app.vault.adapter.remove(outputVaultPath).catch(() => {
				// Ignore cleanup failures for temporary output.
			});
		};

		const child = execFile(
			command,
			[
				"exec",
				"--cd",
				vaultRoot,
				"--add-dir",
				vaultRoot,
				"--sandbox",
				"read-only",
				"--skip-git-repo-check",
				"--color",
				"never",
				"--output-last-message",
				outputFullPath,
				prompt,
			],
			{
				cwd: vaultRoot,
				timeout: CODEX_TIMEOUT_MS,
				maxBuffer: 1024 * 1024 * 4,
			},
			(error, stdout, stderr) => {
				if (settled) {
					return;
				}
				settled = true;
				abortSignal?.removeEventListener("abort", abortCodex);
				try {
					if (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							reject(error);
							return;
						}

						reject(
							new Error(
								formatCodexFailure(
									command,
									error as ExecFailure,
									stdout,
									stderr
								)
							)
					);
					return;
				}

					app.vault.adapter
						.read(outputVaultPath)
						.then(resolve)
						.catch(reject)
						.finally(cleanupOutput);
				} catch (error_) {
					cleanupOutput();
					reject(error_);
				}
			}
		);

		const abortCodex = () => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill("SIGTERM");
			cleanupOutput();
			reject(new Error("Read with Codex canceled."));
		};

		abortSignal?.addEventListener("abort", abortCodex);
	});
}

export async function readWithCodex(
	app: any,
	settings: PaperImporterPluginSettings,
	paper: Paper,
	pdfPath: string,
	notePath: string,
	abortSignal?: AbortSignal
): Promise<void> {
	if (!settings.readWithCodex) {
		return;
	}

	if (!pdfPath) {
		throw new Error("Read with Codex requires a downloaded PDF.");
	}

	if (typeof require === "undefined") {
		throw new Error("Read with Codex is only available in Obsidian desktop.");
	}

	const vaultRoot = app.vault.adapter.getFullPath("");
	const normalizedPdfPath = normalizePath(pdfPath);
	const pdfFullPath = app.vault.adapter.getFullPath(normalizedPdfPath);
	const pdfText = await extractPdfText(app, normalizedPdfPath, abortSignal);
	const prompt = fillPromptTemplate(
		settings.readingPrompt.trim() || DEFAULT_READING_PROMPT,
		pdfFullPath,
		normalizedPdfPath,
		paper,
		pdfText,
		settings
	);

	let lastError: unknown;
	for (const command of getCodexCommands(settings)) {
		try {
			let output = stripCodeFence(
				await runCodexCommand(command, app, vaultRoot, prompt, abortSignal)
			);

			if (!output) {
				throw new Error("Codex returned an empty response.");
			}

			output = applyPdfCalloutCategoryColors(output, {
				categories: settings.highlightCategories,
			});

			if (settings.includePdfHighlights) {
				output = await addPdfSelectionsToCallouts(
					output,
					app,
					normalizedPdfPath,
					abortSignal
				);
			}

			await app.vault.adapter.process(notePath, (content: string) => {
				if (content.includes("## Codex Reading")) {
					return content;
				}

				return `${content.trimEnd()}\n\n${output}\n`;
			});
			return;
		} catch (error) {
			lastError = error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(getErrorMessage(error));
			}
		}
	}

	throw new Error(getErrorMessage(lastError));
}
