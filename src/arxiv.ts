import { requestUrl } from "obsidian";

const ARXIV_API_TIMEOUT_MS = 30000;

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

export async function searchPaper(arxivId: string): Promise<Paper> {
	const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;

	const response = await withTimeout(
		requestUrl({ url }),
		ARXIV_API_TIMEOUT_MS,
		"Timed out while fetching metadata from arXiv. Please try again later."
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
