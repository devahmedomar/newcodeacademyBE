import { PDFDocument } from "pdf-lib";
import { generateJson } from "../ai/gemini";
import { TRANSCRIBE_SCHEMA, TRANSCRIBE_SYSTEM, buildTranscribePrompt } from "../ai/prompts";
import type { ExtractedPage } from "./pdfExtract";

/**
 * Vision fallback for books whose PDF has no text layer (pure scans).
 *
 * `pdf-parse` cannot OCR, so a scanned Arabic book extracts to empty strings and
 * would produce exams with no source material. Rather than pulling in a native
 * canvas rasterizer (which does not deploy to Vercel serverless), we split the
 * requested page range into a small single-purpose PDF with `pdf-lib` and hand
 * that to Gemini, which renders and reads the pages natively.
 *
 * The returned text is all we keep — the bytes are discarded immediately, which
 * is what keeps the 512 MB Atlas cluster viable.
 */

/** Keeps each request well under the 20 MB inline-data ceiling. */
export const TRANSCRIBE_BATCH_PAGES = 6;

/** A batch that renders to more than this many base64 bytes is skipped. */
const MAX_BATCH_BASE64 = 14 * 1024 * 1024;

/**
 * Copy pages [first..last] (1-based, inclusive) out of the source PDF.
 * Returns base64 so it can go straight into an `inlineData` part.
 */
async function sliceToBase64(
  buffer: Buffer,
  first: number,
  last: number
): Promise<string> {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const indices: number[] = [];
  for (let n = first; n <= last; n++) {
    if (n < 1 || n > src.getPageCount()) continue;
    indices.push(n - 1);
  }
  if (indices.length === 0) throw new Error(`Page range ${first}-${last} is outside the document`);

  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  for (const page of copied) out.addPage(page);

  const bytes = await out.save();
  return Buffer.from(bytes).toString("base64");
}

export interface TranscribeOptions {
  /** 1-based inclusive start page of the whole book. */
  first: number;
  /** 1-based inclusive end page of the whole book. */
  last: number;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface TranscribeResult {
  pages: ExtractedPage[];
  /** Pages the model returned no readable text for. */
  unreadable: number[];
}

/**
 * Transcribe a page range with Gemini vision.
 *
 * Batches are sequential on purpose: the free tier's RPM limits make concurrent
 * bursts the most likely source of 429s, and the caller already retries per call.
 */
export async function transcribePages(
  buffer: Buffer,
  opts: TranscribeOptions
): Promise<TranscribeResult> {
  const batchSize = opts.batchSize ?? TRANSCRIBE_BATCH_PAGES;
  const { first, last } = opts;

  if (last < first) throw new Error("Invalid page range");

  const batches: Array<[number, number]> = [];
  for (let start = first; start <= last; start += batchSize) {
    batches.push([start, Math.min(last, start + batchSize - 1)]);
  }

  const byPage = new Map<number, string>();
  const unreadable: number[] = [];

  for (let i = 0; i < batches.length; i++) {
    const [batchFirst, batchLast] = batches[i];
    const data = await sliceToBase64(buffer, batchFirst, batchLast);

    if (data.length > MAX_BATCH_BASE64) {
      // A single oversized batch (huge scanned images) would be rejected by the
      // API. Record it and move on rather than failing the whole book.
      console.warn(
        `[vision] batch ${batchFirst}-${batchLast} is ${Math.round(data.length / 1024 / 1024)} MB base64, skipping`
      );
      for (let n = batchFirst; n <= batchLast; n++) unreadable.push(n);
      opts.onProgress?.(i + 1, batches.length);
      continue;
    }

    const raw = await generateJson<{ pages: Array<{ pageNumber: number; text: string }> }>(
      [
        { text: buildTranscribePrompt(batchFirst, batchLast) },
        { inlineData: { mimeType: "application/pdf", data } },
      ],
      {
        schema: TRANSCRIBE_SCHEMA as unknown as Record<string, unknown>,
        systemInstruction: TRANSCRIBE_SYSTEM,
        temperature: 0,
        maxOutputTokens: 32_768,
      }
    );

    const returned = new Set<number>();
    for (const p of raw.pages ?? []) {
      const pageNumber = Number(p.pageNumber);
      if (!Number.isInteger(pageNumber) || pageNumber < batchFirst || pageNumber > batchLast) {
        continue; // The model occasionally returns an out-of-range or repeated number.
      }
      if (returned.has(pageNumber)) continue;
      returned.add(pageNumber);

      const text = (p.text ?? "").trim();
      if (text) byPage.set(pageNumber, text);
      else unreadable.push(pageNumber);
    }

    // Any page the model silently dropped is unknown, not blank.
    for (let n = batchFirst; n <= batchLast; n++) {
      if (!returned.has(n)) unreadable.push(n);
    }

    opts.onProgress?.(i + 1, batches.length);
  }

  const pages: ExtractedPage[] = [];
  for (let n = first; n <= last; n++) {
    const text = byPage.get(n);
    if (text !== undefined) pages.push({ pageNumber: n, text });
  }

  return { pages, unreadable: [...new Set(unreadable)].sort((a, b) => a - b) };
}
