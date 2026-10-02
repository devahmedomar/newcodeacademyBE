import { Response } from "express";
import crypto from "crypto";
import { Book, IBook } from "../models/Book";
import { BookPage } from "../models/BookPage";
import { UploadChunk, chunkBuffers } from "../models/UploadChunk";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { ingestTextLayer, transcribeNextBatch } from "../services/books/ingest";
import { UPLOAD_CHUNK_BYTES } from "../services/books/pdfExtract";
import { assertAiConfigured, isAiConfigured } from "../services/ai/gemini";

/**
 * Book ingestion endpoints.
 *
 * The PDF never reaches MongoDB. The client posts it in ~3 MB slices (Vercel caps
 * a request body at 4.5 MB), the server stitches the slices, reads the text, and
 * throws the bytes away. Only extracted text is stored.
 */

/** Chunks are only useful while an upload is in flight. */
const CHUNK_TTL_MS = 60_000;

function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function teacherId(req: AuthRequest): string {
  return String(req.user!._id);
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

/** POST /api/books/chunk — accepts one binary slice (multipart field `chunk`). */
export async function uploadChunk(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const file = req.file;
    if (!file) return fail(res, 400, "No file part in the request");

    const sessionId = String(req.body.sessionId || "").trim();
    const index = Number(req.body.index);
    const total = Number(req.body.total);

    if (!sessionId) return fail(res, 400, "sessionId is required");
    if (!Number.isInteger(index) || index < 1) return fail(res, 400, "index must be a 1-based integer");
    if (!Number.isInteger(total) || total < 1) return fail(res, 400, "total must be a positive integer");
    if (index > total) return fail(res, 400, "index cannot exceed total");

    const data: Buffer = file.buffer;
    if (data.byteLength > UPLOAD_CHUNK_BYTES) {
      return fail(res, 413, `Chunk exceeds ${UPLOAD_CHUNK_BYTES} bytes`);
    }

    // Re-uploading a slice must overwrite, not duplicate.
    await UploadChunk.findOneAndUpdate(
      { sessionId, index },
      { $set: { sessionId, index, total, data, expiresAt: new Date(Date.now() + CHUNK_TTL_MS) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(202).json({ sessionId, index, total });
  } catch (err) {
    console.error("uploadChunk error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * POST /api/books — assembles the slices, extracts the text layer, creates the
 * Book. Returns 201 immediately; transcription (if the book is a scan) is driven
 * separately by the client so no single request runs long.
 */
export async function createBook(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const sessionId = String(req.body.sessionId || "").trim();
    const title = String(req.body.title || "").trim();
    const originalFileName = String(req.body.fileName || "").trim();

    if (!sessionId) return fail(res, 400, "sessionId is required");
    if (!title) return fail(res, 400, "title is required");
    if (!originalFileName) return fail(res, 400, "fileName is required");

    const chunks = await UploadChunk.find({ sessionId }).sort({ index: 1 }).lean();
    if (chunks.length === 0) {
      return fail(res, 400, "No upload chunks found for this session");
    }

    const first = chunks[0];
    const total = first.total;
    if (chunks.length !== total) {
      return fail(res, 400, `Upload is incomplete: got ${chunks.length} of ${total} chunks`);
    }

    // `chunkBuffers` normalises mongoose's BSON Binary back into a real Buffer.
    const payload = chunkBuffers(chunks);
    const sizeBytes = payload.reduce((n, c) => n + c.data.byteLength, 0);

    const result = await ingestTextLayer(payload, {
      teacherId: teacherId(req),
      title,
      originalFileName,
      sizeBytes,
    });

    // The slices have served their purpose.
    await UploadChunk.deleteMany({ sessionId });

    res.status(201).json({
      book: serializeBook(result.book),
      pageCount: result.pageCount,
      charCount: result.charCount,
      textCoverage: result.textCoverage,
      needsTranscription: result.needsTranscription,
      aiConfigured: isAiConfigured(),
      ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
    });
  } catch (err) {
    console.error("createBook error:", err);
    const message = err instanceof Error ? err.message : "Server error";
    // Validation failures (not a PDF, too many pages, oversized) are the client's
    // fault and need an actionable message, not a generic 500.
    const clientFault = /not a valid PDF|too large|max \d+ pages|no readable pages|No pages could be read|Upload is incomplete/i.test(
      message
    );
    return fail(res, clientFault ? 400 : 500, message);
  }
}

/**
 * POST /api/books/:id/transcribe — runs ONE Gemini vision batch and returns.
 * The client calls it repeatedly; each call stays well inside the time limit.
 */
export async function transcribeBook(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const book = await Book.findOne({ _id: req.params.id, teacherId: teacherId(req) });
    if (!book) return fail(res, 404, "Book not found");
    if (book.status === "ready") {
      return res.json({ done: true, processed: 0, unreadable: [], book: serializeBook(book) });
    }
    if (book.status !== "needs_transcription") {
      return fail(res, 409, `Book is not ready for transcription (status: ${book.status})`);
    }

    // Only now, when we know work is actually needed, insist on a key.
    assertAiConfigured();

    // The bytes were discarded after extraction, so the client resends the file.
    const file = req.file;
    if (!file) return fail(res, 400, "Re-send the PDF for this transcription step");
    const buffer: Buffer = file.buffer;

    const batchSize = Number(req.body.batchSize) || undefined;
    const step = await transcribeNextBatch(book, buffer, batchSize);

    res.json({
      done: step.done,
      processed: step.processed,
      unreadable: step.unreadable,
      book: serializeBook(step.book),
    });
  } catch (err) {
    console.error("transcribeBook error:", err);
    const message = err instanceof Error ? err.message : "Server error";
    return fail(res, 500, message);
  }
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

/** GET /api/books */
export async function listBooks(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const books = await Book.find({ teacherId: teacherId(req) })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(books.map(serializeBook));
  } catch (err) {
    console.error("listBooks error:", err);
    return fail(res, 500, "Server error");
  }
}

/** GET /api/books/:id */
export async function getBook(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const book = await Book.findOne({ _id: req.params.id, teacherId: teacherId(req) });
    if (!book) return fail(res, 404, "Book not found");

    const [filled, total, chars] = await Promise.all([
      BookPage.countDocuments({ bookId: book.id, $expr: { $gt: [{ $strLenCP: "$text" }, 0] } }),
      BookPage.countDocuments({ bookId: book.id }),
      BookPage.aggregate([{ $match: { bookId: book._id } }, { $group: { _id: null, c: { $sum: "$charCount" } } }]),
    ]);

    res.json({ ...serializeBook(book), pagesWithText: filled, pagesStored: total, charCount: chars[0]?.c ?? 0 });
  } catch (err) {
    console.error("getBook error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * GET /api/books/:id/pages?from=&to=
 *
 * Paginated on purpose: a 500-page preview in one response would blow the 4.5 MB
 * serverless response cap. The UI requests 5 pages at a time.
 */
export async function getBookPages(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const book = await Book.findOne({ _id: req.params.id, teacherId: teacherId(req) });
    if (!book) return fail(res, 404, "Book not found");

    const max = Math.max(1, Math.min(20, Number(req.query.limit) || 5));
    const from = Math.max(1, Number(req.query.from) || 1);
    const to = Math.min(book.pageCount, from + max - 1);

    const pages = await BookPage.find({ bookId: book.id, pageNumber: { $gte: from, $lte: to } })
      .sort({ pageNumber: 1 })
      .select("pageNumber text charCount transcribed")
      .lean();

    res.json({
      bookId: book.id,
      from,
      to,
      pageCount: book.pageCount,
      pages: pages.map((p) => ({
        pageNumber: p.pageNumber,
        text: p.text,
        charCount: p.charCount,
        transcribed: p.transcribed,
      })),
    });
  } catch (err) {
    console.error("getBookPages error:", err);
    return fail(res, 500, "Server error");
  }
}

/** DELETE /api/books/:id — also drops the page text. */
export async function deleteBook(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const book = await Book.findOneAndDelete({ _id: req.params.id, teacherId: teacherId(req) });
    if (!book) return fail(res, 404, "Book not found");
    await BookPage.deleteMany({ bookId: book.id });
    res.status(204).end();
  } catch (err) {
    console.error("deleteBook error:", err);
    return fail(res, 500, "Server error");
  }
}

/* -------------------------------------------------------------------------- */

export function newUploadSessionId(): string {
  return crypto.randomUUID();
}

function serializeBook(book: IBook) {
  return {
    _id: book.id,
    title: book.title,
    originalFileName: book.originalFileName,
    pageCount: book.pageCount,
    language: book.language,
    status: book.status,
    ocrUsed: book.ocrUsed,
    charCount: book.charCount,
    sizeBytes: book.sizeBytes,
    failureReason: book.failureReason,
    extractedAt: book.extractedAt,
    transcribeCursor: book.transcribeCursor,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}
