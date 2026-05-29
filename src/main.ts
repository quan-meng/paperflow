import { Plugin } from "obsidian";
import {
	IMPORT_QUEUE_VIEW_TYPE,
	ImportQueueView,
} from "./import_queue_view";
import {
	DEFAULT_SETTINGS,
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
		let leaf = this.app.workspace.getLeavesOfType(
			IMPORT_QUEUE_VIEW_TYPE
		)[0];

		if (!leaf) {
			leaf = await this.app.workspace.ensureSideLeaf(
				IMPORT_QUEUE_VIEW_TYPE,
				"right",
				{ active: true, reveal: true }
			);
		}

		await leaf.loadIfDeferred();
		await this.app.workspace.revealLeaf(leaf);

		if (leaf.view instanceof ImportQueueView) {
			leaf.view.setDownloadPdf(downloadPdf);
			leaf.view.focusInput();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
