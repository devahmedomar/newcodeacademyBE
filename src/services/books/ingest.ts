import { Book, IBook } from "../../models/Book";
import { BookPage } from "../../models/BookPage";
import { assembleChunks, assessExtraction, extractPages, ExtractedPage } from "./pdfExtract";
import { transcribePages } from "./visionTranscribe";
import { isAiConfigured } from "../ai/gemini";

/**
 * Turns an assembled PDF buffer into `BookPage` documents.
 *
 * Deliberately split into resumable steps rather than one long call:
 *
 *  1. `ingestTextLayer` assembles the chunks and reads the embedded text with
 *     `pdf-parse`. Free, fast, no AI quota — a few seconds for a whole book.
 *  2. If too few pages carried text, the book is a scan. `Book.status` becomes
 *     `needs_transcription` and the client drives `transcribeNextBatch` in a
 *     loop, so each request stays inside the serverless time limit.
 *  3. Only text is ever stored; the PDF bytes are dropped in step 1.
 *
 * The Arabic book for this project is likely a scan, which is exactly why step 2
 * is incremental rather than a single `await` over every page.
 */

/** Below this share of non-empty pages we treat the PDF as a scan. */
const TEXT_COVERAGE_FLOOR = 0.8;

export interface IngestOptions {
  teacherId: string;
  title: string;
  originalFileName: string;
  sizeBytes: number;
  /** 1-based inclusive page range to ingest. Omit for the whole book. */
  first?: number;
  last?: number;
}

export interface IngestResult {
  book: IBook;
  pageCount: number;
  charCount: number;
  textCoverage: number;
  /** True when the book needs Gemini vision before it can be used. */
  needsTranscription: boolean;
  /** Set when the book looks scanned but no API key is configured. */
  blockedReason?: string;
}

/** Step 1 — assemble, extract the text layer, persist pages. */
export async function ingestTextLayer(
  chunks: Array<{ index: number; data: Buffer }>,
  opts: IngestOptions
): Promise<IngestResult> {
  const buffer = assembleChunks(chunks);

  try {
    const { pages, totalPages } = await extractPages(buffer, {
      first: opts.first,
      last: opts.last,
    });

    const quality = assessExtraction(pages);
    const scanned = quality.textCoverage < TEXT_COVERAGE_FLOOR;

    // Every page gets a document, even blank ones, so page numbers stay aligned
    // with the printed book and the page picker never has gaps.
    const allPages: ExtractedPage[] = [];
    for (let n = 1; n <= totalPages; n++) {
      allPages.push(pages.find((p) => p.pageNumber === n) ?? { pageNumber: n, text: "" });
    }

    const charCount = allPages.reduce((sum, p) => sum + p.text.length, 0);

    const book = await Book.create({
      teacherId: opts.teacherId,
      title: opts.title,
      originalFileName: opts.originalFileName,
      pageCount: totalPages,
      language: "ar",
      charCount,
      sizeBytes: opts.sizeBytes,
      status: scanned ? "needs_transcription" : "ready",
      ocrUsed: false,
      extractedAt: new Date(),
      transcribeCursor: 0,
    });

    await BookPage.insertMany(
      allPages.map((p) => ({
        bookId: book.id,
        pageNumber: p.pageNumber,
        text: p.text,
        charCount: p.text.length,
        transcribed: false,
      })),
      { ordered: true }
    );

    return {
      book,
      pageCount: totalPages,
      charCount,
      textCoverage: quality.textCoverage,
      needsTranscription: scanned,
      ...(scanned && !isAiConfigured()
        ? { blockedReason: "This book has no text layer and GEMINI_API_KEY is not set" }
        : {}),
    };
  } finally {
    // Drop the references as early as possible; the bytes are never persisted.
    for (const c of chunks) c.data = Buffer.alloc(0);
  }
}

export interface TranscribeStepResult {
  processed: number;
  /** Pages that came back with no readable text. */
  unreadable: number[];
  total: number;
  done: boolean;
  book: IBook;
}

/**
 * Step 2 — transcribe the next batch of blank pages with Gemini vision.
 *
 * The PDF binary is needed again for every batch, so the client re-sends the
 * file; we never keep it. Returns `done: true` once no blank pages remain.
 */
export async function transcribeNextBatch(
  book: IBook,
  buffer: Buffer,
  batchSize?: number
): Promise<TranscribeStepResult> {
  // Resume from the cursor rather than rescanning every page each call.
  const blank = await BookPage.find({
    bookId: book.id,
    pageNumber: { $gt: book.transcribeCursor },
    $or: [{ text: "" }, { text: { $in: [null] } }],
  })
    .sort({ pageNumber: 1 })
    .limit(batchSize ?? 6)
    .select("pageNumber")
    .lean();

  if (blank.length === 0) {
    return { processed: 0, unreadable: [], total: 0, done: true, book };
  }

  const first = blank[0].pageNumber;
  const last = blank[blank.length - 1].pageNumber;

  const result = await transcribePages(buffer, { first, last, batchSize: blank.length });

  if (result.pages.length > 0) {
    await BookPage.bulkWrite(
      result.pages.map((p) => ({
        updateOne: {
          filter: { bookId: book.id, pageNumber: p.pageNumber },
          update: {
            $set: { text: p.text, charCount: p.text.length, transcribed: true },
          },
        },
      }))
    );
  }

  book.transcribeCursor = last;
  book.ocrUsed = true;

  // Only declare it ready once no blank pages are left at all.
  const remaining = await BookPage.countDocuments({
    bookId: book.id,
    text: "",
  });

  if (remaining === 0) {
    const agg = await BookPage.aggregate([
      { $match: { bookId: book._id } },
      { $group: { _id: null, chars: { $sum: "$charCount" } } },
    ]);
    book.charCount = agg[0]?.chars ?? book.charCount;
    book.status = "ready";
  }
  await book.save();

  return {
    processed: result.pages.length,
    unreadable: result.unreadable,
    total: blank.length,
    done: remaining === 0,
    book,
  };
}
