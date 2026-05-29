import { requestUrl } from "obsidian";

const ARXIV_ABS_TIMEOUT_MS = 15000;
const ARXIV_API_TIMEOUT_MS = 15000;

export interface Paper {
	paperId: string;
	title: string;
	authors: string[];
	date: string;
	abstract: string;
	comments: string;
	pdfUrl: string;
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
	});

	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

function getNamespacedText(
	entry: Element,
	namespace: string,
	tagName: string
): string {
	return (
		entry.getElementsByTagNameNS(namespace, tagName)[0]?.textContent?.trim() ||
		""
	);
}

function getMetaContent(document: Document, selector: string): string {
	return document.querySelector(selector)?.getAttribute("content")?.trim() || "";
}

function getVersionedPaperIdFromAbsPage(
	document: Document,
	arxivId: string
): string {
	const ogUrl = getMetaContent(document, "meta[property='og:url']");
	const ogPaperId = ogUrl.split("/abs/").pop()?.trim();
	if (ogPaperId) {
		return ogPaperId;
	}

	return arxivId;
}

function getCommentsFromAbsPage(document: Document): string {
	const tableRows = Array.from(document.querySelectorAll(".metatable tr"));
	const commentsRow = tableRows.find((row) =>
		row
			.querySelector(".label")
			?.textContent?.trim()
			.toLowerCase()
			.startsWith("comments")
	);

	return (
		commentsRow?.querySelector(".tablecell:not(.label)")?.textContent?.trim() ||
		""
	);
}

async function searchPaperFromAbsPage(arxivId: string): Promise<Paper> {
	const url = `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
	const response = await withTimeout(
		requestUrl({ url }),
		ARXIV_ABS_TIMEOUT_MS,
		"Timed out while fetching metadata from the arXiv abstract page."
	);

	const parser = new DOMParser();
	const document = parser.parseFromString(response.text, "text/html");

	const title = getMetaContent(document, "meta[name='citation_title']");
	if (!title) {
		throw new Error("No arXiv metadata was found on the abstract page.");
	}

	const authors = Array.from(
		document.querySelectorAll("meta[name='citation_author']")
	)
		.map((author) => author.getAttribute("content")?.trim() || "")
		.filter(Boolean);

	const date = getMetaContent(document, "meta[name='citation_date']");
	const abstract =
		getMetaContent(document, "meta[name='citation_abstract']") ||
		getMetaContent(document, "meta[property='og:description']") ||
		"No abstract available";
	const paperId = getVersionedPaperIdFromAbsPage(document, arxivId);
	const pdfUrl =
		getMetaContent(document, "meta[name='citation_pdf_url']")
			.replace(/^http:\/\//i, "https://")
			.replace(/\/pdf\/([^v]+)$/i, `/pdf/${paperId}`) ||
		`https://arxiv.org/pdf/${paperId}`;

	return {
		paperId,
		title,
		authors,
		date,
		abstract,
		comments: getCommentsFromAbsPage(document),
		pdfUrl,
	};
}

async function searchPaperFromApi(arxivId: string): Promise<Paper> {
	const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;

	const response = await withTimeout(
		requestUrl({ url }),
		ARXIV_API_TIMEOUT_MS,
		"Timed out while fetching metadata from the arXiv API."
	);
	const parser = new DOMParser();
	const xml = parser.parseFromString(response.text, "text/xml");

	const entry = xml.querySelector("entry");

	if (!entry) {
		throw new Error("No arXiv entry was returned for this paper.");
	}

	const title = entry.querySelector("title")?.textContent?.trim();

	if (!title || title === "Error") {
		const message =
			entry.querySelector("summary")?.textContent?.trim() ||
			"Unknown error";
		throw new Error(message);
	}

	const authors = Array.from(entry.querySelectorAll("author")).map(
		(author) => {
			const name =
				author.querySelector("name")?.textContent?.trim() ||
				"Unknown author";
			return name;
		}
	);

	const date = entry.querySelector("published")?.textContent?.trim() || "";

	const abstract =
		entry.querySelector("summary")?.textContent?.trim() ||
		"No abstract available";

	const comments =
		getNamespacedText(entry, "http://arxiv.org/schemas/atom", "comment") ||
		entry.getElementsByTagName("arxiv:comment")[0]?.textContent?.trim() ||
		"";

	const paperId =
		entry.querySelector("id")?.textContent?.split("abs/")?.pop()?.trim() ||
		"";

	const pdfUrl =
		entry
			.querySelector("link[title='pdf']")
			?.getAttribute("href")
			?.trim()
			?.replace(/^http:\/\//i, "https://") || "";

	return {
		paperId,
		title,
		authors,
		date,
		abstract,
		comments,
		pdfUrl,
	};
}

export async function searchPaper(arxivId: string): Promise<Paper> {
	try {
		return await searchPaperFromAbsPage(arxivId);
	} catch (absPageError) {
		try {
			return await searchPaperFromApi(arxivId);
		} catch (apiError) {
			throw new Error(
				`Failed to fetch arXiv metadata from the abstract page or API. Abstract page: ${
					(absPageError as Error).message
				}. API: ${(apiError as Error).message}`
			);
		}
	}
}
