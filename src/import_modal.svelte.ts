import { App, Modal, Notice, normalizePath } from "obsidian";
import { mount, unmount } from "svelte";

import ImportDialog from "./component/ImportDialog.svelte";

import { readWithClaude } from "./claude_reader";
import { readWithCodex } from "./codex_reader";
import { searchPaper } from "./arxiv";
import { extractPaperFromPdf } from "./pdf_metadata";
import { DEFAULT_TEMPLATE } from "./default_template";
import type { PaperImporterPluginSettings } from "./setting_tab";
import type { Paper } from "./arxiv";

const PDF_DOWNLOAD_TIMEOUT_MS = 120000;

/**
 * A normalized import request. PaperFlow accepts either an arXiv identifier or a
 * local PDF file (provided as in-memory bytes from a file picker, or as a path
 * to a PDF inside or outside the vault).
 */
export interface ArxivImportSource {
	kind: "arxiv";
	arxivId: string;
	label: string;
}

export interface PdfImportSource {
	kind: "pdf";
	label: string;
	fileName: string;
	path?: string;
	bytes?: ArrayBuffer;
}

export type ImportSource = ArxivImportSource | PdfImportSource;

function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

/**
 * Parse a raw text input into an {@link ImportSource}. arXiv IDs and URLs are
 * recognized first; anything ending in `.pdf` is treated as a path to a local
 * PDF file.
 */
export function parseImportSource(text: string): ImportSource {
	const trimmed = text.trim();

	try {
		const arxivId = parseArxivId(trimmed);
		return { kind: "arxiv", arxivId, label: arxivId };
	} catch {
		// Not an arXiv input; fall through to PDF handling.
	}

	const withoutScheme = trimmed.replace(/^file:\/\//i, "");
	if (/\.pdf$/i.test(withoutScheme)) {
		const fileName = basename(withoutScheme);
		return {
			kind: "pdf",
			label: fileName,
			fileName,
			path: withoutScheme,
		};
	}

	throw new Error("Enter an arXiv ID, an arXiv URL, or a path to a PDF file.");
}

/**
 * Extract a bare arXiv ID from an ID or URL. Throws when the text is not a
 * recognizable arXiv reference.
 */
export function parseArxivId(text: string): string {
	const trimmed = text.trim();

	// Match against arXiv:xxxx.xxxx or arxiv:xxxx.xxxxx
	const arxivIdPattern = /^ar[Xx]iv:(\d{4}\.\d{4,5}(?:v\d+)?)$/;
	const match = trimmed.match(arxivIdPattern);
	if (match) {
		return match[match.length - 1];
	}

	// Match against arXiv:xxxxx/xxxxxxx or arxiv:xxxxx/xxxxxxx
	const arxivIdPattern2 = /^ar[Xx]iv:(.+\/\d+(?:v\d+)?)$/;
	const match2 = trimmed.match(arxivIdPattern2);
	if (match2) {
		return match2[match2.length - 1];
	}

	// Match against arxiv.org/abs|pdf|html/xxxx.xxxx(x), with an optional .pdf
	const urlPattern =
		/^(https?:\/\/)?(www\.)?arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/i;
	const urlMatch = trimmed.match(urlPattern);
	if (urlMatch) {
		return urlMatch[urlMatch.length - 1];
	}

	// Match against arxiv.org/abs|pdf|html/xxxxx/xxxxxxx, with an optional .pdf
	const urlPattern2 =
		/^(https?:\/\/)?(www\.)?arxiv\.org\/(abs|pdf|html)\/(.+\/\d+(?:v\d+)?)(?:\.pdf)?$/i;
	const urlMatch2 = trimmed.match(urlPattern2);
	if (urlMatch2) {
		return urlMatch2[urlMatch2.length - 1];
	}

	// Match against xxxx.xxxx or xxxx.xxxxx
	const idPattern = /^(\d{4}\.\d{4,5}(?:v\d+)?)$/;
	const idMatch = trimmed.match(idPattern);
	if (idMatch) {
		return idMatch[idMatch.length - 1];
	}

	// Match against xxxxx/xxxxxxx
	const idPattern2 = /^(\d+\/\d+(?:v\d+)?)$/;
	const idMatch2 = trimmed.match(idPattern2);
	if (idMatch2) {
		return idMatch2[idMatch2.length - 1];
	}

	throw new Error("Invalid arXiv ID or URL");
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function sanitizeForFrontmatter(value?: string | null): string {
	if (!value) {
		return '""';
	}

	const trimmed = value.trim();

	// If empty after trimming, return empty quoted string
	if (!trimmed) {
		return '""';
	}

	// Check if the string contains characters that require special handling in YAML
	const needsQuoting =
		/[:{}[\],&*#?|\-<>=!%@`"'\\]/.test(trimmed) ||
		trimmed.startsWith(" ") ||
		trimmed.endsWith(" ") ||
		/^\d/.test(trimmed) ||
		/^(true|false|yes|no|null)$/i.test(trimmed);

	// Check if it contains newlines (multiline)
	const hasNewlines = /[\r\n]/.test(trimmed);

	if (hasNewlines) {
		// Use literal block scalar (|) for multiline content
		// This preserves newlines and is ideal for abstracts
		const indented = trimmed
			.split("\n")
			.map((line) => "  " + line)
			.join("\n");
		return "|\n" + indented;
	}

	if (needsQuoting) {
		// Use double quotes and escape internal quotes and backslashes
		const escaped = trimmed
			.replace(/\\/g, "\\\\") // Escape backslashes first
			.replace(/"/g, '\\"'); // Escape double quotes
		return `"${escaped}"`;
	}

	// Safe to use unquoted
	return trimmed;
}

function sanitizeFilename(filename: string): string {
	return filename
		.replace(/[/\\?%*:|"<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build the base file name for a paper's PDF and note. The arXiv ID is appended
 * in parentheses when present; PDF imports without an arXiv ID use the title
 * alone.
 */
function paperBaseName(paper: Paper): string {
	const id = paper.paperId?.trim();
	const base = id ? `${paper.title} (${id})` : paper.title;
	return sanitizeFilename(base);
}

function formatDateForObsidian(dateString: string): string {
	if (!dateString || !dateString.trim()) {
		return "";
	}

	const date = new Date(dateString);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	const hours = String(date.getUTCHours()).padStart(2, "0");
	const minutes = String(date.getUTCMinutes()).padStart(2, "0");

	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export class ImportModal extends Modal {
	settings: PaperImporterPluginSettings;
	downloadPdf: boolean;
	abortSignal?: AbortSignal;
	importDialog: ReturnType<typeof ImportDialog> | null = null;
	states: Record<string, any> = $state({
		logs: [],
		downloadProgress: 0,
		statusMessage: "",
	});

	constructor(
		app: App,
		settings: PaperImporterPluginSettings,
		downloadPdf: boolean = true
	) {
		super(app);
		this.settings = settings;
		this.downloadPdf = downloadPdf;
	}

	onOpen() {
		let { contentEl } = this;

		this.importDialog = mount(ImportDialog, {
			target: contentEl,
			props: {
				states: this.states,
				downloadPdf: this.downloadPdf,
				onkeypress: async (e: KeyboardEvent, paperUri: string) => {
					if (e.key === "Enter") {
						// Reset progress and messages
						this.states.downloadProgress = 0;
						this.states.logs.length = 0;
						this.states.logs.push([
							"info",
							this.downloadPdf
								? "Importing paper..."
								: "Importing metadata...",
						]);

						let importSource: ImportSource;
						try {
							importSource = parseImportSource(paperUri);
						} catch (error) {
							this.states.downloadProgress = 0;
							new Notice(getErrorMessage(error));
							return;
						}

						try {
							const [notePath] =
								await this.searchAndImportPaper(importSource);
							await this.app.workspace.openLinkText(
								notePath,
								"",
								true
							);
						} catch (error) {
							this.states.downloadProgress = 0;
							const message = getErrorMessage(error);
							this.states.logs.push(["error", message]);
							new Notice(message);
							return;
						}

						// Add a simple success message
						this.states.logs.push(["success", "Import completed!"]);

						// Show a notice based on the last log entry
						const lastLog =
							this.states.logs[this.states.logs.length - 1];
						if (lastLog && lastLog[0] === "success") {
							new Notice(lastLog[1]);
						}

						this.close();
					}
				},
			},
		});
	}

	onClose() {
		if (this.importDialog) {
			unmount(this.importDialog);
		}
	}

	async searchAndImportPaper(
		source: ImportSource | string
	): Promise<[string, string]> {
		const importSource: ImportSource =
			typeof source === "string"
				? { kind: "arxiv", arxivId: source, label: source }
				: source;

		this.throwIfAborted();

		let paper: Paper;
		let pdfBytes: ArrayBuffer | undefined;

		if (importSource.kind === "arxiv") {
			this.addLog("info", "Fetching metadata from arXiv...");
			paper = await searchPaper(importSource.arxivId);
		} else {
			this.addLog("info", "Reading metadata from PDF...");
			pdfBytes = await this.loadPdfBytes(importSource);
			paper = await extractPaperFromPdf({
				bytes: new Uint8Array(pdfBytes),
				fileName: importSource.fileName,
				abortSignal: this.abortSignal,
				log: (message) => this.addLog("info", message),
			});
		}

		this.throwIfAborted();
		this.addLog("info", `Found paper: ${paper.title}`);

		let pdfPath = "";

		if (importSource.kind === "arxiv") {
			if (this.downloadPdf) {
				pdfPath = await this.downloadPdfFile(paper);
			}
		} else if (this.downloadPdf && pdfBytes) {
			pdfPath = await this.savePdfFile(paper, pdfBytes);
		} else if (importSource.path) {
			// Metadata-only import: reference the source PDF if it is in the vault.
			const vaultPath = normalizePath(importSource.path);
			if (await this.app.vault.adapter.exists(vaultPath)) {
				pdfPath = vaultPath;
			}
		}

		this.throwIfAborted();
		const notePath = await this.createNoteFromPaper(paper, pdfPath);

		if (this.settings.readWithClaude) {
			if (pdfPath) {
				this.throwIfAborted();
				this.addLog("info", "Reading PDF with Claude...");
				await readWithClaude(
					this.app,
					this.settings,
					paper,
					pdfPath,
					notePath,
					this.abortSignal
				);
				this.addLog("info", "Claude reading appended to note");
			} else {
				this.addLog(
					"warn",
					"Read with Claude skipped because no PDF was downloaded"
				);
			}
		}

		if (this.settings.readWithCodex) {
			if (pdfPath) {
				this.throwIfAborted();
				this.addLog("info", "Reading PDF with Codex...");
				await readWithCodex(
					this.app,
					this.settings,
					paper,
					pdfPath,
					notePath,
					this.abortSignal
				);
				this.addLog("info", "Codex reading appended to note");
			} else {
				this.addLog(
					"warn",
					"Read with Codex skipped because no PDF was downloaded"
				);
			}
		}

		this.states.downloadProgress = 100;
		return [notePath, pdfPath];
	}

	private setStatus(message: string): void {
		this.states.statusMessage = message;
	}

	private addLog(level: string, message: string): void {
		this.setStatus(message);
		this.states.logs.push([level, message]);
	}

	private throwIfAborted(): void {
		if (this.abortSignal?.aborted) {
			throw new Error("Import canceled.");
		}
	}

	private async loadPdfBytes(source: ImportSource): Promise<ArrayBuffer> {
		if (source.kind !== "pdf") {
			throw new Error("Cannot load PDF bytes from a non-PDF source.");
		}

		if (source.bytes) {
			return source.bytes;
		}

		if (!source.path) {
			throw new Error("No PDF data or path was provided.");
		}

		// Read the PDF from the vault. Use a vault-relative path so the import
		// works on desktop and mobile; for files outside the vault, use the
		// "Choose PDF" button, which provides the file contents directly.
		const vaultPath = normalizePath(source.path);
		if (await this.app.vault.adapter.exists(vaultPath)) {
			return this.app.vault.adapter.readBinary(vaultPath);
		}

		throw new Error(
			`PDF not found in vault: ${source.path}. Use "Choose PDF" to import a file from outside the vault.`
		);
	}

	private async savePdfFile(
		paper: Paper,
		bytes: ArrayBuffer
	): Promise<string> {
		const pdfFolder = normalizePath(this.settings.pdfFolder);

		let pdfFolderPath = this.app.vault.getFolderByPath(pdfFolder)!;
		if (!pdfFolderPath) {
			pdfFolderPath = await this.app.vault.createFolder(pdfFolder);
		}

		const pdfFilename = `${paperBaseName(paper)}.pdf`;
		const pdfPath = normalizePath(`${pdfFolderPath.path}/${pdfFilename}`);

		const pdfExists = await this.app.vault.adapter.exists(pdfPath);
		if (pdfExists) {
			this.addLog(
				"warn",
				`PDF already exists: ${pdfPath}. Using existing file.`
			);
			return pdfPath;
		}

		await this.app.vault.adapter.writeBinary(pdfPath, bytes);
		this.addLog("info", `PDF saved: ${pdfPath}`);
		return pdfPath;
	}

	private async downloadPdfFile(paper: Paper): Promise<string> {
		const pdfFolder = normalizePath(this.settings.pdfFolder);

		let pdfFolderPath = this.app.vault.getFolderByPath(pdfFolder)!;
		if (!pdfFolderPath) {
			pdfFolderPath = await this.app.vault.createFolder(pdfFolder);
		}

		const pdfFilename = `${paperBaseName(paper)}.pdf`;
		const pdfPath = normalizePath(`${pdfFolderPath.path}/${pdfFilename}`);

		// Check if PDF already exists
		const pdfExists = await this.app.vault.adapter.exists(pdfPath);
		if (pdfExists) {
			this.addLog(
				"warn",
				`PDF already exists: ${pdfPath}. Skipping download.`
			);
			new Notice(
				`PDF already exists: ${pdfFilename}. Using existing file.`
			);
			return pdfPath; // Return the existing PDF path instead of throwing an error
		}

		// Download PDF with progress tracking
		this.states.downloadProgress = 0;
		this.addLog("info", "Starting PDF download...");
		const controller = new AbortController();
		const abortDownload = () => controller.abort();
		this.abortSignal?.addEventListener("abort", abortDownload);
		const timeoutId = window.setTimeout(
			() => controller.abort(),
			PDF_DOWNLOAD_TIMEOUT_MS
		);

		try {
			const response = await fetch(paper.pdfUrl, {
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(
					`Failed to download PDF: ${response.statusText}`
				);
			}

			const contentLength = response.headers.get("content-length");
			const total = contentLength ? parseInt(contentLength, 10) : 0;

			if (!response.body) {
				throw new Error("Response body is empty");
			}

			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let received = 0;

			while (true) {
				const { done, value } = await reader.read();

				if (done) break;

				chunks.push(value);
				received += value.length;

				if (total > 0) {
					this.states.downloadProgress = (received / total) * 100;
					this.setStatus(
						`Downloading PDF ${Math.round(this.states.downloadProgress)}%`
					);
				} else {
					// If we don't know the total size, show indeterminate progress
					this.states.downloadProgress = Math.min(
						50 + (received / 1000000) * 10,
						90
					);
					this.setStatus(
						`Downloading PDF ${Math.round(received / 1024 / 1024)} MB`
					);
				}
			}

			// Combine all chunks into a single array buffer
			const arrayBuffer = new Uint8Array(received);
			let position = 0;
			for (const chunk of chunks) {
				arrayBuffer.set(chunk, position);
				position += chunk.length;
			}

			await this.app.vault.adapter.writeBinary(
				pdfPath,
				arrayBuffer.buffer
			);
		} catch (error) {
			this.states.downloadProgress = 0;
			const message =
				error instanceof DOMException && error.name === "AbortError"
					? this.abortSignal?.aborted
						? "Import canceled."
						: "PDF download timed out. Please try again later."
					: getErrorMessage(error);
			this.addLog(
				"error",
				`PDF download failed: ${message}`
			);
			throw new Error(message);
		} finally {
			window.clearTimeout(timeoutId);
			this.abortSignal?.removeEventListener("abort", abortDownload);
		}

		this.addLog("info", `PDF downloaded: ${pdfPath}`);
		return pdfPath;
	}

	private async createNoteFromPaper(
		paper: Paper,
		pdfPath: string
	): Promise<string> {
		const noteFolder = normalizePath(this.settings.noteFolder);

		let noteFolderPath = this.app.vault.getFolderByPath(noteFolder)!;
		if (!noteFolderPath) {
			noteFolderPath = await this.app.vault.createFolder(noteFolder);
		}

		const noteFilename = `${paperBaseName(paper)}.md`;
		const notePath = normalizePath(
			`${noteFolderPath.path}/${noteFilename}`
		);

		// Check if note already exists
		const noteExists = await this.app.vault.adapter.exists(notePath);
		if (noteExists) {
			this.addLog("warn", `Note already exists: ${notePath}`);
			new Notice(
				`Note already exists: ${noteFilename}. Opening existing note.`
			);
			return notePath; // Return the existing note path instead of creating a new one
		}

		const template = await this.loadTemplate();

		// Determine PDF link format based on whether we downloaded the PDF
		const pdfLink = pdfPath ? `[[${pdfPath}]]` : `${paper.pdfUrl}`;

		const noteContent = template
			.replace(/{{\s*paper_id\s*}}/g, paper.paperId)
			.replace(/{{\s*title\s*}}/g, sanitizeForFrontmatter(paper.title))
			.replace(
				/{{\s*authors\s*}}/g,
				sanitizeForFrontmatter(paper.authors.join(", "))
			)
			.replace(/{{\s*date\s*}}/g, formatDateForObsidian(paper.date))
			.replace(
				/{{\s*abstract\s*}}/g,
				sanitizeForFrontmatter(paper.abstract)
			)
			.replace(
				/{{\s*comments\s*}}/g,
				sanitizeForFrontmatter(paper.comments)
			)
			.replace(/{{\s*pdf_link\s*}}/g, `${pdfLink}`);

		await this.app.vault.adapter.write(notePath, noteContent);

		this.addLog("info", `Note created: ${notePath}`);
		return notePath;
	}

	private async loadTemplate(): Promise<string> {
		if (
			this.settings.templateFilePath &&
			this.settings.templateFilePath.trim()
		) {
			try {
				const templatePath = normalizePath(
					this.settings.templateFilePath
				);
				const exists = await this.app.vault.adapter.exists(
					templatePath
				);
				if (exists) {
					const template = await this.app.vault.adapter.read(
						templatePath
					);
					this.addLog("info", `Using custom template: ${templatePath}`);
					return template;
				} else {
					this.addLog(
						"warn",
						`Template file not found: ${templatePath}, using default template`
					);
				}
			} catch (error) {
				this.addLog(
					"error",
					`Failed to read template file: ${getErrorMessage(error)}, using default template`
				);
			}
		}

		this.addLog("info", "Using default template");
		return this.getDefaultTemplate();
	}

	extractArxivId(text: string): string {
		return parseArxivId(text);
	}

	parseImportSource(text: string): ImportSource {
		return parseImportSource(text);
	}

	getDefaultTemplate(): string {
		return DEFAULT_TEMPLATE;
	}
}
