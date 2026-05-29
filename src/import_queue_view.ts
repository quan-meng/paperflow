import { ItemView, Notice, WorkspaceLeaf } from "obsidian";

import { ImportModal } from "./import_modal.svelte";
import type PaperImporterPlugin from "./main";

export const IMPORT_QUEUE_VIEW_TYPE = "paper-importer-queue";

type ImportTaskStatus = "queued" | "running" | "success" | "error";

interface ImportTask {
	id: number;
	input: string;
	arxivId: string;
	downloadPdf: boolean;
	status: ImportTaskStatus;
	states: Record<string, any>;
	notePath?: string;
	pdfPath?: string;
	error?: string;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

export class ImportQueueView extends ItemView {
	private plugin: PaperImporterPlugin;
	private nextTaskId = 1;
	private tasks: ImportTask[] = [];
	private processing = false;
	private inputEl?: HTMLInputElement;
	private downloadPdfEl?: HTMLInputElement;
	private taskListEl?: HTMLElement;
	private emptyEl?: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: PaperImporterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return IMPORT_QUEUE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Paper import queue";
	}

	getIcon(): string {
		return "download";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {}

	setDownloadPdf(downloadPdf: boolean): void {
		if (this.downloadPdfEl) {
			this.downloadPdfEl.checked = downloadPdf;
		}
	}

	focusInput(): void {
		window.setTimeout(() => {
			this.inputEl?.focus();
		}, 0);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("paper-importer-queue-view");

		contentEl.createEl("h4", { text: "Paper Import Queue" });

		const formEl = contentEl.createDiv("paper-importer-queue-form");
		this.inputEl = formEl.createEl("input", {
			type: "text",
			placeholder: "arXiv ID or URL",
		});
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.enqueueFromInput();
			}
		});

		const addButtonEl = formEl.createEl("button", { text: "Queue" });
		addButtonEl.addEventListener("click", () => {
			this.enqueueFromInput();
		});

		const optionsEl = contentEl.createDiv("paper-importer-queue-options");
		const labelEl = optionsEl.createEl("label");
		this.downloadPdfEl = labelEl.createEl("input", {
			type: "checkbox",
		});
		this.downloadPdfEl.checked = true;
		labelEl.appendText(" Download PDF");

		this.emptyEl = contentEl.createDiv("paper-importer-queue-empty");
		this.emptyEl.setText("No queued imports.");

		this.taskListEl = contentEl.createDiv("paper-importer-queue-list");
		this.renderTasks();
	}

	private enqueueFromInput(): void {
		const input = this.inputEl?.value.trim() || "";
		const downloadPdf = this.downloadPdfEl?.checked ?? true;

		if (!input) {
			new Notice("Enter an arXiv ID or URL to queue.");
			return;
		}

		this.enqueue(input, downloadPdf);

		if (this.inputEl) {
			this.inputEl.value = "";
			this.inputEl.focus();
		}
	}

	private enqueue(input: string, downloadPdf: boolean): void {
		let arxivId: string;
		try {
			const parser = new ImportModal(
				this.app,
				this.plugin.settings,
				downloadPdf
			);
			arxivId = parser.extractArxivId(input);
		} catch (error) {
			new Notice(getErrorMessage(error));
			return;
		}

		this.tasks.push({
			id: this.nextTaskId++,
			input,
			arxivId,
			downloadPdf,
			status: "queued",
			states: {
				logs: [["info", "Queued"]],
				downloadProgress: 0,
			},
		});

		this.renderTasks();
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		if (this.processing) {
			return;
		}

		this.processing = true;

		try {
			let task = this.tasks.find((item) => item.status === "queued");
			while (task) {
				await this.runTask(task);
				task = this.tasks.find((item) => item.status === "queued");
			}
		} finally {
			this.processing = false;
			this.renderTasks();
		}
	}

	private async runTask(task: ImportTask): Promise<void> {
		task.status = "running";
		task.states.logs = [
			[
				"info",
				task.downloadPdf
					? "Importing metadata and PDF..."
					: "Importing metadata...",
			],
		];
		task.states.downloadProgress = 0;
		this.renderTasks();

		const refreshId = window.setInterval(() => {
			this.renderTasks();
		}, 500);

		try {
			const runner = new ImportModal(
				this.app,
				this.plugin.settings,
				task.downloadPdf
			);
			runner.states = task.states;

			const [notePath, pdfPath] = await runner.searchAndImportPaper(
				task.arxivId
			);

			task.notePath = notePath;
			task.pdfPath = pdfPath;
			task.status = "success";
			task.states.logs.push(["success", "Import completed"]);
			new Notice(`Imported ${task.arxivId}`);
		} catch (error) {
			task.status = "error";
			task.error = getErrorMessage(error);
			task.states.logs.push(["error", task.error]);
			new Notice(`Import failed: ${task.error}`);
		} finally {
			window.clearInterval(refreshId);
			this.renderTasks();
		}
	}

	private renderTasks(): void {
		if (!this.taskListEl || !this.emptyEl) {
			return;
		}

		this.emptyEl.toggle(this.tasks.length === 0);
		this.taskListEl.empty();

		for (const task of this.tasks) {
			const taskEl = this.taskListEl.createDiv(
				`paper-importer-task paper-importer-task-${task.status}`
			);

			const headerEl = taskEl.createDiv("paper-importer-task-header");
			headerEl.createSpan({
				text: task.arxivId,
				cls: "paper-importer-task-title",
			});
			headerEl.createSpan({
				text: task.status,
				cls: "paper-importer-task-status",
			});

			taskEl.createDiv({
				text: task.downloadPdf ? "Metadata + PDF" : "Metadata only",
				cls: "paper-importer-task-mode",
			});

			if (task.status === "running" && task.downloadPdf) {
				const progress = Math.round(task.states.downloadProgress || 0);
				const progressEl = taskEl.createDiv(
					"paper-importer-task-progress"
				);
				progressEl.createDiv({
					cls: "paper-importer-task-progress-bar",
					attr: { style: `width: ${progress}%;` },
				});
			}

			const lastLog = task.states.logs[task.states.logs.length - 1];
			if (lastLog) {
				taskEl.createDiv({
					text: lastLog[1],
					cls: "paper-importer-task-log",
				});
			}

			if (task.notePath) {
				const openButtonEl = taskEl.createEl("button", {
					text: "Open note",
					cls: "paper-importer-task-open",
				});
				openButtonEl.addEventListener("click", async () => {
					await this.app.workspace.openLinkText(task.notePath!, "", true);
				});
			}
		}
	}
}
