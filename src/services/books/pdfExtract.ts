import type { PDFParse as PDFParseType } from "pdf-parse";

/**
 * PDF text extraction and chunk reassembly.
 *
 * The binary never reaches MongoDB: the file is assembled in memory, converted to
 * per-page text, and the bytes are discarded. That is what keeps the M0 (512 MB)
 * Atlas cluster viable.
 *
 * Note: pdf-parse does no OCR. A scanned book yields empty pages, which is why
 * `assessExtraction` exists — the caller falls back to Gemini vision transcription.
 *
 * `pdf-parse` is imported lazily on purpose. It pulls in `pdfjs-dist`, which needs
 * the native `@napi-rs/canvas` addon for its DOM polyfills. If that addon is missing
 * for the platform (a Linux build without the binary, for example), a top-level
 * import throws `ReferenceError: DOMMatrix is not defined` and takes the entire
 * serverless function down — every route, not just book uploads. Loading it on
 * first use confines a PDF failure to a 503 on the upload route.
 */

type PDFParseCtor = new (opts: { data: Buffer }) => PDFParseType;

let parserCtor: Promise<PDFParseCtor> | null = null;

function loadParser(): Promise<PDFParseCtor> {
  if (!parserCtor) {
    parserCtor = import("pdf-parse").then(
      (mod) => (mod as unknown as { PDFParse: PDFParseCtor }).PDFParse,
      (err) => {
        parserCtor = null;
        throw new Error(
          `PDF text extraction is unavailable on this platform: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
  }
  return parserCtor;
}

/** Cheap probe so `/health` can report a broken PDF stack without crashing. */
export function isPdfEngineAvailable(): boolean {
  return parserCtor !== null;
}


export const PDF_MAX_MB = Number(process.env.PDF_MAX_MB || 80);
export const PDF_MAX_PAGES = Number(process.env.PDF_MAX_PAGES || 800);

/** Vercel caps request bodies at 4.5 MB on every plan. Leave headroom. */
export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = PDF_MAX_MB * 1024 * 1024;

export interface ExtractedPage {
  /** 1-based, matches the printed page number. */
  pageNumber: number;
  text: string;
}

/** Cheap content sniff so a renamed .exe never reaches the PDF parser. */
export function isPdf(buffer: Buffer): boolean {
  // The header is not always at offset 0; spec allows up to 1024 bytes of junk.
  const head = buffer.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}

export function assertPdf(buffer: Buffer): void {
  if (!isPdf(buffer)) {
    throw new Error("Uploaded file is not a valid PDF");
  }
  if (buffer.byteLength > UPLOAD_MAX_BYTES) {
    throw new Error(`PDF is too large (max ${PDF_MAX_MB} MB)`);
  }
}

/**
 * Reassemble upload chunks (1-based `index`, matching the client) into one buffer.
 * Throws when a chunk is missing so a truncated upload fails loudly rather than
 * producing a corrupt PDF.
 */
export function assembleChunks(chunks: Array<{ index: number; data: Buffer }>): Buffer {
  if (chunks.length === 0) throw new Error("No upload chunks were received");

  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].index !== i + 1) {
      throw new Error(`Upload is incomplete: expected chunk ${i + 1}, got ${sorted[i].index}`);
    }
  }

  const total = sorted.reduce((sum, c) => sum + c.data.byteLength, 0);
  if (total > UPLOAD_MAX_BYTES) {
    throw new Error(`PDF is too large (max ${PDF_MAX_MB} MB)`);
  }

  return Buffer.concat(sorted.map((c) => c.data));
}

export interface ExtractionOptions {
  /** 1-based inclusive page bounds. */
  first?: number;
  last?: number;
  maxPages?: number;
}

/**
 * Extract per-page text. Always releases the pdf.js worker.
 * Throws if the document exceeds the page cap.
 */
export async function extractPages(
  buffer: Buffer,
  opts: ExtractionOptions = {}
): Promise<{ pages: ExtractedPage[]; totalPages: number }> {
  assertPdf(buffer);

  const maxPages = opts.maxPages ?? PDF_MAX_PAGES;
  const PDFParse = await loadParser();
  const parser = new PDFParse({ data: buffer });

  try {
    const info = await parser.getInfo();
    const totalPages = info.total ?? 0;

    if (totalPages === 0) {
      throw new Error("PDF has no readable pages");
    }
    if (totalPages > maxPages) {
      throw new Error(`PDF has ${totalPages} pages (max ${maxPages})`);
    }

    const first = Math.max(1, opts.first ?? 1);
    const last = Math.min(totalPages, opts.last ?? totalPages);

    if (first > last) {
      throw new Error("Invalid page range");
    }

    // `partial` is a LIST of page numbers, not a [from, to] range: passing
    // [1, 12] yields only pages 1 and 12. Every page in the range must be listed.
    const pageNumbers: number[] = [];
    for (let n = first; n <= last; n++) pageNumbers.push(n);

    const result = await parser.getText({
      partial: pageNumbers,
      // Preserves visual line breaks, which matters for question quality.
      lineEnforce: true,
    });

    const pages: ExtractedPage[] = result.pages.map((p) => ({
      pageNumber: p.num,
      text: normalizeText(p.text || ""),
    }));

    // A range that returns fewer pages than asked for means pdf-parse skipped
    // something; surface it rather than persisting a silently incomplete book.
    if (pages.length !== pageNumbers.length) {
      const missing = pageNumbers.filter((n) => !pages.some((p) => p.pageNumber === n));
      console.warn(
        `[pdfExtract] expected ${pageNumbers.length} pages, got ${pages.length}; missing ${JSON.stringify(missing)}`
      );
    }

    return { pages, totalPages };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export interface ExtractionQuality {
  /** Pages whose text is effectively empty (scanned/image-only). */
  emptyPages: number[];
  /** Share of pages carrying real text, 0..1. */
  textCoverage: number;
  totalChars: number;
  /** Below this share we assume the PDF is a scan and needs vision transcription. */
  looksScanned: boolean;
}

/** Treats a page as "has text" only if it carries enough non-whitespace characters. */
const MIN_PAGE_CHARS = 40;

export function assessExtraction(pages: ExtractedPage[]): ExtractionQuality {
  const emptyPages = pages.filter((p) => stripNoise(p.text).length < MIN_PAGE_CHARS).map((p) => p.pageNumber);
  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  const textCoverage = pages.length === 0 ? 0 : 1 - emptyPages.length / pages.length;

  return {
    emptyPages,
    textCoverage: Number(textCoverage.toFixed(3)),
    totalChars,
    looksScanned: textCoverage < 0.8,
  };
}

/** Drop running headers/footers and collapse whitespace runs. */
function stripNoise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ‎‏‪-‮]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough token estimate — good enough for a UI hint, not billing. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 2.5);
}

export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/** Render page text for a prompt, with the page number so questions can cite sources. */
export function pagesToPromptText(pages: ExtractedPage[]): string {
  return pages
    .map((p) => `<<< صفحة ${p.pageNumber} >>>\n${p.text}`)
    .join("\n\n");
}
