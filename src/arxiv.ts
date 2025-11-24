import { requestUrl } from "obsidian";

interface Paper {
	paperId: string;
	title: string;
	authors: string[];
	date: string;
	abstract: string;
	comments: string;
	pdfUrl: string;
}

export async function searchPaper(arxivId: string): Promise<Paper> {
	const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`;

	const response = await requestUrl({ url });
	const parser = new DOMParser();
	const xml = parser.parseFromString(response.text, "text/xml");

	const entry = xml.querySelector("entry")!;

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

	const comments = entry.querySelector("comment")?.textContent?.trim() || "";

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
