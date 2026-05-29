import { Plugin } from "obsidian";
import {
	IMPORT_QUEUE_VIEW_TYPE,
	ImportQueueView,
} from "./import_queue_view";
import {
	DEFAULT_SETTINGS,
	DEFAULT_HIGHLIGHT_CATEGORIES,
	type PaperImporterPluginSettings,
	PaperImporterSettingTab,
} from "./setting_tab";

export default class PaperImporterPlugin extends Plugin {
	settings: PaperImporterPluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			IMPORT_QUEUE_VIEW_TYPE,
			(leaf) => new ImportQueueView(leaf, this)
		);

		// This adds a command to import metadata and download PDF from arXiv
		this.addCommand({
			id: "import_pdf_from_arxiv",
			name: "Import metadata and PDF from arXiv",
			callback: async () => {
				await this.activateQueueView(true);
			},
		});

		// This adds a command to import only metadata without downloading PDF
		this.addCommand({
			id: "import_metadata_from_arxiv",
			name: "Import metadata only from arXiv",
			callback: async () => {
				await this.activateQueueView(false);
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new PaperImporterSettingTab(this.app, this));
	}

	onunload() {}

	async activateQueueView(downloadPdf: boolean) {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: IMPORT_QUEUE_VIEW_TYPE,
			active: true,
		});

		await leaf.loadIfDeferred();
		this.app.workspace.setActiveLeaf(leaf, { focus: true });

		if (leaf.view instanceof ImportQueueView) {
			leaf.view.setDownloadPdf(downloadPdf);
			leaf.view.focusInput();
		}
	}

	async loadSettings() {
		const savedSettings = (await this.loadData()) || {};
		const legacyPrompt =
			savedSettings.readingPrompt ||
			savedSettings.claudeReadingPrompt ||
			savedSettings.codexReadingPrompt;
		const legacyHighlightCategories =
			savedSettings.highlightCategories ||
			[
				{
					name: "Key Points",
					color: savedSettings.highlightColorKeyPoints || "#bb61e5",
				},
				{
					name: "Method",
					color: savedSettings.highlightColorMethod || "#086ddd",
				},
				{
					name: "Results",
					color: savedSettings.highlightColorResults || "#ea5252",
				},
				{
					name: "Details",
					color: savedSettings.highlightColorDetails || "#ffd000",
				},
			];

		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			savedSettings,
			{
				highlightCategories: Array.isArray(legacyHighlightCategories)
					? legacyHighlightCategories
					: DEFAULT_HIGHLIGHT_CATEGORIES.map((category) => ({
							...category,
						})),
			},
			legacyPrompt ? { readingPrompt: legacyPrompt } : {}
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
