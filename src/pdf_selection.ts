import { loadPdfJs, normalizePath } from "obsidian";
import type { HighlightCategory } from "./setting_tab";

const PDF_TEXT_TIMEOUT_MS = 30000;

interface TextPosition {
	itemIndex: number;
	offset: number;
}

interface PageTextIndex {
	normalized: string;
	positions: TextPosition[];
}

interface TextContentItem {
	str: string;
}

interface PdfJsDocument {
	getPage(page: number): Promise<PdfJsPage>;
	destroy?: () => void;
}

interface PdfJsPage {
	getTextContent(): Promise<{ items: TextContentItem[] }>;
}

interface VaultAdapterLike {
	readBinary(path: string): Promise<ArrayBuffer>;
}

interface AppLike {
	vault: {
		adapter: VaultAdapterLike;
	};
}

export interface PdfCalloutCategoryConfig {
	categories: HighlightCategory[];
}

function normalizeCharacter(character: string): string {
	return character
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeText(text: string): string {
	return Array.from(text)
		.map(normalizeCharacter)
		.join("");
}

function buildPdfJsPageIndex(items: TextContentItem[]): PageTextIndex {
	let normalized = "";
	const positions: TextPosition[] = [];

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const item = items[itemIndex];
		const text = item.str || "";
		for (let offset = 0; offset < text.length; offset++) {
			const normalizedCharacter = normalizeCharacter(text[offset]);
			if (!normalizedCharacter) {
				continue;
			}

			normalized += normalizedCharacter;
			positions.push({ itemIndex, offset });
		}
	}

	return { normalized, positions };
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
	abortSignal?: AbortSignal
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("PDF text extraction canceled."));
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
			reject(new Error("PDF text extraction canceled."));
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

async function readPdfBytes(
	app: AppLike,
	pdfVaultPath: string
): Promise<Uint8Array> {
	const data = await app.vault.adapter.readBinary(
		normalizePath(pdfVaultPath)
	);
	return new Uint8Array(data);
}

async function extractPageTextIndex(
	app: AppLike,
	pdfVaultPath: string,
	page: number,
	abortSignal?: AbortSignal
): Promise<PageTextIndex | null> {
	try {
		const pdfjsLib = await loadPdfJs();
		const bytes = await readPdfBytes(app, pdfVaultPath);
		const loadingTask = pdfjsLib.getDocument({ data: bytes });
		const document = (await withTimeout(
			loadingTask.promise,
			PDF_TEXT_TIMEOUT_MS,
			"Timed out while loading PDF text layer.",
			abortSignal
		)) as PdfJsDocument;

		try {
			const pdfPage = await withTimeout(
				document.getPage(page),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while loading PDF page text layer.",
				abortSignal
			);
			const textContent = await withTimeout(
				pdfPage.getTextContent(),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while extracting PDF page text layer.",
				abortSignal
			);
			return buildPdfJsPageIndex(textContent.items as TextContentItem[]);
		} finally {
			document.destroy?.();
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes("canceled")) {
			throw error;
		}

		console.warn(
			`PaperFlow: skipped PDF++ selection extraction for page ${page}: ${error instanceof Error ? error.message : String(error)}`
		);
		return null;
	}
}

function findSelection(
	pageIndex: PageTextIndex,
	quote: string
): string | null {
	const normalizedQuote = normalizeText(quote);
	if (!normalizedQuote) {
		return null;
	}

	const start = pageIndex.normalized.indexOf(normalizedQuote);
	if (start < 0) {
		return null;
	}

	const nextStart = pageIndex.normalized.indexOf(
		normalizedQuote,
		start + normalizedQuote.length
	);
	if (nextStart >= 0) {
		return null;
	}

	const end = start + normalizedQuote.length - 1;
	const startPosition = pageIndex.positions[start];
	const endPosition = pageIndex.positions[end];
	if (!startPosition || !endPosition) {
		return null;
	}

	return `${startPosition.itemIndex},${startPosition.offset},${endPosition.itemIndex},${endPosition.offset + 1}`;
}

function normalizeHeading(text: string): string {
	return text
		.replace(/^#+\s*/, "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function hexToPdfColor(color: string): string | null {
	const match = color.trim().match(/^#?([0-9a-f]{6})$/i);
	if (!match) {
		return null;
	}

	const hex = match[1];
	const red = parseInt(hex.slice(0, 2), 16);
	const green = parseInt(hex.slice(2, 4), 16);
	const blue = parseInt(hex.slice(4, 6), 16);

	return `${red},${green},${blue}`;
}

function replaceCalloutColor(line: string, color: string): string {
	const updatedCallout = line.replace(/\[!PDF\|[^\]]+\]/, `[!PDF|${color}]`);
	if (updatedCallout === line) {
		return line;
	}

	return updatedCallout.replace(/([#&])color=[^&|\]]+/i, `$1color=${color}`);
}

export function applyPdfCalloutCategoryColors(
	markdown: string,
	config: PdfCalloutCategoryConfig
): string {
	const colorByHeading = new Map<string, string>();
	for (const category of config.categories) {
		const name = normalizeHeading(category.name);
		const color = hexToPdfColor(category.color);
		if (name && color) {
			colorByHeading.set(name, color);
		}
	}

	let currentColor: string | null = null;

	return markdown
		.split("\n")
		.map((line) => {
			if (/^#{1,6}\s+/.test(line)) {
				const color = colorByHeading.get(normalizeHeading(line));
				if (color) {
					currentColor = color;
				} else if (/^#{1,3}\s+/.test(line)) {
					currentColor = null;
				}
			}

			if (currentColor && /^\s*>\s*\[!PDF\|/.test(line)) {
				return replaceCalloutColor(line, currentColor);
			}

			return line;
		})
		.join("\n");
}

export async function addPdfSelectionsToCallouts(
	markdown: string,
	app: AppLike,
	pdfVaultPath: string,
	abortSignal?: AbortSignal
): Promise<string> {
	const calloutPattern =
		/(>\s*\[!PDF\|[^\]]+\]\s*\[\[[^\]#]+#page=(\d+)&)(?![^|\]]*selection=)([^|\]]*)(\|[^\]]+\]\]\n>\s*>\s*)([^\n]+)/g;
	const pageCache = new Map<number, PageTextIndex | null>();
	let result = markdown;
	const replacements: Array<[string, string]> = [];

	for (const match of markdown.matchAll(calloutPattern)) {
		const [fullMatch, prefix, pageText, params, quotePrefix, quote] = match;
		const page = Number(pageText);
		if (!Number.isFinite(page)) {
			continue;
		}

		if (!pageCache.has(page)) {
			pageCache.set(
				page,
				await extractPageTextIndex(app, pdfVaultPath, page, abortSignal)
			);
		}

		const pageIndex = pageCache.get(page);
		if (!pageIndex) {
			continue;
		}

		const selection = findSelection(pageIndex, quote);
		if (!selection) {
			continue;
		}

		const nextParams = params.startsWith("color=")
			? `selection=${selection}&${params}`
			: `${params}&selection=${selection}`;
		replacements.push([
			fullMatch,
			`${prefix}${nextParams}${quotePrefix}${quote}`,
		]);
	}

	for (const [from, to] of replacements) {
		result = result.replace(from, to);
	}

	return result;
}
