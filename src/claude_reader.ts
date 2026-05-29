import { normalizePath } from "obsidian";

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

const CLAUDE_TIMEOUT_MS = 180000;

type ExecFailure = NodeJS.ErrnoException & {
	killed?: boolean;
	signal?: string | null;
};

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function getClaudeCommands(settings: PaperImporterPluginSettings): string[] {
	const commands = [
		settings.claudeCommand.trim(),
		"claude",
		"/Users/mq/.local/bin/claude",
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	].filter(Boolean);

	return Array.from(new Set(commands));
}

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i);
	return match ? match[1].trim() : trimmed;
}

function formatClaudeFailure(
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
		return `Claude command timed out after ${Math.round(
			CLAUDE_TIMEOUT_MS / 1000
		)} seconds (${command}).`;
	}

	const status = error.code ? `, code ${error.code}` : "";
	const signal = error.signal ? `, signal ${error.signal}` : "";
	const suffix = details ? `:\n${details}` : "";

	return `Claude command failed (${command}${status}${signal})${suffix}`;
}

function fillPromptTemplate(
	template: string,
	pdfFullPath: string,
	pdfVaultPath: string,
	paper: Paper,
	settings: PaperImporterPluginSettings
): string {
	const pdfName = pdfVaultPath.split("/").pop() || pdfVaultPath;
	const titleWithoutExt = pdfName.replace(/\.pdf$/i, "");
	const replacements: Record<string, string> = {
		reader: "Claude",
		pdf_full_path: pdfFullPath,
		pdf_vault_path: pdfVaultPath,
		pdf_name: pdfName,
		pdf_title: titleWithoutExt,
		title: paper.title,
		paper_id: paper.paperId,
		authors: paper.authors.join(", "),
		abstract: paper.abstract,
		pdf_text: "",
		highlight_categories: formatHighlightCategoriesForPrompt(
			settings.highlightCategories
		),
	};

	return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
		return replacements[key] ?? "";
	});
}

function runClaudeCommand(
	command: string,
	vaultRoot: string,
	prompt: string,
	abortSignal?: AbortSignal
): Promise<string> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("Read with Claude canceled."));
			return;
		}

		const { execFile } = require("child_process") as typeof import("child_process");
		let settled = false;

		const child = execFile(
			command,
			[
				"--print",
				"--output-format",
				"text",
				"--permission-mode",
				"bypassPermissions",
				"--allowedTools=Read",
				`--add-dir=${vaultRoot}`,
				prompt,
			],
			{
				cwd: vaultRoot,
				timeout: CLAUDE_TIMEOUT_MS,
				maxBuffer: 1024 * 1024 * 2,
			},
			(error, stdout, stderr) => {
				if (settled) {
					return;
				}
				settled = true;
				abortSignal?.removeEventListener("abort", abortClaude);
				if (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(error);
						return;
					}

					reject(
						new Error(
							formatClaudeFailure(
								command,
								error as ExecFailure,
								stdout,
								stderr
							)
						)
					);
					return;
				}

				resolve(stdout);
			}
		);

		const abortClaude = () => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill("SIGTERM");
			reject(new Error("Read with Claude canceled."));
		};

		abortSignal?.addEventListener("abort", abortClaude);
		child.stdin?.end();
	});
}

export async function readWithClaude(
	app: any,
	settings: PaperImporterPluginSettings,
	paper: Paper,
	pdfPath: string,
	notePath: string,
	abortSignal?: AbortSignal
): Promise<void> {
	if (!settings.readWithClaude) {
		return;
	}

	if (!pdfPath) {
		throw new Error("Read with Claude requires a downloaded PDF.");
	}

	if (typeof require === "undefined") {
		throw new Error("Read with Claude is only available in Obsidian desktop.");
	}

	const vaultRoot = app.vault.adapter.getFullPath("");
	const normalizedPdfPath = normalizePath(pdfPath);
	const pdfFullPath = app.vault.adapter.getFullPath(normalizedPdfPath);
	const prompt = fillPromptTemplate(
		settings.readingPrompt.trim() || DEFAULT_READING_PROMPT,
		pdfFullPath,
		normalizedPdfPath,
		paper,
		settings
	);

	let lastError: unknown;
	for (const command of getClaudeCommands(settings)) {
		try {
			let output = stripCodeFence(
				await runClaudeCommand(command, vaultRoot, prompt, abortSignal)
			);

			if (!output) {
				throw new Error("Claude returned an empty response.");
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
				if (content.includes("## Claude Reading")) {
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
