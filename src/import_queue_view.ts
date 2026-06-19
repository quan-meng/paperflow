import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";

import { ImportModal, parseImportSource } from "./import_modal.svelte";
import type { ImportSource } from "./import_modal.svelte";
import type PaperImporterPlugin from "./main";

export const IMPORT_QUEUE_VIEW_TYPE = "paper-importer-queue";

type ImportTaskStatus =
	| "queued"
	| "running"
	| "success"
	| "error"
	| "canceled";

interface ImportTask {
	id: number;
	input: string;
	source: ImportSource;
	downloadPdf: boolean;
	readWithClaude: boolean;
	readWithCodex: boolean;
	includePdfHighlights: boolean;
	status: ImportTaskStatus;
	states: Record<string, any>;
	notePath?: string;
	pdfPath?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	abortController?: AbortController;
}

interface TaskCardElements {
	rootEl: HTMLElement;
	titleEl: HTMLElement;
	statusEl: HTMLElement;
	cancelButtonEl?: HTMLButtonElement;
	modeEl: HTMLElement;
	progressLabelEl: HTMLElement;
	durationEl: HTMLElement;
	progressBarEl: HTMLElement;
	logsEl: HTMLElement;
	errorEl: HTMLElement;
	actionsEl: HTMLElement;
	logsSignature: string;
	hasOpenButton: boolean;
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
	private inputEl?: HTMLInputElement;
	private importButtonEl?: HTMLButtonElement;
	private pdfButtonEl?: HTMLButtonElement;
	private pdfFileInputEl?: HTMLInputElement;
	private downloadPdfEl?: HTMLInputElement;
	private readWithClaudeEl?: HTMLInputElement;
	private readWithCodexEl?: HTMLInputElement;
	private includePdfHighlightsEl?: HTMLInputElement;
	private taskListEl?: HTMLElement;
	private emptyEl?: HTMLElement;
	private taskElements = new Map<number, TaskCardElements>();

	constructor(leaf: WorkspaceLeaf, plugin: PaperImporterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return IMPORT_QUEUE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "PaperFlow";
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
		this.updateClaudeAvailability();
	}

	focusInput(): void {
		window.setTimeout(() => {
			this.inputEl?.focus();
		}, 0);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.taskElements.clear();
		contentEl.addClass("paper-importer-queue-view");

		contentEl.createEl("h4", { text: "PaperFlow" });

		const formEl = contentEl.createDiv("paper-importer-queue-form");
		this.inputEl = formEl.createEl("input", {
			type: "text",
			placeholder: "arXiv ID, URL, or PDF path",
		});
		this.inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.enqueueFromInput();
			}
		});

		this.importButtonEl = formEl.createEl("button", { text: "Import" });
		this.importButtonEl.addEventListener("click", () => {
			this.enqueueFromInput();
		});

		this.pdfButtonEl = formEl.createEl("button", { text: "Choose PDF" });
		this.pdfButtonEl.addEventListener("click", () => {
			this.pdfFileInputEl?.click();
		});

		this.pdfFileInputEl = formEl.createEl("input", {
			type: "file",
			attr: { accept: "application/pdf,.pdf" },
		});
		this.pdfFileInputEl.addClass("paper-importer-queue-file-input");
		this.pdfFileInputEl.style.display = "none";
		this.pdfFileInputEl.addEventListener("change", () => {
			void this.enqueueFromFile();
		});

		const optionsEl = contentEl.createDiv("paper-importer-queue-options");
		const labelEl = optionsEl.createEl("label");
		this.downloadPdfEl = labelEl.createEl("input", {
			type: "checkbox",
		});
		this.downloadPdfEl.checked = true;
		this.downloadPdfEl.addEventListener("change", () => {
			this.updateClaudeAvailability();
		});
		labelEl.appendText(" Download PDF");

		const claudeLabelEl = optionsEl.createEl("label");
		this.readWithClaudeEl = claudeLabelEl.createEl("input", {
			type: "checkbox",
		});
		this.readWithClaudeEl.checked = this.plugin.settings.readWithClaude;
		this.readWithClaudeEl.addEventListener("change", async () => {
			this.plugin.settings.readWithClaude =
				this.readWithClaudeEl?.checked ?? false;
			await this.plugin.saveSettings();
			this.updateClaudeAvailability();
		});
		claudeLabelEl.appendText(" Read with Claude");

		const codexLabelEl = optionsEl.createEl("label");
		this.readWithCodexEl = codexLabelEl.createEl("input", {
			type: "checkbox",
		});
		this.readWithCodexEl.checked = this.plugin.settings.readWithCodex;
		this.readWithCodexEl.addEventListener("change", async () => {
			this.plugin.settings.readWithCodex =
				this.readWithCodexEl?.checked ?? false;
			await this.plugin.saveSettings();
			this.updateClaudeAvailability();
		});
		codexLabelEl.appendText(" Read with Codex");

		const highlightsLabelEl = optionsEl.createEl("label");
		this.includePdfHighlightsEl = highlightsLabelEl.createEl("input", {
			type: "checkbox",
		});
		this.includePdfHighlightsEl.checked =
			this.plugin.settings.includePdfHighlights;
		this.includePdfHighlightsEl.addEventListener("change", async () => {
			this.plugin.settings.includePdfHighlights =
				this.includePdfHighlightsEl?.checked ?? false;
			await this.plugin.saveSettings();
		});
		highlightsLabelEl.appendText(" Include PDF++ highlights");

		this.updateClaudeAvailability();

		this.emptyEl = contentEl.createDiv("paper-importer-queue-empty");
		this.emptyEl.setText("Enter an arXiv ID or URL to import.");

		this.taskListEl = contentEl.createDiv("paper-importer-queue-list");
		this.renderTasks();
	}

	private enqueueFromInput(): void {
		const input = this.inputEl?.value.trim() || "";

		if (!input) {
			new Notice("Enter an arXiv ID, URL, or PDF path to import.");
			return;
		}

		let source: ImportSource;
		try {
			source = parseImportSource(input);
		} catch (error) {
			new Notice(getErrorMessage(error));
			return;
		}

		this.startImport(input, source);
	}

	private async enqueueFromFile(): Promise<void> {
		const fileInput = this.pdfFileInputEl;
		const file = fileInput?.files?.[0];
		if (!file) {
			return;
		}

		try {
			const bytes = await file.arrayBuffer();
			const source: ImportSource = {
				kind: "pdf",
				label: file.name,
				fileName: file.name,
				bytes,
			};
			this.startImport(file.name, source);
		} catch (error) {
			new Notice(getErrorMessage(error));
		} finally {
			// Reset so selecting the same file again re-triggers the change event.
			if (fileInput) {
				fileInput.value = "";
			}
		}
	}

	private updateClaudeAvailability(): void {
		if (
			!this.readWithClaudeEl ||
			!this.readWithCodexEl ||
			!this.includePdfHighlightsEl
		) {
			return;
		}

		const downloadPdf = this.downloadPdfEl?.checked ?? true;
		const hasReader =
			this.readWithClaudeEl.checked || this.readWithCodexEl.checked;
		this.readWithClaudeEl.disabled = !downloadPdf;
		this.readWithCodexEl.disabled = !downloadPdf;
		this.includePdfHighlightsEl.disabled = !downloadPdf || !hasReader;
		if (!downloadPdf) {
			this.readWithClaudeEl.checked = false;
			this.readWithCodexEl.checked = false;
			this.includePdfHighlightsEl.checked = false;
		}
	}

	private startImport(input: string, source: ImportSource): void {
		const downloadPdf = this.downloadPdfEl?.checked ?? true;
		const readWithClaude = this.readWithClaudeEl?.checked ?? false;
		const readWithCodex = this.readWithCodexEl?.checked ?? false;
		const includePdfHighlights =
			this.includePdfHighlightsEl?.checked ?? false;

		const task: ImportTask = {
			id: this.nextTaskId++,
			input,
			source,
			downloadPdf,
			readWithClaude,
			readWithCodex,
			includePdfHighlights,
			status: "queued",
			states: {
				logs: [["info", "Queued"]],
				downloadProgress: 0,
			},
		};

		this.tasks = [task];
		this.renderTasks();
		void this.runTask(task);

		if (this.inputEl) {
			this.inputEl.disabled = true;
		}
		if (this.importButtonEl) {
			this.importButtonEl.disabled = true;
		}
		if (this.pdfButtonEl) {
			this.pdfButtonEl.disabled = true;
		}
	}

	private async runTask(task: ImportTask): Promise<void> {
		task.status = "running";
		task.startedAt = Date.now();
		task.finishedAt = undefined;
		task.abortController = new AbortController();
		task.states.logs = [
			[
				"info",
				task.downloadPdf
					? "Importing metadata and PDF..."
					: "Importing metadata...",
			],
		];
		task.states.statusMessage = task.states.logs[0][1];
		task.states.downloadProgress = 0;
		this.renderTasks();

		const refreshId = window.setInterval(() => {
			this.renderTasks();
		}, 500);

		try {
			const runner = new ImportModal(
				this.app,
				{
					...this.plugin.settings,
					readWithClaude: task.readWithClaude,
					readWithCodex: task.readWithCodex,
					includePdfHighlights: task.includePdfHighlights,
				},
				task.downloadPdf
			);
			runner.states = task.states;
			runner.abortSignal = task.abortController.signal;

			const [notePath, pdfPath] = await runner.searchAndImportPaper(
				task.source
			);

			task.notePath = notePath;
			task.pdfPath = pdfPath;
			task.status = "success";
			task.finishedAt = Date.now();
			task.states.logs.push(["success", "Import completed"]);
			new Notice(`Imported ${task.source.label}`);
			await this.openNoteInThisTab(notePath);
		} catch (error) {
			task.finishedAt = Date.now();
			if (task.abortController.signal.aborted) {
				task.status = "canceled";
				task.states.logs.push(["warn", "Import canceled"]);
				new Notice(`Canceled ${task.source.label}`);
			} else {
				task.status = "error";
				task.error = getErrorMessage(error);
				task.states.logs.push(["error", task.error]);
				new Notice(`Import failed: ${task.error}`);
			}
		} finally {
			window.clearInterval(refreshId);
			task.abortController = undefined;
			if (task.status !== "success") {
				this.setFormEnabled(true);
			}
			this.renderTasks();
		}
	}

	private setFormEnabled(enabled: boolean): void {
		if (this.inputEl) {
			this.inputEl.disabled = !enabled;
		}
		if (this.importButtonEl) {
			this.importButtonEl.disabled = !enabled;
		}
		if (this.pdfButtonEl) {
			this.pdfButtonEl.disabled = !enabled;
		}
		if (this.downloadPdfEl) {
			this.downloadPdfEl.disabled = !enabled;
		}
		if (this.readWithClaudeEl) {
			this.readWithClaudeEl.disabled = !enabled;
		}
		if (this.readWithCodexEl) {
			this.readWithCodexEl.disabled = !enabled;
		}
		if (enabled) {
			this.updateClaudeAvailability();
		}
	}

	private renderTasks(): void {
		if (!this.taskListEl || !this.emptyEl) {
			return;
		}

		this.emptyEl.toggle(this.tasks.length === 0);

		const activeIds = new Set(this.tasks.map((task) => task.id));
		for (const [taskId, elements] of this.taskElements) {
			if (!activeIds.has(taskId)) {
				elements.rootEl.remove();
				this.taskElements.delete(taskId);
			}
		}

		for (const task of this.tasks) {
			let elements = this.taskElements.get(task.id);
			if (!elements) {
				elements = this.createTaskCard(task);
				this.taskElements.set(task.id, elements);
			}

			if (elements.rootEl.parentElement !== this.taskListEl) {
				this.taskListEl.appendChild(elements.rootEl);
			}

			this.updateTaskCard(task, elements);
		}
	}

	private createTaskCard(task: ImportTask): TaskCardElements {
		const rootEl = createDiv("paper-importer-task");
		const headerEl = rootEl.createDiv("paper-importer-task-header");
		const titleEl = headerEl.createSpan({
			text: task.source.label,
			cls: "paper-importer-task-title",
		});
		const statusEl = headerEl.createSpan({
			text: task.status,
			cls: "paper-importer-task-status",
		});
		const cancelButtonEl = headerEl.createEl("button", {
			text: "Cancel",
			cls: "paper-importer-task-cancel",
		});
		cancelButtonEl.addEventListener("click", () => {
			this.cancelTask(task);
		});

		const modeEl = rootEl.createDiv("paper-importer-task-mode");
		const progressMetaEl = rootEl.createDiv(
			"paper-importer-task-progress-meta"
		);
		const progressLabelEl = progressMetaEl.createSpan();
		const durationEl = progressMetaEl.createSpan({
			cls: "paper-importer-task-duration",
		});
		const progressEl = rootEl.createDiv("paper-importer-task-progress");
		const progressBarEl = progressEl.createDiv(
			"paper-importer-task-progress-bar"
		);
		const logsEl = rootEl.createDiv("paper-importer-task-logs");
		const errorEl = rootEl.createDiv("paper-importer-task-error-message");
		const actionsEl = rootEl.createDiv("paper-importer-task-actions");

		return {
			rootEl,
			titleEl,
			statusEl,
			cancelButtonEl,
			modeEl,
			progressLabelEl,
			durationEl,
			progressBarEl,
			logsEl,
			errorEl,
			actionsEl,
			logsSignature: "",
			hasOpenButton: false,
		};
	}

	private updateTaskCard(
		task: ImportTask,
		elements: TaskCardElements
	): void {
		elements.rootEl.className = `paper-importer-task paper-importer-task-${task.status}`;
		elements.titleEl.setText(task.source.label);
		elements.statusEl.setText(task.status);
		elements.cancelButtonEl?.toggle(
			task.status === "queued" || task.status === "running"
		);
		elements.modeEl.setText(this.getTaskMode(task));

		const progress = this.getTaskProgress(task);
		elements.progressLabelEl.setText(progress.label);
		elements.durationEl.setText(this.getTaskDuration(task));
		elements.progressBarEl.style.width = `${progress.percent}%`;

		this.updateTaskLogs(task, elements);

		elements.errorEl.setText(task.error || "");
		elements.errorEl.toggle(Boolean(task.error));

		if (task.notePath && !elements.hasOpenButton) {
			const openButtonEl = elements.actionsEl.createEl("button", {
				text: "Open note",
				cls: "paper-importer-task-open",
			});
			openButtonEl.addEventListener("click", async () => {
				await this.app.workspace.openLinkText(task.notePath!, "", true);
			});
			elements.hasOpenButton = true;
		}
	}

	private updateTaskLogs(
		task: ImportTask,
		elements: TaskCardElements
	): void {
		let logs = task.states.logs.slice(-5);
		const statusMessage = String(task.states.statusMessage || "").trim();
		const lastLog = logs[logs.length - 1];
		if (
			task.status === "running" &&
			statusMessage &&
			(!lastLog || lastLog[1] !== statusMessage)
		) {
			logs = [...logs.slice(-4), ["info", statusMessage]];
		}
		const signature = JSON.stringify(logs);
		if (signature === elements.logsSignature) {
			return;
		}

		elements.logsSignature = signature;
		elements.logsEl.empty();
		elements.logsEl.toggle(logs.length > 0);
		for (const [level, message] of logs) {
			const logEl = elements.logsEl.createDiv(
				`paper-importer-task-log paper-importer-task-log-${level}`
			);
			logEl.createSpan({
				text: level,
				cls: "paper-importer-task-log-level",
			});
			logEl.createSpan({
				text: message,
				cls: "paper-importer-task-log-message",
			});
		}
	}

	private getTaskProgress(task: ImportTask): {
		percent: number;
		label: string;
	} {
		if (task.status === "queued") {
			return { percent: 0, label: "Ready to import" };
		}

		if (task.status === "success") {
			return { percent: 100, label: "Complete" };
		}

		if (task.status === "error") {
			return {
				percent: Math.max(this.getRunningProgress(task).percent, 3),
				label: "Failed",
			};
		}

		if (task.status === "canceled") {
			return { percent: 100, label: "Canceled" };
		}

		return this.getRunningProgress(task);
	}

	private getRunningProgress(task: ImportTask): {
		percent: number;
		label: string;
	} {
		const logs: string[] = task.states.logs
			.map((log: [string, string]) => String(log[1]))
			.reverse();
		const currentMessage =
			String(task.states.statusMessage || "").trim() ||
			logs[0] ||
			"Running...";
		const downloadProgress = Math.round(task.states.downloadProgress || 0);

		if (logs.some((message) => message.includes("Reading PDF with Codex"))) {
			return { percent: 92, label: "Reading PDF with Codex..." };
		}

		if (
			logs.some((message) =>
				message.includes("Codex reading appended to note")
			)
		) {
			return { percent: 97, label: "Codex reading appended" };
		}

		if (
			logs.some((message) => message.includes("Reading PDF with Claude"))
		) {
			return { percent: 90, label: "Reading PDF with Claude..." };
		}

		if (
			logs.some((message) =>
				message.includes("Claude reading appended to note")
			)
		) {
			return { percent: 94, label: "Claude reading appended" };
		}

		if (logs.some((message) => message.includes("Note created"))) {
			return { percent: 85, label: "Note created" };
		}

		if (logs.some((message) => message.includes("Note already exists"))) {
			return { percent: 85, label: "Note already exists" };
		}

		if (logs.some((message) => message.includes("Using default template"))) {
			return { percent: 80, label: "Creating note..." };
		}

		if (logs.some((message) => message.includes("PDF downloaded"))) {
			return { percent: 75, label: "PDF downloaded" };
		}

		if (logs.some((message) => message.includes("PDF already exists"))) {
			return { percent: 75, label: "PDF already exists" };
		}

		if (logs.some((message) => message.includes("Starting PDF download"))) {
			const percent = Math.min(
				75,
				Math.max(25, 25 + Math.round(downloadProgress * 0.5))
			);
			const label =
				downloadProgress > 0
					? `Downloading PDF ${downloadProgress}%`
					: "Starting PDF download...";
			return { percent, label };
		}

		if (logs.some((message) => message.includes("Found paper"))) {
			return { percent: 20, label: "Metadata fetched" };
		}

		if (
			logs.some((message) => message.includes("Fetching metadata"))
		) {
			return { percent: 8, label: "Fetching metadata..." };
		}

		return { percent: 5, label: currentMessage };
	}

	private async openNoteInThisTab(notePath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await this.leaf.openFile(file);
			return;
		}

		await this.app.workspace.openLinkText(notePath, "", false);
	}

	private getTaskDuration(task: ImportTask): string {
		if (!task.startedAt) {
			return "";
		}

		const end = task.finishedAt || Date.now();
		const totalSeconds = Math.max(
			0,
			Math.floor((end - task.startedAt) / 1000)
		);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		if (minutes > 0) {
			return `${minutes}m ${seconds}s`;
		}

		return `${seconds}s`;
	}

	private cancelTask(task: ImportTask): void {
		if (task.status === "queued") {
			task.status = "canceled";
			task.finishedAt = Date.now();
			task.states.logs.push(["warn", "Import canceled"]);
			this.renderTasks();
			return;
		}

		if (task.status === "running") {
			task.abortController?.abort();
			task.states.logs.push(["warn", "Cancel requested..."]);
			this.renderTasks();
		}
	}

	private getTaskMode(task: ImportTask): string {
		const parts = ["Metadata"];
		if (task.downloadPdf) {
			parts.push("PDF");
		}
		if (task.readWithClaude) {
			parts.push("Claude");
		}
		if (task.readWithCodex) {
			parts.push("Codex");
		}
		if (task.includePdfHighlights) {
			parts.push("PDF++");
		}

		return parts.join(" + ");
	}
}
