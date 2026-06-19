import {
	App,
	ButtonComponent,
	Notice,
	PluginSettingTab,
	Setting,
	normalizePath,
} from "obsidian";
import { DEFAULT_TEMPLATE } from "./default_template";
import PaperImporterPlugin from "./main";

const READING_PROMPT_PLACEHOLDERS = [
	"reader",
	"pdf_full_path",
	"pdf_vault_path",
	"pdf_name",
	"pdf_title",
	"title",
	"paper_id",
	"authors",
	"abstract",
	"pdf_text",
	"highlight_categories",
];

export interface HighlightCategory {
	name: string;
	color: string;
}

export const DEFAULT_HIGHLIGHT_CATEGORIES: HighlightCategory[] = [
	{ name: "Key Points", color: "#bb61e5" },
	{ name: "Method", color: "#086ddd" },
	{ name: "Results", color: "#ea5252" },
	{ name: "Details", color: "#ffd000" },
];

export function formatHighlightCategoriesForPrompt(
	categories: HighlightCategory[]
): string {
	return categories
		.filter((category) => category.name.trim())
		.map((category) => `  - #### ${category.name.trim()}`)
		.join("\n");
}

export const DEFAULT_READING_PROMPT = `Read this research paper PDF and produce a concise Obsidian markdown note section.

PDF path: {{ pdf_full_path }}

Paper metadata:
- Title: {{ title }}
- arXiv ID: {{ paper_id }}
- Authors: {{ authors }}
- Abstract: {{ abstract }}

Requirements:
- Keep the whole output short and high-signal.
- Include exactly these top-level headings:
  - ## Claude Reading
  - ### Idea
  - ### Method
  - ### Limitations
  - ### Future Work
  - ### Key Sentences
- Under Idea, Method, Limitations, and Future Work, write 2-4 bullets each.
- Under Key Sentences, include 3-6 important sentences from the PDF.
- Group Key Sentences under these fourth-level headings when possible:
{{ highlight_categories }}
- Format each key sentence as a PDF++-style callout like this:
  > [!PDF|yellow] [[{{ pdf_name }}#page=PAGE&color=yellow|{{ pdf_title }}, p.PAGE]]
  > > exact quoted sentence
- Use the page number where the sentence appears.
- Do not invent selection coordinates.
- Do not wrap the output in a code fence.
- Return only the markdown section.`;

export class PaperImporterSettingTab extends PluginSettingTab {
	plugin: PaperImporterPlugin;

	constructor(app: App, plugin: PaperImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("PDF folder")
			.setDesc("Folder to save imported PDFs")
			.addText((text) =>
				text
					.setPlaceholder("Example: Assets")
					.setValue(this.plugin.settings.pdfFolder)
					.onChange(async (value) => {
						this.plugin.settings.pdfFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Note folder")
			.setDesc("Folder to save auto-generated notes for imported PDFs")
			.addText((text) =>
				text
					.setPlaceholder("Example: Notes")
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom template file")
			.setDesc(
				"Path to a custom template file (relative to vault root or absolute path). Leave empty to use the default template."
			)
			.addText((text) =>
				text
					.setPlaceholder("Example: Templates/note_template.md")
					.setValue(this.plugin.settings.templateFilePath)
					.onChange(async (value) => {
						this.plugin.settings.templateFilePath = value;
						await this.plugin.saveSettings();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("Create template file")
					.setTooltip(
						"Create a template file with the default template content"
					)
					.onClick(async () => {
						await this.createTemplateFile();
					})
			);

		new Setting(containerEl)
			.setName("Read with Claude")
			.setDesc(
				"After downloading a PDF, use your local Claude Code subscription to append a short reading note with idea, limitations, future work, and PDF++-style key-sentence callouts."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.readWithClaude)
					.onChange(async (value) => {
						this.plugin.settings.readWithClaude = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Claude command")
			.setDesc(
				"Optional path to the Claude Code CLI. Leave empty to try claude, ~/.local/bin/claude, Homebrew, and /usr/local/bin locations."
			)
			.addText((text) =>
				text
					.setPlaceholder("Example: /Users/mq/.local/bin/claude")
					.setValue(this.plugin.settings.claudeCommand)
					.onChange(async (value) => {
						this.plugin.settings.claudeCommand = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Read with Codex")
			.setDesc(
				"After downloading a PDF, use your local Codex CLI to append a short reading note with idea, limitations, future work, and PDF++-style key-sentence callouts."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.readWithCodex)
					.onChange(async (value) => {
						this.plugin.settings.readWithCodex = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Codex command")
			.setDesc(
				"Optional path to the Codex CLI. Leave empty to try codex, Homebrew, and /usr/local/bin locations."
			)
			.addText((text) =>
				text
					.setPlaceholder("Example: /opt/homebrew/bin/codex")
					.setValue(this.plugin.settings.codexCommand)
					.onChange(async (value) => {
						this.plugin.settings.codexCommand = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include PDF++ highlights")
			.setDesc(
				"When AI reading is enabled, format key sentences as PDF++ callouts with exact-match text-layer selection ranges."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includePdfHighlights)
					.onChange(async (value) => {
						this.plugin.settings.includePdfHighlights = value;
						await this.plugin.saveSettings();
					})
			);

		this.displayHighlightColorSettings(containerEl);

		this.displayReadingPromptEditor(containerEl);
	}

	private displayHighlightColorSettings(containerEl: HTMLElement): void {
		const sectionEl = containerEl.createDiv(
			"paper-importer-highlight-setting"
		);
		new Setting(sectionEl)
			.setName("PDF++ highlight concepts")
			.setDesc(
				"Add the concepts you want Claude or Codex to use under Key Sentences. Colors are stored as hex and converted to PDF++ highlight colors."
			)
			.setHeading()
			.addButton((button) =>
				button.setButtonText("Add concept").onClick(async () => {
					this.plugin.settings.highlightCategories.push({
						name: "New Concept",
						color: "#ffd000",
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);

		const listEl = sectionEl.createDiv("paper-importer-highlight-list");
		for (const [index, category] of this.plugin.settings.highlightCategories.entries()) {
			this.createHighlightCategoryRow(listEl, category, index);
		}
	}

	private createHighlightCategoryRow(
		containerEl: HTMLElement,
		category: HighlightCategory,
		index: number
	): void {
		const rowEl = containerEl.createDiv("paper-importer-highlight-row");
		const nameEl = rowEl.createEl("input", {
			type: "text",
			placeholder: "Concept name",
			cls: "paper-importer-highlight-name",
		});
		nameEl.value = category.name;

		const colorWrapEl = rowEl.createDiv("paper-importer-highlight-color");
		const colorPickerEl = colorWrapEl.createEl("input", {
			type: "color",
			cls: "paper-importer-highlight-picker",
		});
		const colorTextEl = colorWrapEl.createEl("input", {
			type: "text",
			placeholder: "#ffd000",
			cls: "paper-importer-highlight-hex",
		});
		const initialColor = this.normalizeHexColor(category.color, "#ffd000");
		colorPickerEl.value = initialColor;
		colorTextEl.value = initialColor;

		const removeButtonEl = rowEl.createEl("button", {
			text: "Remove",
			cls: "paper-importer-highlight-remove",
		});
		removeButtonEl.disabled =
			this.plugin.settings.highlightCategories.length <= 1;

		const save = async () => {
			this.plugin.settings.highlightCategories[index] = {
				name: nameEl.value.trim() || "Untitled",
				color: this.normalizeHexColor(colorTextEl.value, "#ffd000"),
			};
			await this.plugin.saveSettings();
		};

		nameEl.addEventListener("input", () => {
			void save();
		});

		colorPickerEl.addEventListener("input", async () => {
			colorTextEl.value = colorPickerEl.value;
			await save();
		});

		colorTextEl.addEventListener("input", async () => {
			const normalized = this.normalizeHexColor(colorTextEl.value, "");
			if (normalized) {
				colorPickerEl.value = normalized;
				await save();
			}
		});

		colorTextEl.addEventListener("blur", async () => {
			const normalized = this.normalizeHexColor(
				colorTextEl.value,
				colorPickerEl.value
			);
			colorTextEl.value = normalized;
			colorPickerEl.value = normalized;
			await save();
		});

		removeButtonEl.addEventListener("click", async () => {
			this.plugin.settings.highlightCategories.splice(index, 1);
			await this.plugin.saveSettings();
			this.display();
		});
	}

	private normalizeHexColor(value: string, fallback: string): string {
		const trimmed = value.trim();
		if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
			return trimmed.toLowerCase();
		}

		if (/^[0-9a-f]{6}$/i.test(trimmed)) {
			return `#${trimmed.toLowerCase()}`;
		}

		return fallback;
	}

	private displayReadingPromptEditor(containerEl: HTMLElement): void {
		const sectionEl = containerEl.createDiv(
			"paper-importer-prompt-setting"
		);
		let resetButton!: ButtonComponent;
		new Setting(sectionEl)
			.setName("Reading prompt")
			.setDesc("Shared prompt template for Claude and Codex PDF reading.")
			.setHeading()
			.addButton((button) => {
				resetButton = button.setButtonText("Reset to default");
			});

		const toolbarEl = sectionEl.createDiv("paper-importer-prompt-toolbar");
		toolbarEl.createSpan({
			text: "Insert:",
			cls: "paper-importer-prompt-toolbar-label",
		});

		const textareaEl = sectionEl.createEl("textarea", {
			cls: "paper-importer-prompt-textarea",
		});
		textareaEl.rows = 24;
		textareaEl.value = this.plugin.settings.readingPrompt;

		const savePrompt = async () => {
			this.plugin.settings.readingPrompt = textareaEl.value;
			await this.plugin.saveSettings();
		};

		textareaEl.addEventListener("input", () => {
			void savePrompt();
		});

		resetButton.onClick(async () => {
			textareaEl.value = DEFAULT_READING_PROMPT;
			await savePrompt();
			new Notice("Reading prompt reset to default.");
		});

		for (const placeholder of READING_PROMPT_PLACEHOLDERS) {
			const buttonEl = toolbarEl.createEl("button", {
				text: `{{ ${placeholder} }}`,
				cls: "paper-importer-placeholder-button",
			});
			buttonEl.addEventListener("click", async () => {
				this.insertAtCursor(textareaEl, `{{ ${placeholder} }}`);
				await savePrompt();
				textareaEl.focus();
			});
		}

		const helpEl = sectionEl.createDiv("paper-importer-prompt-help");
		helpEl.createEl("strong", { text: "Placeholders" });
		const listEl = helpEl.createEl("ul");
		for (const placeholder of READING_PROMPT_PLACEHOLDERS) {
			listEl.createEl("li", { text: `{{ ${placeholder} }}` });
		}
	}

	private insertAtCursor(textareaEl: HTMLTextAreaElement, text: string): void {
		const start = textareaEl.selectionStart;
		const end = textareaEl.selectionEnd;
		textareaEl.value =
			textareaEl.value.slice(0, start) +
			text +
			textareaEl.value.slice(end);
		const cursor = start + text.length;
		textareaEl.selectionStart = cursor;
		textareaEl.selectionEnd = cursor;
		textareaEl.dispatchEvent(new Event("input"));
	}

	async createTemplateFile(): Promise<void> {
		try {
			if (!this.plugin.settings.templateFilePath.trim()) {
				new Notice("Please specify a template file path first!");
				return;
			}

			const templatePath = normalizePath(
				this.plugin.settings.templateFilePath
			);

			// Check if file already exists
			const exists = await this.app.vault.adapter.exists(templatePath);
			if (exists) {
				new Notice("Template file already exists!");
				return;
			}

			// Extract the directory path from the template file path
			const lastSlashIndex = templatePath.lastIndexOf("/");
			if (lastSlashIndex > 0) {
				const folderPath = templatePath.substring(0, lastSlashIndex);

				// Check if the folder exists, create it if it doesn't
				const folderExists = await this.app.vault.adapter.exists(
					folderPath
				);
				if (!folderExists) {
					await this.app.vault.createFolder(folderPath);
					new Notice(`Created folder: ${folderPath}`);
				}
			}

			// Create the file with default template content
			await this.app.vault.adapter.write(templatePath, DEFAULT_TEMPLATE);
			new Notice(`Template file created: ${templatePath}`);
		} catch (error) {
			new Notice(`Failed to create template file: ${error.message}`);
		}
	}
}
// Remember to rename these classes and interfaces!
export interface PaperImporterPluginSettings {
	pdfFolder: string;
	noteFolder: string;
	templateFilePath: string;
	readWithClaude: boolean;
	claudeCommand: string;
	readWithCodex: boolean;
	codexCommand: string;
	includePdfHighlights: boolean;
	highlightCategories: HighlightCategory[];
	readingPrompt: string;
}
export const DEFAULT_SETTINGS: PaperImporterPluginSettings = {
	pdfFolder: "Raw",
	noteFolder: "Raw",
	templateFilePath: "",
	readWithClaude: false,
	claudeCommand: "",
	readWithCodex: false,
	codexCommand: "",
	includePdfHighlights: false,
	highlightCategories: DEFAULT_HIGHLIGHT_CATEGORIES,
	readingPrompt: DEFAULT_READING_PROMPT,
};
