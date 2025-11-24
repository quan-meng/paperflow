import { App, Modal, Notice, normalizePath } from "obsidian";
import { mount, unmount } from "svelte";

import ImportDialog from "./component/ImportDialog.svelte";

import { searchPaper } from "./arxiv";
import { DEFAULT_TEMPLATE } from "./default_template";
import type { PaperImporterPluginSettings } from "./setting_tab";

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
		/[:\{\}\[\],&*#?|\-<>=!%@`"'\\]/.test(trimmed) ||
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

export class ImportModal extends Modal {
	settings: PaperImporterPluginSettings;
	downloadPdf: boolean;
	importDialog: ReturnType<typeof ImportDialog> | null = null;
	states: Record<string, any> = $state({
		logs: [],
		downloadProgress: 0,
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

						let arxivId: string;
						try {
							arxivId = this.extractArxivId(paperUri);
						} catch (error) {
							this.states.downloadProgress = 0;
							new Notice(error.message);
							return;
						}

						try {
							const [notePath, _] =
								await this.searchAndImportPaper(arxivId);
							await this.app.workspace.openLinkText(
								notePath,
								"",
								true
							);
						} catch (error) {
							this.states.downloadProgress = 0;
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

	async searchAndImportPaper(arxivId: string): Promise<[string, string]> {
		const paper = await searchPaper(arxivId);

		let pdfPath = "";

		if (this.downloadPdf) {
			pdfPath = await this.downloadPdfFile(paper);
		}

		const notePath = await this.createNoteFromPaper(paper, pdfPath);

		this.states.downloadProgress = 100;
		return [notePath, pdfPath];
	}

	private async downloadPdfFile(paper: any): Promise<string> {
		const pdfFolder = normalizePath(this.settings.pdfFolder);

		let pdfFolderPath = this.app.vault.getFolderByPath(pdfFolder)!;
		if (!pdfFolderPath) {
			pdfFolderPath = await this.app.vault.createFolder(pdfFolder);
		}

		const pdfFilename = sanitizeFilename(
			`${paper.title} (${paper.paperId}).pdf`
		);
		const pdfPath = normalizePath(`${pdfFolderPath.path}/${pdfFilename}`);

		// Check if PDF already exists
		const pdfExists = await this.app.vault.adapter.exists(pdfPath);
		if (pdfExists) {
			this.states.logs.push([
				"warn",
				`PDF already exists: ${pdfPath}. Skipping download.`,
			]);
			new Notice(
				`PDF already exists: ${pdfFilename}. Using existing file.`
			);
			return pdfPath; // Return the existing PDF path instead of throwing an error
		}

		// Download PDF with progress tracking
		this.states.downloadProgress = 0;
		this.states.logs.push(["info", "Starting PDF download..."]);

		try {
			const response = await fetch(paper.pdfUrl);
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
				} else {
					// If we don't know the total size, show indeterminate progress
					this.states.downloadProgress = Math.min(
						50 + (received / 1000000) * 10,
						90
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
			this.states.logs.push([
				"error",
				`PDF download failed: ${error.message}`,
			]);
			throw error;
		}

		this.states.logs.push(["info", `PDF downloaded: ${pdfPath}`]);
		return pdfPath;
	}

	private async createNoteFromPaper(
		paper: any,
		pdfPath: string
	): Promise<string> {
		const noteFolder = normalizePath(this.settings.noteFolder);

		let noteFolderPath = this.app.vault.getFolderByPath(noteFolder)!;
		if (!noteFolderPath) {
			noteFolderPath = await this.app.vault.createFolder(noteFolder);
		}

		const noteFilename = sanitizeFilename(
			`${paper.title} (${paper.paperId}).md`
		);
		const notePath = normalizePath(
			`${noteFolderPath.path}/${noteFilename}`
		);

		// Check if note already exists
		const noteExists = await this.app.vault.adapter.exists(notePath);
		if (noteExists) {
			this.states.logs.push(["warn", `Note already exists: ${notePath}`]);
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
			.replace(/{{\s*authors\s*}}/g, `[${paper.authors.join(", ")}]`)
			.replace(/{{\s*date\s*}}/g, paper.date)
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

		this.states.logs.push(["info", `Note created: ${notePath}`]);
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
					this.states.logs.push([
						"info",
						`Using custom template: ${templatePath}`,
					]);
					return template;
				} else {
					this.states.logs.push([
						"warn",
						`Template file not found: ${templatePath}, using default template`,
					]);
				}
			} catch (error) {
				this.states.logs.push([
					"error",
					`Failed to read template file: ${error.message}, using default template`,
				]);
			}
		}

		this.states.logs.push(["info", "Using default template"]);
		return this.getDefaultTemplate();
	}

	extractArxivId(text: string): string {
		// Match against arXiv:xxxx.xxxx or arxiv:xxxx.xxxxx
		const arxivIdPattern = /^ar[Xx]iv:(\d{4}\.\d{4,5}(?:v\d+)?)$/;
		const match = text.match(arxivIdPattern);
		if (match) {
			return match[match.length - 1];
		}

		// Match against arXiv:xxxxx/xxxxxxx or arxiv:xxxxx/xxxxxxx
		const arxivIdPattern2 = /^ar[Xx]iv:(.+\/\d+(?:v\d+)?)$/;
		const match2 = text.match(arxivIdPattern2);
		if (match2) {
			return match2[match2.length - 1];
		}

		// Match against arxiv.org/abs/xxxx.xxxx or
		// arxiv.org/abs/xxxx.xxxxx or
		// arxiv.org/pdf/xxxx.xxxx or
		// arxiv.org/pdf/xxxx.xxxxx or
		// arxiv.org/html/xxxx.xxxx or
		// arxiv.org/html/xxxx.xxxxx
		const urlPattern =
			/^(https?:\/\/)?(www\.)?arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)$/;
		const urlMatch = text.match(urlPattern);
		if (urlMatch) {
			return urlMatch[urlMatch.length - 1];
		}

		// Match against arxiv.org/abs/xxxxx/xxxxxxx or
		// arxiv.org/pdf/xxxxx/xxxxxxx or
		// arxiv.org/html/xxxxx/xxxxxx or
		const urlPattern2 =
			/^(https?:\/\/)?(www\.)?arxiv\.org\/(abs|pdf|html)\/(.+\/\d+(?:v\d+)?)$/;
		const urlMatch2 = text.match(urlPattern2);
		if (urlMatch2) {
			return urlMatch2[urlMatch2.length - 1];
		}

		// Match against xxxx.xxxx or xxxx.xxxxx
		const idPattern = /^(\d{4}\.\d{4,5}(?:v\d+)?)$/;
		const idMatch = text.match(idPattern);
		if (idMatch) {
			return idMatch[idMatch.length - 1];
		}

		// Match against xxxxx/xxxxxxx
		const idPattern2 = /^(\d+\/\d+(?:v\d+)?)$/;
		const idMatch2 = text.match(idPattern2);
		if (idMatch2) {
			return idMatch2[idMatch2.length - 1];
		}

		throw new Error("Invalid arXiv ID or URL");
	}

	getDefaultTemplate(): string {
		return DEFAULT_TEMPLATE;
	}
}
