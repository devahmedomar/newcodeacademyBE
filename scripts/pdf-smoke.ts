import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  extractPages,
  assessExtraction,
  assembleChunks,
  isPdf,
  assertPdf,
  estimateTokens,
} from "../src/services/books/pdfExtract";

/**
 * Covers the pure PDF logic with no AI and no database: page extraction, the
 * scanned-book heuristic, chunk reassembly, and the guard rails. Run with
 * `npm run test:pdf`.
 */

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL ${name} ${extra}`);
  }
}

function textPdf(pages: number): Promise<Buffer> {
  return (async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= pages; i++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`MARKER-PAGE-${i} lorem ipsum dolor sit amet consectetur`, {
        x: 50,
        y: 780,
        size: 12,
        font,
      });
    }
    return Buffer.from(await doc.save());
  })();
}

/** Pages with no text layer — the shape a photographed/scanned book has. */
async function scannedPdf(pages: number, blankEvery = 1): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    if (i % blankEvery === 0) continue; // image-only page: nothing to draw
    page.drawText(`MARKER-PAGE-${i} lorem ipsum dolor sit amet consectetur`, {
      x: 50,
      y: 780,
      size: 12,
      font,
    });
  }
  return Buffer.from(await doc.save());
}

async function main() {
  console.log("1. Content sniffing");
  const good = await textPdf(12);
  check("detects a real PDF", isPdf(good));
  check("rejects a non-PDF buffer", !isPdf(Buffer.from("MZ this is an exe")));
  check("rejects an empty buffer", !isPdf(Buffer.alloc(0)));
  assertPdf(good);
  try {
    assertPdf(Buffer.from("not a pdf at all"));
    check("assertPdf throws on non-PDF", false, "(did not throw)");
  } catch {
    check("assertPdf throws on non-PDF", true);
  }

  console.log("2. Per-page extraction");
  const { pages, totalPages } = await extractPages(good);
  check("reports the true page count", totalPages === 12, `got ${totalPages}`);
  check(
    "extracts every page, not just the range endpoints",
    pages.length === 12,
    `got ${pages.length}`
  );
  check("page numbers are 1-based and ordered", pages[0].pageNumber === 1 && pages[11].pageNumber === 12);
  check(
    "each page carries its own text",
    pages.every((p, i) => p.text.includes(`MARKER-PAGE-${i + 1}`)),
    JSON.stringify(pages.map((p) => p.text.slice(0, 20)))
  );

  const slice = await extractPages(good, { first: 3, last: 5 });
  check(
    "honours a sub-range",
    slice.pages.length === 3 && slice.pages[0].pageNumber === 3 && slice.pages[2].pageNumber === 5,
    JSON.stringify(slice.pages.map((p) => p.pageNumber))
  );

  const clamped = await extractPages(good, { first: 10, last: 999 });
  check("clamps a last page past the end", clamped.pages.length === 3, `got ${clamped.pages.length}`);

  try {
    await extractPages(good, { first: 20, last: 25 });
    check("throws for a range outside the document", false, "(did not throw)");
  } catch {
    check("throws for a range outside the document", true);
  }

  try {
    await extractPages(good, { maxPages: 5 });
    check("enforces the page cap", false, "(did not throw)");
  } catch (e) {
    check("enforces the page cap", /max/.test((e as Error).message), (e as Error).message);
  }

  console.log("3. Scanned-book heuristic");
  const clean = assessExtraction(pages);
  check("a text PDF is not flagged as scanned", !clean.looksScanned, `coverage ${clean.textCoverage}`);

  const scan = await scannedPdf(10);
  const scanPages = await extractPages(scan);
  const q = assessExtraction(scanPages.pages);
  check("an image-only PDF is flagged as scanned", q.looksScanned, `coverage ${q.textCoverage}`);
  check("reports the empty page numbers", q.emptyPages.length > 0, JSON.stringify(q.emptyPages));
  check("coverage is a 0..1 ratio", q.textCoverage >= 0 && q.textCoverage <= 1);

  const halfBlank = assessExtraction((await extractPages(await scannedPdf(10, 3))).pages);
  check("a partly scanned PDF is flagged", halfBlank.looksScanned, `coverage ${halfBlank.textCoverage}`);

  console.log("4. Chunk reassembly");
  const size = Math.ceil(good.byteLength / 3);
  const chunks = [0, 1, 2].map((i) => ({
    index: i + 1,
    data: good.subarray(i * size, (i + 1) * size),
  }));
  check("reassembles to a byte-identical buffer", assembleChunks(chunks).equals(good));
  check("is order-independent", assembleChunks([chunks[2], chunks[0], chunks[1]]).equals(good));

  try {
    assembleChunks([chunks[0], chunks[2]]);
    check("rejects a missing chunk", false, "(did not throw)");
  } catch (e) {
    check("rejects a missing chunk", /incomplete/i.test((e as Error).message));
  }

  try {
    assembleChunks([]);
    check("rejects an empty chunk list", false, "(did not throw)");
  } catch {
    check("rejects an empty chunk list", true);
  }

  console.log("5. Misc");
  check("estimates tokens", estimateTokens("a".repeat(250)) === 100);
  check("rejects an absurdly large buffer", (() => {
    try {
      assertPdf(Buffer.concat([good, Buffer.alloc(200 * 1024 * 1024)]));
      return false;
    } catch {
      return true;
    }
  })());

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("PDF smoke test crashed:", err);
  process.exit(1);
});
