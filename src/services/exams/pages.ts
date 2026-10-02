import { BookPage } from "../../models/BookPage";
import {
  estimateTokensFromChars,
  pagesToPromptText,
  type ExtractedPage,
} from "../books/pdfExtract";

/**
 * Reads the page text a generation prompt needs.
 *
 * The book is already in Mongo as one document per page, so a page range is a
 * single indexed query. Blank pages are dropped here rather than in the prompt:
 * a scanned book with a few empty pages should not hand the model `<<< صفحة 12 >>>`
 * with nothing after it.
 */

/**
 * Hard ceiling on the text sent in one call. The whole book is ~1–2 MB of text,
 * which would blow both the prompt budget and the request time limit; a range that
 * exceeds this needs to be split by the teacher.
 */
export const MAX_RANGE_CHARS = 180_000;

/** Below this many usable pages there is nothing to build an exam from. */
const MIN_USABLE_PAGES = 2;

export interface RangePages {
  pages: ExtractedPage[];
  charCount: number;
  /** Page numbers in the range that carried no text at all. */
  emptyPages: number[];
  estimatedTokens: number;
}

export async function loadRangePages(
  bookId: string,
  pageFrom: number,
  pageTo: number
): Promise<RangePages> {
  if (pageTo < pageFrom) throw new Error("pageTo must not be before pageFrom");

  const docs = await BookPage.find({
    bookId,
    pageNumber: { $gte: pageFrom, $lte: pageTo },
  })
    .sort({ pageNumber: 1 })
    .select("pageNumber text")
    .lean();

  const pages: ExtractedPage[] = [];
  const emptyPages: number[] = [];
  let charCount = 0;

  for (const d of docs) {
    const text = (d.text ?? "").trim();
    if (!text) {
      emptyPages.push(d.pageNumber);
      continue;
    }
    pages.push({ pageNumber: d.pageNumber, text });
    charCount += text.length;
  }

  if (pages.length < MIN_USABLE_PAGES) {
    throw new Error(
      `Only ${pages.length} of the selected pages contain text. Choose a wider range, or finish transcribing the book first.`
    );
  }

  if (charCount > MAX_RANGE_CHARS) {
    throw new Error(
      `The selected range is about ${estimateTokensFromChars(
        charCount
      ).toLocaleString("en")} tokens, which is too much for one generation step. Select fewer pages.`
    );
  }

  return {
    pages,
    charCount,
    emptyPages,
    estimatedTokens: estimateTokensFromChars(charCount),
  };
}

/** The exact text handed to the model, page numbers included for traceability. */
export function renderRange(pages: ExtractedPage[]): string {
  return pagesToPromptText(pages);
}
