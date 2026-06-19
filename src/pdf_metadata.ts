import { loadPdfJs } from "obsidian";

import { searchPaper, type Paper } from "./arxiv";

const PDF_TEXT_TIMEOUT_MS = 30000;
const MAX_METADATA_PAGES = 3;
const MAX_ABSTRACT_CHARS = 4000;

interface PdfTextItem {
	str: string;
	height?: number;
	transform?: number[];
}

interface PdfJsPage {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfJsMetadata {
	info?: Record<string, unknown>;
}

interface PdfJsDocument {
	numPages: number;
	getPage(page: number): Promise<PdfJsPage>;
	getMetadata?: () => Promise<PdfJsMetadata>;
	destroy?: () => void;
}

interface PageContent {
	/** Items joined on a single line with collapsed whitespace. */
	flatText: string;
	items: PdfTextItem[];
}

function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
	abortSignal?: AbortSignal
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new Error("PDF metadata extraction canceled."));
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
			reject(new Error("PDF metadata extraction canceled."));
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

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function itemFontSize(item: PdfTextItem): number {
	if (item.height && item.height > 0) {
		return item.height;
	}
	const transform = item.transform;
	if (transform && transform.length >= 4) {
		return Math.hypot(transform[2], transform[3]);
	}
	return 0;
}

function itemY(item: PdfTextItem): number {
	const transform = item.transform;
	if (transform && transform.length >= 6) {
		return transform[5];
	}
	return 0;
}

function looksLikeArxivId(value: string): boolean {
	return (
		/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(value) ||
		/^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i.test(value)
	);
}

/**
 * Find an arXiv identifier inside the raw PDF text. arXiv stamps a vertical
 * "arXiv:XXXX.XXXXX" watermark on the first page of every submission, so this is
 * a reliable way to recover the canonical metadata for arXiv papers.
 */
export function findArxivIdInText(text: string): string | null {
	const modernMatch = text.match(/arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i);
	if (modernMatch) {
		return `${modernMatch[1]}${modernMatch[2] ?? ""}`;
	}

	const legacyMatch = text.match(
		/arXiv:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i
	);
	if (legacyMatch) {
		return `${legacyMatch[1]}${legacyMatch[2] ?? ""}`;
	}

	return null;
}

/**
 * The title is usually the block of text with the largest font on the first
 * page. Group items into visual lines, find the largest font size, then join
 * the run of top lines rendered at (close to) that size.
 */
function extractTitleFromItems(items: PdfTextItem[]): string {
	const lines: Array<{ y: number; size: number; text: string }> = [];
	let current: { y: number; size: number; parts: string[] } | null = null;

	for (const item of items) {
		const text = item.str ?? "";
		if (!text.trim()) {
			continue;
		}
		const size = itemFontSize(item);
		const y = itemY(item);
		const tolerance = Math.max(size * 0.5, 1);

		if (current && Math.abs(y - current.y) <= tolerance) {
			current.parts.push(text);
			current.size = Math.max(current.size, size);
		} else {
			if (current) {
				lines.push({
					y: current.y,
					size: current.size,
					text: collapseWhitespace(current.parts.join(" ")),
				});
			}
			current = { y, size, parts: [text] };
		}
	}
	if (current) {
		lines.push({
			y: current.y,
			size: current.size,
			text: collapseWhitespace(current.parts.join(" ")),
		});
	}

	const titleCandidates = lines.filter(
		(line) => line.text.length >= 2 && /\p{L}/u.test(line.text)
	);
	if (titleCandidates.length === 0) {
		return "";
	}

	const maxSize = Math.max(...titleCandidates.map((line) => line.size));
	if (maxSize <= 0) {
		return "";
	}

	const sizeTolerance = maxSize * 0.1;
	const startIndex = titleCandidates.findIndex(
		(line) => maxSize - line.size <= sizeTolerance
	);
	if (startIndex < 0) {
		return "";
	}

	const titleParts: string[] = [];
	for (let index = startIndex; index < titleCandidates.length; index++) {
		const line = titleCandidates[index];
		if (maxSize - line.size > sizeTolerance) {
			break;
		}
		titleParts.push(line.text);
		// Titles rarely span more than a few lines.
		if (titleParts.length >= 4) {
			break;
		}
	}

	return collapseWhitespace(titleParts.join(" "));
}

/**
 * Pull the abstract out of the running text. Academic papers begin the abstract
 * with an "Abstract" heading and end it at "Introduction"/"Keywords"/etc.
 */
function extractAbstractFromText(text: string): string {
	const startMatch = text.match(/\bAbstract\b[\s:.—–-]*/i);
	if (!startMatch || startMatch.index === undefined) {
		return "";
	}

	const afterHeading = text.slice(startMatch.index + startMatch[0].length);
	const endMatch = afterHeading.match(
		/\s(?:\d+\s*\.?\s*)?Introduction\b|\bKeywords\b|\bKey words\b|\bIndex Terms\b|\bCCS Concepts\b/i
	);

	let abstract =
		endMatch && endMatch.index !== undefined
			? afterHeading.slice(0, endMatch.index)
			: afterHeading.slice(0, MAX_ABSTRACT_CHARS);

	abstract = collapseWhitespace(abstract);
	if (abstract.length < 20) {
		return "";
	}

	return abstract.slice(0, MAX_ABSTRACT_CHARS).trim();
}

function extractAuthorsFromText(titleText: string, pageText: string): string[] {
	const abstractMatch = pageText.match(/\bAbstract\b/i);
	if (!abstractMatch || abstractMatch.index === undefined) {
		return [];
	}

	let region = pageText.slice(0, abstractMatch.index);
	if (titleText) {
		const titleEnd = region.indexOf(titleText);
		if (titleEnd >= 0) {
			region = region.slice(titleEnd + titleText.length);
		}
	}

	region = collapseWhitespace(region);
	if (!region) {
		return [];
	}

	// Drop affiliation noise (emails, urls, digits) and split on common author
	// separators.
	const cleaned = region
		.replace(/\S+@\S+/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[•·∗*†‡§¶]/g, ",")
		.replace(/\s+and\s+/gi, ",");

	const candidates = cleaned
		.split(/[,;\n]/)
		.map((part) => collapseWhitespace(part))
		.filter((part) => {
			if (part.length < 3 || part.length > 60) {
				return false;
			}
			if (/\d/.test(part)) {
				return false;
			}
			// Expect at least two capitalized name tokens.
			const tokens = part.split(/\s+/).filter(Boolean);
			if (tokens.length < 2 || tokens.length > 5) {
				return false;
			}
			return tokens.every((token) => /^[\p{Lu}]/u.test(token));
		});

	return Array.from(new Set(candidates)).slice(0, 30);
}

function getInfoString(
	info: Record<string, unknown> | undefined,
	key: string
): string {
	if (!info) {
		return "";
	}
	const value = info[key];
	return typeof value === "string" ? value.trim() : "";
}

function isPlausibleTitle(title: string, fileName: string): boolean {
	if (title.length < 6) {
		return false;
	}
	if (!/\p{L}/u.test(title)) {
		return false;
	}
	const lower = title.toLowerCase();
	if (lower === "untitled" || lower === "title") {
		return false;
	}
	// Reject metadata that is just the file name or a path/temp string.
	const baseName = fileName.replace(/\.pdf$/i, "").trim().toLowerCase();
	if (baseName && lower === baseName) {
		return false;
	}
	if (/\.(?:pdf|tex|dvi|doc|docx)$/i.test(title) || /microsoft word/i.test(title)) {
		return false;
	}
	return true;
}

function parsePdfDate(value: string): string {
	// PDF dates look like D:YYYYMMDDHHmmSS±HH'mm'
	const match = value.match(
		/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/
	);
	if (!match) {
		return "";
	}
	const [, year, month = "01", day = "01", hour = "00", minute = "00"] = match;
	if (!year) {
		return "";
	}
	return `${year}-${month}-${day}T${hour}:${minute}:00Z`;
}

function fileNameToTitle(fileName: string): string {
	return collapseWhitespace(
		fileName
			.replace(/\.pdf$/i, "")
			.replace(/[_]+/g, " ")
	);
}

async function loadPages(
	bytes: Uint8Array,
	abortSignal?: AbortSignal
): Promise<{ pages: PageContent[]; info?: Record<string, unknown> }> {
	const pdfjsLib = await loadPdfJs();
	const loadingTask = pdfjsLib.getDocument({ data: bytes });
	const document = (await withTimeout(
		loadingTask.promise,
		PDF_TEXT_TIMEOUT_MS,
		"Timed out while loading PDF.",
		abortSignal
	)) as PdfJsDocument;

	try {
		let info: Record<string, unknown> | undefined;
		try {
			const metadata = await document.getMetadata?.();
			info = metadata?.info;
		} catch {
			info = undefined;
		}

		const pages: PageContent[] = [];
		const pageCount = Math.min(document.numPages, MAX_METADATA_PAGES);
		for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
			if (abortSignal?.aborted) {
				throw new Error("PDF metadata extraction canceled.");
			}
			const page = await withTimeout(
				document.getPage(pageNumber),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while reading PDF page.",
				abortSignal
			);
			const textContent = await withTimeout(
				page.getTextContent(),
				PDF_TEXT_TIMEOUT_MS,
				"Timed out while extracting PDF text.",
				abortSignal
			);
			const items = textContent.items as PdfTextItem[];
			const flatText = collapseWhitespace(
				items.map((item) => item.str ?? "").join(" ")
			);
			pages.push({ flatText, items });
		}

		return { pages, info };
	} finally {
		document.destroy?.();
	}
}

export interface PdfMetadataInput {
	bytes: Uint8Array;
	fileName: string;
	abortSignal?: AbortSignal;
	/** Optional callback for progress logging. */
	log?: (message: string) => void;
}

/**
 * Build a {@link Paper} from a PDF file. When the PDF carries an arXiv stamp the
 * canonical arXiv metadata is fetched so the result matches an arXiv import
 * exactly; otherwise the title, authors, abstract, and date are recovered
 * heuristically from the PDF text layer and document info dictionary.
 */
export async function extractPaperFromPdf(
	input: PdfMetadataInput
): Promise<Paper> {
	const { bytes, fileName, abortSignal, log } = input;
	const { pages, info } = await loadPages(bytes, abortSignal);

	const combinedText = pages.map((page) => page.flatText).join(" ");
	const firstPage = pages[0];

	const arxivId = findArxivIdInText(combinedText);
	if (arxivId) {
		try {
			log?.(`Detected arXiv ID ${arxivId} in PDF, fetching metadata...`);
			const paper = await searchPaper(arxivId);
			// Prefer the local file over a remote download for the note link.
			return { ...paper, pdfUrl: "" };
		} catch (error) {
			log?.(
				`arXiv lookup failed (${
					error instanceof Error ? error.message : String(error)
				}), using PDF text instead.`
			);
		}
	}

	const titleFromItems = firstPage
		? extractTitleFromItems(firstPage.items)
		: "";
	const titleFromInfo = getInfoString(info, "Title");

	let title = "";
	if (titleFromItems && titleFromItems.length >= 6) {
		title = titleFromItems;
	} else if (isPlausibleTitle(titleFromInfo, fileName)) {
		title = titleFromInfo;
	} else if (titleFromItems) {
		title = titleFromItems;
	} else {
		title = fileNameToTitle(fileName);
	}

	const abstract = extractAbstractFromText(combinedText) || "No abstract available";

	const authorsFromInfo = getInfoString(info, "Author");
	let authors = authorsFromInfo
		? authorsFromInfo
				.split(/[,;]|\sand\s/i)
				.map((author) => collapseWhitespace(author))
				.filter(Boolean)
		: [];
	if (authors.length === 0 && firstPage) {
		authors = extractAuthorsFromText(title, firstPage.flatText);
	}

	const creationDate = getInfoString(info, "CreationDate");
	const date = creationDate ? parsePdfDate(creationDate) : "";

	return {
		paperId: arxivId ?? "",
		title: title || fileNameToTitle(fileName),
		authors,
		date,
		abstract,
		comments: "",
		pdfUrl: "",
	};
}
