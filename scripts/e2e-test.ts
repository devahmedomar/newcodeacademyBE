import { MongoMemoryServer } from "mongodb-memory-server";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { Types } from "mongoose";
import { PDFDocument, StandardFonts } from "pdf-lib";
import app from "../src/app";
import { connectDB } from "../src/config/db";

/**
 * The default mongodb-memory-server dbPath lives under the OS temp dir (C:).
 * When C: is full, mongod dies with "No space left on device" while opening
 * its journal, so prefer a directory on whichever volume holds the project.
 */
function resolveDbPath(): string {
  const candidates = [
    path.join(__dirname, "..", "node_modules", ".cache", "mongo-mem"),
    path.join(os.tmpdir(), "mongo-mem"),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      // mongod wants an empty dbPath; stale files from an aborted run would
      // make it attempt recovery and fail.
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
      return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("No writable directory available for the test mongod dbPath");
}

async function main() {
  console.log("Starting in-memory MongoDB…");
  const dbPath = resolveDbPath();
  const mongod = await MongoMemoryServer.create({
    instance: { launchTimeout: 120_000, dbPath },
  });
  process.env.MONGODB_URI = mongod.getUri("nca-test");
  process.env.JWT_SECRET = "test-secret";
  process.env.SEED_TEACHER_EMAIL = "teacher@test.com";
  process.env.SEED_TEACHER_PASSWORD = "teacherpass";

  await connectDB();

  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://localhost:${port}`;

  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, extra = "") => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.log(`  ✗ FAIL ${name} ${extra}`);
    }
  };

  const req = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  /** multipart/form-data POST, used for the PDF chunk upload. */
  const reqForm = async (path: string, form: FormData, token?: string) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  };

  /** Build a real multi-page PDF so extraction is exercised for real. */
  const makePdf = async (pages: number, blankEvery = 0) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= pages; i++) {
      const page = doc.addPage([595, 842]);
      if (blankEvery && i % blankEvery === 0) continue; // simulate a scanned page
      page.drawText(`MARKER-PAGE-${i} lorem ipsum dolor sit amet`, {
        x: 50,
        y: 780,
        size: 12,
        font,
      });
    }
    return Buffer.from(await doc.save());
  };

  /** Slice a buffer and POST each piece to /api/books/chunk. */
  const uploadBook = async (
    pdf: Buffer,
    title: string,
    fileName: string,
    token: string,
    chunkBytes = 1024
  ) => {
    const session = await req("POST", "/api/books/transcribe-session", undefined, token);
    const sessionId = session.data.sessionId;

    const total = Math.max(1, Math.ceil(pdf.byteLength / chunkBytes));
    for (let i = 0; i < total; i++) {
      const slice = pdf.subarray(i * chunkBytes, (i + 1) * chunkBytes);
      const form = new FormData();
      form.append("sessionId", sessionId);
      form.append("index", String(i + 1));
      form.append("total", String(total));
      form.append("chunk", new Blob([new Uint8Array(slice)], { type: "application/pdf" }), "chunk");
      const r = await reqForm("/api/books/chunk", form, token);
      if (r.status !== 202) return { sessionId, chunkError: r };
    }

    const created = await req(
      "POST",
      "/api/books",
      { sessionId, title, fileName, sizeBytes: pdf.byteLength },
      token
    );
    return { sessionId, total, created };
  };

  console.log("1. Health");
  const health = await req("GET", "/api/ping");
  check("ping", health.status === 200, JSON.stringify(health));

  console.log("2. Auth");
  const bad = await req("POST", "/auth/login", { email: "teacher@test.com", password: "wrong" });
  check("login rejects bad password", bad.status === 401);

  const login = await req("POST", "/auth/login", { email: "teacher@test.com", password: "teacherpass" });
  check("teacher login works", login.status === 200 && login.data.token, JSON.stringify(login.data));

  const teacherToken: string = login.data.token;
  const me = await req("GET", "/auth/me", undefined, teacherToken);
  check("teacher /me returns role", me.data.user.role === "teacher");

  const unprotected = await req("GET", "/students");
  check("students requires auth", unprotected.status === 401);

  console.log("3. Teacher creates student");
  const create = await req("POST", "/auth/register", { name: "Amina Student", email: "amina@student.com", password: "student123" }, teacherToken);
  check("register student via teacher", create.status === 201, JSON.stringify(create.data));

  const noAuthRegister = await req("POST", "/auth/register", { name: "X", email: "x@x.com", password: "xxxxxx" });
  check("register requires teacher auth", noAuthRegister.status === 401);

  const students = await req("GET", "/students", undefined, teacherToken);
  check("teacher lists students", students.status === 200 && students.data.length === 1);

  const studentId: string = create.data.user.id;

  const studentLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "student123" });
  check("student login works", studentLogin.status === 200);
  const studentToken: string = studentLogin.data.token;

  console.log("4. Teacher CRUD (exams, homework, lessons, payments)");
  const exam = await req("POST", "/api/exams", { subject: "Coding", title: "Unit 1", maxGrade: 20 }, teacherToken);
  check("teacher creates exam template", exam.status === 201, JSON.stringify(exam.data));

  const examGrade = await req("PUT", `/api/exams/${exam.data._id}/grades`, { studentId, grade: 18 }, teacherToken);
  check("teacher records exam grade", examGrade.status === 200 && examGrade.data.grade === 18, JSON.stringify(examGrade.data));

  const overGrade = await req("PUT", `/api/exams/${exam.data._id}/grades`, { studentId, grade: 21 }, teacherToken);
  check("exam grade cannot exceed maxGrade", overGrade.status === 400);

  const hw = await req("POST", "/api/homework", { studentId, title: "Ch 2", points: 8, maxPoints: 10 }, teacherToken);
  check("teacher creates homework", hw.status === 201);

  const lesson = await req("POST", "/api/lessons", { title: "Intro JS", youtubeVideoId: "https://youtu.be/dQw4w9WgXcQ", module: "Module 1", order: 1 }, teacherToken);
  check("teacher creates lesson (URL extracted)", lesson.status === 201 && lesson.data.youtubeVideoId === "dQw4w9WgXcQ", JSON.stringify(lesson.data));

  // The current month, so "current payment" stays the current payment as the test ages.
const thisMonth = new Date().toISOString().slice(0, 7);
const payment = await req("POST", "/api/payments", { studentId, month: thisMonth, amount: 500, status: "unpaid" }, teacherToken);
  check("teacher creates payment", payment.status === 201, JSON.stringify(payment.data));

  const paidUpdate = await req("PUT", `/api/payments/${payment.data._id}`, { status: "paid" }, teacherToken);
  check("mark payment paid", paidUpdate.status === 200 && paidUpdate.data.status === "paid" && !!paidUpdate.data.paidOn);

  console.log("5. Student access control");
  const studentAttemptTeacherOnly = await req("POST", "/api/exams", { subject: "X", title: "Hack", maxGrade: 20 }, studentToken);
  check("student cannot create exams", studentAttemptTeacherOnly.status === 403);

  const studentGradeGrades = await req("PUT", `/api/exams/${exam.data._id}/grades`, { studentId, grade: 20 }, studentToken);
  check("student cannot record exam grades", studentGradeGrades.status === 403);

  const studentListExams = await req("GET", "/api/exams", undefined, studentToken);
  check("student cannot list the gradebook", studentListExams.status === 403);

  const studentReadGrades = await req("GET", `/api/exams/${exam.data._id}/grades`, undefined, studentToken);
  check("student cannot read the class's exam grades", studentReadGrades.status === 403);

  const anonReadGrades = await req("GET", `/api/exams/${exam.data._id}/grades`);
  check("anonymous cannot read exam grades", anonReadGrades.status === 401);

  const teacherReadsGrades = await req("GET", `/api/exams/${exam.data._id}/grades`, undefined, teacherToken);
  check("teacher can still read exam grades", teacherReadsGrades.status === 200 && teacherReadsGrades.data.grades.length === 1);

  console.log("5b. Public leaderboard anonymity");
  const anonBoard = await req("GET", "/api/leaderboard?limit=5");
  check("leaderboard is public", anonBoard.status === 200, JSON.stringify(anonBoard.data));
  check(
    "anonymous leaderboard hides identity",
    Array.isArray(anonBoard.data) &&
      anonBoard.data.every((e: Record<string, unknown>) => !("_id" in e) && !("possible" in e)),
    JSON.stringify(anonBoard.data)
  );
  check(
    "anonymous leaderboard masks names",
    Array.isArray(anonBoard.data) &&
      anonBoard.data.every((e: Record<string, unknown>) => !("email" in e)) &&
      !JSON.stringify(anonBoard.data).includes("Amina")
  );
  const authedBoard = await req("GET", "/api/leaderboard?limit=5", undefined, studentToken);
  check(
    "signed-in leaderboard still names students",
    authedBoard.status === 200 &&
      Array.isArray(authedBoard.data) &&
      authedBoard.data.some((e: { name: string }) => e.name.includes("Amina")),
    JSON.stringify(authedBoard.data)
  );

  const profile = await req("GET", "/api/students/me", undefined, studentToken);
  check("student profile aggregates data", profile.status === 200, JSON.stringify(profile.data));
  check("profile has exam", profile.data.exams.length === 1);
  check("profile has homework", profile.data.homeworks.length === 1);
  check("profile has payment", profile.data.payments.length === 1);
  check("profile shows only published lessons", profile.data.lessons.length === 1);
  check("current payment is paid", profile.data.currentPayment.status === "paid");

  const draftLesson = await req("POST", "/api/lessons", { title: "Draft", youtubeVideoId: "abc", module: "Module 1", order: 2, published: false }, teacherToken);
  check("teacher creates draft lesson", draftLesson.status === 201);
  const profile2 = await req("GET", "/api/students/me", undefined, studentToken);
  check("draft lesson hidden from student", profile2.data.lessons.length === 1);

  console.log("6. Student identity isolation");
  await req("POST", "/auth/register", { name: "Bassem", email: "bassem@student.com", password: "student123" }, teacherToken);
  const bassemLogin = await req("POST", "/auth/login", { email: "bassem@student.com", password: "student123" });
  const bassemToken: string = bassemLogin.data.token;
  const bassemProfile = await req("GET", "/api/students/me", undefined, bassemToken);
  check("second student sees no data", bassemProfile.data.exams.length === 0 && bassemProfile.data.payments.length === 0);

  await req("POST", "/api/payments", { studentId: bassemProfile.data.user.id, month: "2026-08", amount: 500, status: "late" }, teacherToken);
  const unpaidList = await req("GET", "/api/payments", undefined, teacherToken);
  check("teacher payment list covers all", unpaidList.data.length === 2, JSON.stringify(unpaidList.data));

  console.log("7. Password management");
  const wrongCurrent = await req("PUT", "/auth/password", { currentPassword: "nope", newPassword: "newpass1" }, studentToken);
  check("self change rejects wrong current password", wrongCurrent.status === 401);

  const selfChange = await req("PUT", "/auth/password", { currentPassword: "student123", newPassword: "newpass1" }, studentToken);
  check("student changes own password", selfChange.status === 200);

  const relogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "newpass1" });
  check("student logs in with new password", relogin.status === 200);
  const studentToken2: string = relogin.data.token;

  const shortPass = await req("PUT", `/api/students/${studentId}/password`, { password: "123" }, teacherToken);
  check("teacher reset rejects short password", shortPass.status === 400);

  const reset = await req("PUT", `/api/students/${studentId}/password`, { password: "resetpass" }, teacherToken);
  check("teacher resets student password", reset.status === 200);

  const resetLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("student logs in with reset password", resetLogin.status === 200);

  const studentForbidReset = await req("PUT", `/api/students/${studentId}/password`, { password: "whatever1" }, studentToken2);
  check("student cannot reset other accounts", studentForbidReset.status === 403);

  const studentForbidDelete = await req("DELETE", `/api/students/${studentId}`, undefined, studentToken2);
  check("student cannot delete accounts", studentForbidDelete.status === 403);

  console.log("8. Teacher deletes student (soft delete keeps data)");
  const del = await req("DELETE", `/api/students/${studentId}`, undefined, teacherToken);
  check("teacher deactivates student", del.status === 200);

  const del2 = await req("DELETE", `/api/students/${studentId}`, undefined, teacherToken);
  check("deactivating again returns 400", del2.status === 400);

  const keptProfile = await req("GET", `/api/students/${studentId}`, undefined, teacherToken);
  check("deactivated student's data is kept", keptProfile.status === 200 && keptProfile.data.payments.length === 1);

  const goneLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("deactivated student cannot log in", goneLogin.status === 401);

  const restoreRes = await req("PUT", `/api/students/${studentId}/restore`, undefined, teacherToken);
  check("teacher restores student", restoreRes.status === 200);

  const restoredLogin = await req("POST", "/auth/login", { email: "amina@student.com", password: "resetpass" });
  check("restored student can log in", restoredLogin.status === 200);

  console.log("9. Book ingestion (chunked upload -> extract -> pages)");
  const noAuthBooks = await req("GET", "/api/books");
  check("books require auth", noAuthBooks.status === 401);

  const studentBooks = await req("GET", "/api/books", undefined, studentToken2);
  check("students cannot list books", studentBooks.status === 403);

  const pdf = await makePdf(9);
  const up = await uploadBook(pdf, "الرياضيات للصف الأول", "math-g1.pdf", teacherToken, 1024);
  check("chunks + create returns 201", up.created.status === 201, JSON.stringify(up.created.data));
  const bookId = up.created.data?.book?._id;
  check("PDF was split into multiple chunks", up.total > 1, `total ${up.total}`);
  check("every page was stored", up.created.data?.pageCount === 9, JSON.stringify(up.created.data));
  check(
    "text was extracted from every page",
    up.created.data?.book?.status === "ready" && up.created.data?.charCount > 0,
    JSON.stringify(up.created.data?.book)
  );
  check("a text-layer book needs no transcription", up.created.data?.needsTranscription === false);

  const list = await req("GET", "/api/books", undefined, teacherToken);
  check("book appears in the teacher list", list.status === 200 && list.data.length === 1, JSON.stringify(list.data));

  const one = await req("GET", `/api/books/${bookId}`, undefined, teacherToken);
  check("book detail reports page stats", one.data?.pagesStored === 9 && one.data?.pagesWithText === 9, JSON.stringify(one.data));

  const preview = await req("GET", `/api/books/${bookId}/pages?from=1&limit=5`, undefined, teacherToken);
  check("page preview honours the range", preview.data?.pages?.length === 5, JSON.stringify(preview.data?.pages?.length));
  check(
    "page preview returns the right page numbers",
    preview.data?.pages?.[0]?.pageNumber === 1 && preview.data?.pages?.[4]?.pageNumber === 5
  );
  check("page preview carries real text", (preview.data?.pages?.[0]?.text || "").includes("MARKER-PAGE-1"));

  const preview2 = await req("GET", `/api/books/${bookId}/pages?from=6&limit=5`, undefined, teacherToken);
  check(
    "preview paginates past the first window",
    JSON.stringify(preview2.data?.pages?.map((p: any) => p.pageNumber)) === JSON.stringify([6, 7, 8, 9]),
    JSON.stringify(preview2.data?.pages?.map((p: any) => p.pageNumber))
  );

  // A different teacher must not be able to read this book. /auth/register only
  // creates students, so seed a second teacher directly.
  const { User } = await import("../src/models/User");
  const bcrypt = (await import("bcryptjs")).default;
  const otherTeacher = await User.create({
    name: "Other Teacher",
    email: "other.teacher@test.com",
    passwordHash: await bcrypt.hash("teacher123", 10),
    role: "teacher",
  });
  const otherLogin = await req("POST", "/auth/login", { email: "other.teacher@test.com", password: "teacher123" });
  const otherToken: string = otherLogin.data.token;
  check("second teacher can log in", otherLogin.status === 200 && otherToken, JSON.stringify(otherLogin.data));
  const otherBooks = await req("GET", "/api/books", undefined, otherToken);
  check("a teacher's book list is scoped to them", otherBooks.status === 200 && otherBooks.data.length === 0, JSON.stringify(otherBooks.data));
  const otherPeek = await req("GET", `/api/books/${bookId}/pages`, undefined, otherToken);
  check("another teacher cannot read the pages", otherPeek.status === 404, JSON.stringify(otherPeek.data));
  const otherDelete = await req("DELETE", `/api/books/${bookId}`, undefined, otherToken);
  check("another teacher cannot delete the book", otherDelete.status === 404);
  void otherTeacher;

  // Incomplete upload must fail loudly instead of producing a corrupt book.
  const orphanSession = await req("POST", "/api/books/transcribe-session", undefined, teacherToken);
  const orphanForm = new FormData();
  orphanForm.append("sessionId", orphanSession.data.sessionId);
  orphanForm.append("index", "1");
  orphanForm.append("total", "3");
  orphanForm.append("chunk", new Blob([new Uint8Array(pdf.subarray(0, 500))], { type: "application/pdf" }), "chunk");
  const orphanChunk = await reqForm("/api/books/chunk", orphanForm, teacherToken);
  check("partial chunk accepted", orphanChunk.status === 202);
  const orphanCreate = await req(
    "POST",
    "/api/books",
    { sessionId: orphanSession.data.sessionId, title: "Broken", fileName: "b.pdf" },
    teacherToken
  );
  check("incomplete upload is rejected", orphanCreate.status === 400, JSON.stringify(orphanCreate.data));

  // A renamed .exe must not reach the PDF parser.
  const fake = await uploadBook(Buffer.from("MZ this is definitely not a pdf"), "Fake", "virus.exe", teacherToken, 4096);
  check("a non-PDF upload is rejected", fake.created.status === 400, JSON.stringify(fake.created.data));

  // A scanned book must be flagged for vision transcription, not silently accepted.
  const scanPdf = await makePdf(6, 1); // every other page has no text layer
  const scanUp = await uploadBook(scanPdf, "كتاب ممسوح", "scan.pdf", teacherToken, 2048);
  check("scanned book is created", scanUp.created.status === 201, JSON.stringify(scanUp.created.data));
  check("scanned book is flagged for transcription", scanUp.created.data?.needsTranscription === true, JSON.stringify(scanUp.created.data));
  check("scanned book status is needs_transcription", scanUp.created.data?.book?.status === "needs_transcription");

  // Transcription needs a Gemini key; without one the step must fail cleanly.
  const scanId = scanUp.created.data?.book?._id;
  const noKeyForm = new FormData();
  noKeyForm.append("file", new Blob([new Uint8Array(scanPdf)], { type: "application/pdf" }), "scan.pdf");
  const scanStep = await reqForm(`/api/books/${scanId}/transcribe`, noKeyForm, teacherToken);
  check(
    "transcription without an API key returns a clear error",
    scanStep.status === 500 && /GEMINI_API_KEY/.test(scanStep.data?.message || ""),
    JSON.stringify(scanStep.data)
  );

  const readyForm = new FormData();
  readyForm.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "math.pdf");
  const readyScanStep = await reqForm(`/api/books/${bookId}/transcribe`, readyForm, teacherToken);
  check(
    "transcribing an already-ready book is a no-op",
    readyScanStep.status === 200 && readyScanStep.data?.done === true,
    JSON.stringify(readyScanStep.data)
  );

  console.log("10. AI exam sets (teacher-only, hermetic: no Gemini key)");
  // The generation steps must refuse to run without a key rather than reach the
  // network, so the key is cleared for the whole suite.
  delete process.env.GEMINI_API_KEY;

  const { ExamSet } = await import("../src/models/ExamSet");
  const { ExamForm, computeMaxGrade } = await import("../src/models/ExamForm");

  const noAuthSets = await req("GET", "/api/exam-sets");
  check("exam sets require auth", noAuthSets.status === 401);

  // `GET /api/exam-sets` is role-aware: a student gets the sets assigned to them,
  // which is nothing yet, rather than a 403 — the portal will call this path.
  const studentSets = await req("GET", "/api/exam-sets", undefined, studentToken2);
  check(
    "a student gets their own empty exam list",
    studentSets.status === 200 && Array.isArray(studentSets.data) && studentSets.data.length === 0,
    JSON.stringify(studentSets.data)
  );

  const noTitle = await req(
    "POST",
    "/api/exam-sets",
    { bookId, pageFrom: 1, pageTo: 5 },
    teacherToken
  );
  check("an exam set needs a title", noTitle.status === 400, JSON.stringify(noTitle.data));

  const unreadyBook = await req(
    "POST",
    "/api/exam-sets",
    { title: "من كتاب ممسوح", bookId: scanId, pageFrom: 1, pageTo: 3 },
    teacherToken
  );
  check(
    "a book awaiting transcription cannot be used",
    unreadyBook.status === 409 && /transcri/i.test(unreadyBook.data?.message || ""),
    JSON.stringify(unreadyBook.data)
  );

  const otherBook = await req(
    "POST",
    "/api/exam-sets",
    { title: "كتاب غيري", bookId, pageFrom: 1, pageTo: 3 },
    otherToken
  );
  check("a book belonging to someone else is not found", otherBook.status === 404);

  const created = await req(
    "POST",
    "/api/exam-sets",
    {
      title: "اختبار الكسور",
      bookId,
      weekLabel: "الأسبوع الثالث",
      pageFrom: 1,
      pageTo: 4,
      difficulty: "hard",
      mcqCount: 6,
      shortCount: 2,
      formCount: 3,
      timeLimitMinutes: 45,
      passPercent: 60,
    },
    teacherToken
  );
  check("teacher creates an exam set", created.status === 201, JSON.stringify(created.data));
  const setId = created.data?._id;
  check("a new set has no blueprint yet", created.data?.hasBlueprint === false);
  check("it reports the labels it will produce", created.data?.formLabels?.join("") === "ABC");

  const badRange = await req("PUT", `/api/exam-sets/${setId}`, { pageFrom: 5, pageTo: 2 }, teacherToken);
  check("a backwards page range is rejected", badRange.status === 400, JSON.stringify(badRange.data));

  const beforeBlueprint = await req("POST", `/api/exam-sets/${setId}/forms/A`, undefined, teacherToken);
  check(
    "generating a form before the blueprint is refused",
    beforeBlueprint.status === 400 && /blueprint/i.test(beforeBlueprint.data?.message || ""),
    JSON.stringify(beforeBlueprint.data)
  );

  const noKeyBlueprint = await req("POST", `/api/exam-sets/${setId}/blueprint`, undefined, teacherToken);
  check(
    "the blueprint step reports a missing API key instead of failing obscurely",
    noKeyBlueprint.status === 503 && /GEMINI_API_KEY/.test(noKeyBlueprint.data?.message || ""),
    JSON.stringify(noKeyBlueprint.data)
  );

  const otherReads = await req("GET", `/api/exam-sets/${setId}`, undefined, otherToken);
  check("another teacher cannot read the set", otherReads.status === 404);
  const otherDeletes = await req("DELETE", `/api/exam-sets/${setId}`, undefined, otherToken);
  check("another teacher cannot delete the set", otherDeletes.status === 404);

  // Seed a blueprint and a form directly: the review endpoints are ordinary
  // CRUD and must be testable without spending a Gemini call.
  await ExamSet.updateOne(
    { _id: setId },
    {
      $set: {
        blueprint: {
          topics: [
            { topic: "الكسور", weight: 3, keywords: ["نصف", "ربع"] },
            { topic: "الزوايا", weight: 3, keywords: ["حادة"] },
          ],
          summary: "خريطة مبسطة",
          createdAt: new Date(),
        },
      },
    }
  );

  const frozenRange = await req("PUT", `/api/exam-sets/${setId}`, { pageFrom: 2, pageTo: 6 }, teacherToken);
  check(
    "the page range cannot move once questions exist",
    frozenRange.status === 409,
    JSON.stringify(frozenRange.data)
  );
  const renamed = await req("PUT", `/api/exam-sets/${setId}`, { title: "اختبار الكسور والمزيد" }, teacherToken);
  check("metadata can still be edited", renamed.status === 200 && renamed.data?.title === "اختبار الكسور والمزيد");

  const mcqDoc = (over: Record<string, unknown> = {}) => ({
    type: "mcq",
    prompt: "ما ناتج جمع الكسرين التاليين؟",
    options: [
      { id: "o1", text: "ثلاثة أرباع" },
      { id: "o2", text: "نصف" },
      { id: "o3", text: "ربع" },
      { id: "o4", text: "خمسة أثمان" },
    ],
    correctOptionId: "o1",
    rubric: [],
    maxPoints: 1,
    explanation: "الجمع المباشر يعطي ثلاثة أرباع.",
    topic: "الكسور",
    sourcePages: [2],
    editedByTeacher: false,
    verify: { status: "flagged", issue: "ambiguous", note: "يحتمل أكثر من قراءة", checkedAt: new Date() },
    ...over,
  });
  const shortDoc = (over: Record<string, unknown> = {}) => ({
    type: "short",
    prompt: "عرّف الزاوية الحادة.",
    options: [],
    modelAnswer: "الزاوية الحادة أقل من تسعين درجة.",
    rubric: ["ذكر التعريف", "ذكر الشرط"],
    maxPoints: 2,
    explanation: "إجابة قصيرة.",
    topic: "الزوايا",
    sourcePages: [3],
    editedByTeacher: false,
    verify: { status: "ok", issue: "none", note: "", checkedAt: new Date() },
    ...over,
  });

  const seededForm = await ExamForm.create({
    examSetId: setId,
    formLabel: "A",
    questions: [mcqDoc(), shortDoc()],
    maxGrade: computeMaxGrade([mcqDoc(), shortDoc()]),
    status: "draft",
  });
  const formId = String(seededForm._id);
  const firstQuestionId = String(seededForm.questions[0]._id);

  const detail = await req("GET", `/api/exam-sets/${setId}`, undefined, teacherToken);
  check("the set comes back with its blueprint", detail.data?.blueprint?.topics?.length === 2);
  check("and with its forms", detail.data?.forms?.length === 1, JSON.stringify(detail.data?.forms?.length));
  check("a review response carries the answer key", detail.data?.forms?.[0]?.questions?.[0]?.correctOptionId === "o1");
  check("and reports coverage against the blueprint", detail.data?.forms?.[0]?.coverage?.missing?.length === 0);
  check(
    "and names the book it was built from",
    detail.data?.book?.title === "الرياضيات للصف الأول",
    JSON.stringify(detail.data?.book)
  );

  const setList = await req("GET", "/api/exam-sets", undefined, teacherToken);
  const listedSet = setList.data?.find((s: any) => s._id === setId);
  check("the list counts the forms already built", listedSet?.formsBuilt === 1, JSON.stringify(listedSet));
  check("the list reports what a paper is worth", listedSet?.maxGrade === 3, JSON.stringify(listedSet));
  // A count of questions (2), not the sum of their points (3) — the old aggregate
  // conflated the two, and the list screen shows both numbers side by side.
  check("the list counts questions", listedSet?.questions === 2, JSON.stringify(listedSet));
  check(
    "the list names the book the set came from",
    listedSet?.book?.title === "الرياضيات للصف الأول",
    JSON.stringify(listedSet?.book)
  );
  check(
    "the list counts questions a teacher still has to look at",
    listedSet?.flagged === 1,
    JSON.stringify(listedSet)
  );

  const otherForm = await req("POST", `/api/exam-forms/${formId}/verify`, undefined, otherToken);
  check("another teacher cannot verify a form", otherForm.status === 404, JSON.stringify(otherForm.data));
  const otherEdit = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    { prompt: "تعديل" },
    otherToken
  );
  check("another teacher cannot edit a question", otherEdit.status === 404);

  const edited = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    { prompt: "ما ناتج جمع الكسرين الآتيين؟" },
    teacherToken
  );
  const editedQuestion = edited.data?.form?.questions?.[0];
  check("a teacher can reword a question", edited.status === 200, JSON.stringify(edited.data));
  check("the edit is stored", editedQuestion?.prompt === "ما ناتج جمع الكسرين الآتيين؟");
  check("a hand-edited question counts as reviewed", editedQuestion?.verify?.status === "ok");
  check("and is protected from automatic repair", editedQuestion?.editedByTeacher === true);
  check("the option ids survive the edit", (editedQuestion?.options ?? []).map((o: any) => o.id).join(",") === "o1,o2,o3,o4");
  check("the answer key survives the edit", editedQuestion?.correctOptionId === "o1");

  const rekeyed = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    {
      options: [
        { id: "o4", text: "خمسة أثمان" },
        { id: "o3", text: "ربع" },
        { id: "o2", text: "نصف" },
        { id: "o1", text: "ثلاثة أرباع" },
      ],
    },
    teacherToken
  );
  const reordered = rekeyed.data?.form?.questions?.[0];
  check(
    "reordering the options keeps the key on the right option",
    rekeyed.status === 200 &&
      reordered?.correctOptionId === "o1" &&
      reordered?.options?.[3]?.text === "ثلاثة أرباع",
    JSON.stringify(reordered)
  );

  const badEdit = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    { options: ["نصف", "ربع", "ثلاثة أرباع"] },
    teacherToken
  );
  check(
    "an edit that breaks the four-option rule is refused",
    badEdit.status === 400 && /option/i.test(badEdit.data?.message || ""),
    JSON.stringify(badEdit.data)
  );

  const unanswerable = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    { options: ["نصف", "ربع", "ثلث", "خمس"] },
    teacherToken
  );
  check(
    "replacing every option without marking the answer is refused",
    unanswerable.status === 400 && /correct answer/i.test(unanswerable.data?.message || ""),
    JSON.stringify(unanswerable.data)
  );

  const missingQuestion = await req(
    "PUT",
    `/api/exam-forms/${formId}/questions/000000000000000000000000`,
    { prompt: "أي" },
    teacherToken
  );
  check("editing a question that is not there returns 404", missingQuestion.status === 404);

  const noKeyVerify = await req("POST", `/api/exam-forms/${formId}/verify`, undefined, teacherToken);
  check(
    "verifying without an API key reports it clearly",
    noKeyVerify.status === 503 && /GEMINI_API_KEY/.test(noKeyVerify.data?.message || ""),
    JSON.stringify(noKeyVerify.data)
  );
  const noKeyRegen = await req(
    "POST",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}/regenerate`,
    { issue: "ambiguous", note: "أعد صياغته" },
    teacherToken
  );
  check(
    "regenerating a question without an API key reports it clearly",
    noKeyRegen.status === 503 && /GEMINI_API_KEY/.test(noKeyRegen.data?.message || ""),
    JSON.stringify(noKeyRegen.data)
  );

  const removed = await req(
    "DELETE",
    `/api/exam-forms/${formId}/questions/${firstQuestionId}`,
    undefined,
    teacherToken
  );
  check("a teacher can delete a question", removed.status === 200, JSON.stringify(removed.data));
  check("the form is revalued after the deletion", removed.data?.form?.maxGrade === 2, JSON.stringify(removed.data?.form?.maxGrade));
  check("and the question is gone", removed.data?.form?.questions?.length === 1);

  const noKeyFormGen = await req("POST", `/api/exam-sets/${setId}/forms/B`, undefined, teacherToken);
  check(
    "generating a form without an API key reports it clearly",
    noKeyFormGen.status === 503 && /GEMINI_API_KEY/.test(noKeyFormGen.data?.message || ""),
    JSON.stringify(noKeyFormGen.data)
  );
  const badLabel = await req("POST", `/api/exam-sets/${setId}/forms/Z`, undefined, teacherToken);
  check("a form label outside the set's range is refused", badLabel.status === 400, JSON.stringify(badLabel.data));

  console.log("11. Publishing, assigning, and what a student is allowed to see");
  const { ExamAssignment } = await import("../src/models/ExamAssignment");

  // A second student, so "balanced" means something other than one row.
  const secondStudent = await req(
    "POST",
    "/auth/register",
    { name: "Bilal Student", email: "bilal@student.com", password: "student123" },
    teacherToken
  );
  check("a second student exists to share papers between", secondStudent.status === 201, JSON.stringify(secondStudent.data));
  const secondStudentId: string = secondStudent.data?.user?.id;

  const studentPublish = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, studentToken2);
  check("a student cannot publish", studentPublish.status === 403);
  const studentRoster = await req("GET", `/api/exam-sets/${setId}/assignments`, undefined, studentToken2);
  check("a student cannot see the paper roster", studentRoster.status === 403);

  // 8 questions per form: 6 MCQ and 2 short, which is what the set asked for.
  const fullForm = (label: string) => ({
    examSetId: setId,
    formLabel: label,
    questions: [
      ...Array.from({ length: 6 }, (_, i) => mcqDoc({ prompt: `سؤال اختيار ${label}${i}` })),
      ...Array.from({ length: 2 }, (_, i) => shortDoc({ prompt: `سؤال مقالي ${label}${i}` })),
    ],
    maxGrade: 10,
    status: "ready",
  });

  const earlyPublish = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  check(
    "publishing an unfinished set is refused",
    earlyPublish.status === 409,
    JSON.stringify(earlyPublish.data)
  );
  check(
    "and says which forms are missing",
    (earlyPublish.data?.blockers ?? []).some((b: { label: string; reason: string }) => /not been generated/.test(b.reason)),
    JSON.stringify(earlyPublish.data?.blockers)
  );
  check("and nothing was published", (await ExamSet.findById(setId))?.status === "draft");

  // The seeded form A is topped up in place rather than replaced, so the review
  // tests above keep referring to the same form.
  await ExamForm.updateOne(
    { _id: formId },
    { $set: { questions: fullForm("A").questions, maxGrade: 10, status: "ready" } }
  );
  await ExamForm.create(fullForm("B"));
  const shortFormC = await ExamForm.create({
    examSetId: setId,
    formLabel: "C",
    questions: [mcqDoc({ prompt: "سؤال ناقص" })],
    maxGrade: 1,
    status: "ready",
  });

  const unreviewed = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  check("an unreviewed set cannot be published", unreviewed.status === 409);
  check(
    "and the reason is the review, not the missing questions",
    (unreviewed.data?.blockers ?? []).some((b: { label: string; reason: string }) => b.label === "C" && /1 of 8/.test(b.reason)),
    JSON.stringify(unreviewed.data?.blockers)
  );

  const missingReview = await req("POST", `/api/exam-forms/${formId}/review`, undefined, teacherToken);
  check("a teacher can mark a form as reviewed", missingReview.status === 200 && !!missingReview.data?.form?.reviewedAt, JSON.stringify(missingReview.data));
  const unreview = await req("POST", `/api/exam-forms/${formId}/review`, { reviewed: false }, teacherToken);
  check("and take the mark back", unreview.status === 200 && unreview.data?.form?.reviewedAt === null, JSON.stringify(unreview.data?.form?.reviewedAt));
  const emptyReview = await req("POST", "/api/exam-forms/000000000000000000000000/review", undefined, teacherToken);
  check("reviewing a form that does not exist is a 404", emptyReview.status === 404, JSON.stringify(emptyReview.data));
  const otherFormReview = await req("POST", `/api/exam-forms/${formId}/review`, undefined, otherToken);
  check("another teacher cannot review my form", otherFormReview.status === 404);

  // Top the short form up, then review all three for real.
  await ExamForm.updateOne(
    { _id: shortFormC._id },
    { $set: { questions: fullForm("C").questions, maxGrade: 10 } }
  );
  const formIds: Record<string, string> = { A: formId, B: String((await ExamForm.findOne({ examSetId: setId, formLabel: "B" }))?._id), C: String(shortFormC._id) };
  for (const label of ["A", "B", "C"]) {
    const reviewed = await req("POST", `/api/exam-forms/${formIds[label]}/review`, undefined, teacherToken);
    check(`form ${label} is marked as reviewed`, reviewed.status === 200 && !!reviewed.data?.form?.reviewedAt);
  }

  const published = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  check("a reviewed, complete set publishes", published.status === 200, JSON.stringify(published.data));
  check("the set is published and stamped", published.data?.set?.status === "published" && !!published.data?.set?.publishedAt);
  check(
    "every student was dealt exactly one paper",
    published.data?.assignments?.written === published.data?.assignments?.students && published.data?.assignments?.students >= 2,
    JSON.stringify(published.data?.assignments)
  );
  check("the papers are spread across the forms", (() => {
    const per: number[] = Object.values(published.data?.assignments?.perForm ?? {});
    const total = per.reduce((a, b) => a + b, 0);
    return per.length === 3 && total === published.data?.assignments?.students && Math.max(...per) - Math.min(...per) <= 1;
  })(), JSON.stringify(published.data?.assignments?.perForm));
  check("no student was skipped", published.data?.assignments?.skippedInactive === 0);

  const republish = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  const dealt = await ExamAssignment.countDocuments({ examSetId: setId });
  check("publishing twice deals no second hand", republish.status === 200 && dealt === published.data?.assignments?.written, JSON.stringify(republish.data?.assignments));

  const roster = await req("GET", `/api/exam-sets/${setId}/assignments`, undefined, teacherToken);
  check("the roster lists every student, dealt or not", roster.status === 200 && roster.data?.rows?.length === published.data?.assignments?.students, JSON.stringify(roster.data?.rows?.length));
  check("with names and a paper for each", roster.data?.rows?.every((r: { name: string; formLabel: string | null }) => !!r.name && !!r.formLabel));
  check("and the per-form counts add up", (roster.data?.forms ?? []).reduce((a: number, f: { students: number }) => a + f.students, 0) === dealt, JSON.stringify(roster.data?.forms));
  const otherRoster = await req("GET", `/api/exam-sets/${setId}/assignments`, undefined, otherToken);
  check("another teacher cannot see the roster", otherRoster.status === 404);

  // What the student is handed: the card, and nothing else.
  const studentList = await req("GET", "/api/exam-sets", undefined, studentToken2);
  check("the student sees the published set", studentList.status === 200 && studentList.data?.length === 1, JSON.stringify(studentList.data));
  check("with their own form letter and the right question count", studentList.data?.[0]?.formCount === 3 && studentList.data?.[0]?.questionCount === 8, JSON.stringify(studentList.data?.[0]));
  const studentPayload = JSON.stringify(studentList.data);
  check("and no answer key", !/correctOptionId|modelAnswer|rubric|explanation/.test(studentPayload), studentPayload.slice(0, 200));
  check("and no questions or form id", !/"questions"|"formId"|"blueprint"/.test(studentPayload), studentPayload.slice(0, 200));

  const badOverride = await req("PATCH", `/api/exam-sets/${setId}/assignments/${secondStudentId}`, { formLabel: "Z" }, teacherToken);
  check("a form outside this set cannot be assigned", badOverride.status === 400, JSON.stringify(badOverride.data));
  const notAStudent = await req("PATCH", `/api/exam-sets/${setId}/assignments/${me.data.user.id}`, { formLabel: "A" }, teacherToken);
  check("a teacher cannot be assigned a paper", notAStudent.status === 404);
  const otherOverride = await req("PATCH", `/api/exam-sets/${setId}/assignments/${secondStudentId}`, { formLabel: "A" }, otherToken);
  check("another teacher cannot move a student", otherOverride.status === 404);

  const override = await req("PATCH", `/api/exam-sets/${setId}/assignments/${secondStudentId}`, { formLabel: "C" }, teacherToken);
  check("a teacher can move a student to another paper", override.status === 200 && override.data?.formLabel === "C" && override.data?.source === "teacher", JSON.stringify(override.data));
  const afterOverride = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  const moved = await ExamAssignment.findOne({ examSetId: setId, studentId: secondStudentId });
  check("re-publishing does not undo a manual move", moved?.formLabel === "C", JSON.stringify(afterOverride.data?.assignments));
  check("and does not quietly relabel it as automatic", moved?.source === "teacher", moved?.source);

  /* ------------------------------------------------------------------ */
  /* Sitting the paper                                                   */
  /* ------------------------------------------------------------------ */

  console.log("12. Sitting the paper (student-only, hermetic: no Gemini key)");
  const { ExamAttempt } = await import("../src/models/ExamAttempt");

  // A third student, dealt a paper later, who stands in for "a student this set was
  // never given" and for the time-limit test.
  const carol = await req("POST", "/auth/register", { name: "Carol Student", email: "carol@student.com", password: "student123" }, teacherToken);
  check("a third student exists to be left out of", carol.status === 201, JSON.stringify(carol.data));
  const carolId: string = carol.data?.user?.id;
  const carolLogin = await req("POST", "/auth/login", { email: "carol@student.com", password: "student123" });
  check("and can log in", carolLogin.status === 200);
  const carolToken: string = carolLogin.data.token;

  const paperFor = (token: string) => req("GET", `/api/exam-sets/${setId}`, undefined, token);
  const questionOrder = (data: { questions: { id: string }[] }) => JSON.stringify(data.questions.map((q) => q.id));
  const optionOrder = (data: { questions: { id: string; options: { id: string }[] }[] }) =>
    JSON.stringify(data.questions.map((q) => [q.id, q.options.map((o) => o.id)]));

  const paper = await paperFor(studentToken2);
  check("the student is handed their paper", paper.status === 200 && paper.data?.questions?.length === 8, JSON.stringify(paper.data)?.slice(0, 300));
  check("it starts the attempt and says so", paper.data?.state === "started" && !!paper.data?.attemptId, JSON.stringify(paper.data?.state));
  check("the paper is worth the form's marks", paper.data?.maxGrade === 10, JSON.stringify(paper.data?.maxGrade));
  check(
    "the deadline is the set's time limit, measured from opening it",
    await (async () => {
      const created = new Date((await ExamAttempt.findById(paper.data?.attemptId))?.createdAt ?? 0).getTime();
      const deadline = new Date(paper.data?.deadlineAt ?? 0).getTime();
      return Math.abs(deadline - created - 45 * 60_000) < 5_000;
    })()
  );

  const paperPayload = JSON.stringify(paper.data);
  check("the paper carries no answer key", !/correctOptionId|modelAnswer|rubric|explanation/.test(paperPayload), paperPayload.slice(0, 300));
  check("nor the form id or the blueprint", !/formId|blueprint/.test(paperPayload), paperPayload.slice(0, 300));
  check("no question carries an explanation field", paper.data.questions.every((q: Record<string, unknown>) => !("explanation" in q)));
  check("every question has an id, a type and a mark", paper.data.questions.every((q: Record<string, unknown>) => !!q.id && !!q.type && typeof q.maxPoints === "number"));
  check("MCQs come with options and short answers with none", (() => {
    const mcqs = paper.data.questions.filter((q: { type: string }) => q.type === "mcq");
    const shorts = paper.data.questions.filter((q: { type: string }) => q.type === "short");
    return mcqs.length === 6 && shorts.length === 2 && mcqs.every((q: { options: unknown[] }) => q.options.length === 4) && shorts.every((q: { options: unknown[] }) => q.options.length === 0);
  })());
  check(
    "the questions come in a different order from the stored form",
    await (async () => {
      const stored = (await ExamForm.findOne({ examSetId: setId, formLabel: paper.data?.formLabel }))?.questions?.map((q) => String(q._id));
      return stored ? JSON.stringify(stored) !== questionOrder(paper.data) : false;
    })(),
    `${paper.data?.formLabel}`
  );

  const savedOrder = questionOrder(paper.data);
  const savedOptions = optionOrder(paper.data);

  const emptyDraft = await req("PUT", `/api/exam-sets/${setId}/attempts/current`, { answers: [] }, studentToken2);
  check("a draft can be saved before anything is answered", emptyDraft.status === 200 && emptyDraft.data?.saved === true, JSON.stringify(emptyDraft.data));

  const firstMcq = paper.data.questions.find((q: { type: string }) => q.type === "mcq");
  const wrongMcq = paper.data.questions.filter((q: { type: string }) => q.type === "mcq" && q.id !== firstMcq.id)[0];
  const firstShort = paper.data.questions.find((q: { type: string }) => q.type === "short");
  const draftBody = {
    answers: [
      { questionId: firstMcq.id, chosenOptionId: "o1" },
      { questionId: wrongMcq.id, chosenOptionId: "o4" },
      { questionId: firstShort.id, textAnswer: "الزاوية الحادة أقل من تسعين درجة." },
    ],
  };
  const saved = await req("PUT", `/api/exam-sets/${setId}/attempts/current`, draftBody, studentToken2);
  check("answers save as a draft", saved.status === 200 && saved.data?.answers?.length === 3, JSON.stringify(saved.data)?.slice(0, 200));

  const resumed = await paperFor(studentToken2);
  check("reopening the exam resumes the same attempt", resumed.data?.state === "resumed" && resumed.data?.attemptId === paper.data?.attemptId, JSON.stringify(resumed.data?.state));
  check("with the questions in the same order", questionOrder(resumed.data) === savedOrder);
  check("and the options in the same order", optionOrder(resumed.data) === savedOptions);
  check("and the saved answers still there", resumed.data?.answers?.length === 3);
  check("a resumed paper still has no key", !/correctOptionId|modelAnswer|rubric|explanation/.test(JSON.stringify(resumed.data)));

  // Two students, one form: the whole point of the second shuffle layer.
  const bilalLogin = await req("POST", "/auth/login", { email: "bilal@student.com", password: "student123" });
  check("the second student can log in", bilalLogin.status === 200, JSON.stringify(bilalLogin.data)?.slice(0, 120));
  const bilalToken: string = bilalLogin.data.token;
  const ontoSameForm = await req("PATCH", `/api/exam-sets/${setId}/assignments/${secondStudentId}`, { formLabel: paper.data?.formLabel }, teacherToken);
  check("the second student can be put on the same paper", ontoSameForm.status === 200 && ontoSameForm.data?.formLabel === paper.data?.formLabel, JSON.stringify(ontoSameForm.data));
  const bilalPaper = await paperFor(bilalToken);
  check("the second student gets that paper", bilalPaper.status === 200 && bilalPaper.data?.formLabel === paper.data?.formLabel, JSON.stringify(bilalPaper.data)?.slice(0, 200));
  check("with the questions in a different order", questionOrder(bilalPaper.data) !== savedOrder, "same order for two students on one form");
  check("and the options in a different order", optionOrder(bilalPaper.data) !== savedOptions, "same option order for two students on one form");

  const notMySet = await paperFor(otherToken);
  check("a teacher cannot ask for a paper on a set they do not own", notMySet.status === 404, JSON.stringify(notMySet.data));
  const noSuchSet = await req("GET", "/api/exam-sets/000000000000000000000000", undefined, studentToken2);
  check("a set that does not exist is a 404", noSuchSet.status === 404);
  const unassignedSet = await paperFor(carolToken);
  check("a set this student was never given is a 404", unassignedSet.status === 404, JSON.stringify(unassignedSet.data));
  const unassignedAttempts = await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, carolToken);
  check("and no attempt list for it either", unassignedAttempts.status === 404, JSON.stringify(unassignedAttempts.data));

  const badOption = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [{ questionId: firstMcq.id, chosenOptionId: "nonsense" }] }, studentToken2);
  check("an option that is not on the question is refused", badOption.status === 400, JSON.stringify(badOption.data));
  const strayQuestion = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [{ questionId: "000000000000000000000000", chosenOptionId: "o1" }] }, studentToken2);
  check("a question from another paper is refused", strayQuestion.status === 400, JSON.stringify(strayQuestion.data));
  check("and a refused submission does not throw away the draft", (await ExamAttempt.findById(paper.data?.attemptId))?.status === "draft");
  const straySave = await req("PUT", `/api/exam-sets/${setId}/attempts/current`, { answers: [{ questionId: "000000000000000000000000", chosenOptionId: "o1" }] }, studentToken2);
  check("and a draft cannot be saved with one either", straySave.status === 400, JSON.stringify(straySave.data));

  const teacherSubmit = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [] }, teacherToken);
  check("a teacher cannot submit a paper", teacherSubmit.status === 403, JSON.stringify(teacherSubmit.data));
  const teacherDraft = await req("PUT", `/api/exam-sets/${setId}/attempts/current`, { answers: [] }, teacherToken);
  check("nor save one", teacherDraft.status === 403);

  const submitted = await req("POST", `/api/exam-sets/${setId}/attempts`, draftBody, studentToken2);
  check("the paper submits", submitted.status === 200, JSON.stringify(submitted.data)?.slice(0, 300));
  check("the MCQ half is scored straight away", submitted.data?.attempt?.mcqScore === 1, JSON.stringify(submitted.data?.attempt?.mcqScore));
  check("with no Gemini key the short answer waits for a teacher, and says so", submitted.data?.attempt?.shortScore === 0 && submitted.data?.attempt?.needsReview === true, JSON.stringify(submitted.data?.attempt?.needsReview));
  check("and the submit still succeeds rather than failing the paper", submitted.data?.attempt?.status === "graded");
  check("the total reflects only what could be scored", submitted.data?.attempt?.percent === 10, JSON.stringify(submitted.data?.attempt?.percent));
  check("the uncertainty is recorded on the answer", (() => {
    const short = submitted.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstShort.id);
    return short?.aiScore === 0 && short?.aiConfidence === "low";
  })());
  check("the result comes back in the order the student saw it", questionOrder(submitted.data.attempt) === savedOrder);
  check("the result finally carries the key it withheld", (() => {
    const row = submitted.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstMcq.id);
    return row?.correctOptionId === "o1" && row?.isCorrect === true && !!row?.explanation;
  })());
  check("and the model answer and rubric for a short one", (() => {
    const row = submitted.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstShort.id);
    return row?.modelAnswer === "الزاوية الحادة أقل من تسعين درجة." && row?.rubric?.length === 2;
  })());
  check("and the student's own text", submitted.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstShort.id)?.textAnswer === "الزاوية الحادة أقل من تسعين درجة.");
  check("an unanswered MCQ is simply wrong, not missing", (() => {
    const row = submitted.data?.attempt?.questions?.find(
      (q: { id: string; type: string }) => q.type === "mcq" && q.id !== firstMcq.id && q.id !== wrongMcq.id
    );
    return row?.isCorrect === false && row?.chosenOptionId === null;
  })());
  check("and the wrong MCQ is marked wrong", submitted.data?.attempt?.questions?.find((q: { id: string }) => q.id === wrongMcq.id)?.isCorrect === false);

  const polled = await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, studentToken2);
  check("the result can be polled back", polled.status === 200 && polled.data?.status === "graded" && polled.data?.attempt?.percent === 10, JSON.stringify(polled.data)?.slice(0, 200));
  check("another student on the same paper cannot read my attempt", (await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, bilalToken)).status === 404);
  check("nor another teacher", (await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, otherToken)).status === 403);
  check("nor a teacher through the student route", (await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, teacherToken)).status === 403);
  check("and the owner can read their own attempt back again", (await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, studentToken2)).status === 200);

  const afterSubmit = await paperFor(studentToken2);
  check("asking for the paper again gives the result, not a new paper", afterSubmit.data?.state === "already_submitted" && afterSubmit.data?.attempt?.percent === 10, JSON.stringify(afterSubmit.data?.state));
  check("a submitted paper cannot be submitted again", (await req("POST", `/api/exam-sets/${setId}/attempts`, draftBody, studentToken2)).status === 404);
  check("nor have its draft saved over", (await req("PUT", `/api/exam-sets/${setId}/attempts/current`, draftBody, studentToken2)).status === 404);

  const mine = await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, studentToken2);
  check("my attempts are listed with the best score", mine.status === 200 && mine.data?.bestPercent === 10 && mine.data?.attempts?.length === 1, JSON.stringify(mine.data)?.slice(0, 200));
  check("and the set allows one sitting, so none are left", mine.data?.attemptsLeft === 0, JSON.stringify(mine.data?.attemptsLeft));
  check("with nothing left, the paper route serves the result rather than an error", (await paperFor(studentToken2)).data?.state === "already_submitted");
  const spent = await paperFor(studentToken2);
  check("and says in that payload whether the last sitting passed", spent.data?.passed === false, JSON.stringify(spent.data?.passed));
  check("the list carries no question content", !/correctOptionId|modelAnswer|"prompt"/.test(JSON.stringify(mine.data)));
  const bilalAttempts = await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, bilalToken);
  check("another student's list is their own, holding only the draft they opened", bilalAttempts.status === 200 && bilalAttempts.data?.bestPercent === 0 && bilalAttempts.data?.hasDraft === true && bilalAttempts.data?.attempts?.every((a: { status: string }) => a.status === "draft"), JSON.stringify(bilalAttempts.data)?.slice(0, 200));
  check("a teacher's is not readable at all", (await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, otherToken)).status === 403);

  // A submitted attempt must not stand in the way of a fresh one: raising the cap is
  // allowed mid-flight, since it only governs sittings that have not started.
  const raiseCap = await req("PUT", `/api/exam-sets/${setId}`, { maxAttempts: 2 }, teacherToken);
  check("the cap can be raised while the exam is live", raiseCap.status === 200 && raiseCap.data?.maxAttempts === 2, JSON.stringify(raiseCap.data?.maxAttempts));
  const secondSitting = await paperFor(studentToken2);
  check("so a second sitting starts, on a new attempt", secondSitting.status === 200 && secondSitting.data?.state === "started" && secondSitting.data?.attemptId !== paper.data?.attemptId, JSON.stringify(secondSitting.data?.attemptId));
  check("carrying the previous result and the attempts left", secondSitting.data?.previousPercent === 10 && secondSitting.data?.attemptsLeft === 1, JSON.stringify([secondSitting.data?.previousPercent, secondSitting.data?.attemptsLeft]));
  check("on a freshly shuffled paper", questionOrder(secondSitting.data) !== questionOrder(paper.data));
  check("and the first result is still there to read", (await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, studentToken2)).data?.attempt?.percent === 10);
  check("and both are listed", (await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, studentToken2)).data?.attempts?.length === 2);
  const abandon = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [] }, studentToken2);
  check("handing the retry in blank still records an attempt, at zero", abandon.status === 200 && abandon.data?.attempt?.totalScore === 0, JSON.stringify(abandon.data)?.slice(0, 200));

  // The time limit runs on the attempt, not on the set: a draft whose own clock has
  // run out is closed even though the set is still open.
  const dealCarol = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  check("publishing again deals the new student a paper", dealCarol.status === 200 && (await ExamAssignment.countDocuments({ examSetId: setId, studentId: carolId })) === 1, JSON.stringify(dealCarol.data?.assignments));
  const carolPaper = await paperFor(carolToken);
  check("and she can open it", carolPaper.status === 200 && carolPaper.data?.state === "started", JSON.stringify(carolPaper.data)?.slice(0, 200));
  // Mongoose owns createdAt and will not let a normal update move it, so the clock
  // is wound back through the raw collection rather than by waiting 45 minutes.
  // Past 45 + the submit grace, so this is outside every window, not just one.
  await ExamAttempt.collection.updateOne(
    { _id: new Types.ObjectId(String(carolPaper.data?.attemptId)) },
    { $set: { createdAt: new Date(Date.now() - 48 * 60_000) } }
  );
  const lapsed = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [] }, carolToken);
  check("a draft past its own time limit cannot be submitted", lapsed.status === 409, `status=${lapsed.status}`);
  const lapsedReopen = await paperFor(carolToken);
  check("nor reopened", lapsedReopen.status === 409, `status=${lapsedReopen.status}`);
  const lapsedSave = await req("PUT", `/api/exam-sets/${setId}/attempts/current`, { answers: [] }, carolToken);
  check("nor saved to", lapsedSave.status === 409, `status=${lapsedSave.status}`);
  // Inside the grace a submit in flight when the clock runs out is still counted.
  await ExamAttempt.collection.updateOne(
    { _id: new Types.ObjectId(String(carolPaper.data?.attemptId)) },
    { $set: { createdAt: new Date(Date.now() - 45.5 * 60_000) } }
  );
  const inGrace = await req("POST", `/api/exam-sets/${setId}/attempts`, { answers: [] }, carolToken);
  check("but one sent the moment the clock ends is not thrown away", inGrace.status === 200 && inGrace.data?.attempt?.totalScore === 0, `status=${inGrace.status}`);
  check("while a live draft on the same set still works", (await req("PUT", `/api/exam-sets/${setId}/attempts/current`, { answers: [] }, bilalToken)).status === 200);

  // A teacher cannot move a student who is already holding a paper.
  const movedStarted = await req("PATCH", `/api/exam-sets/${setId}/assignments/${studentId}`, { formLabel: "C" }, teacherToken);
  check("a student who has started cannot be moved to another paper", movedStarted.status === 409, JSON.stringify(movedStarted.data));
  const thirdStarted = await req("PATCH", `/api/exam-sets/${setId}/assignments/${carolId}`, { formLabel: "B" }, teacherToken);
  check("not even one whose attempt has only been opened", thirdStarted.status === 409, JSON.stringify(thirdStarted.data));
  const startedRosterRows = await req("GET", `/api/exam-sets/${setId}/assignments`, undefined, teacherToken);
  check(
    "and the roster says who has started, and who has not",
    await (async () => {
      const rows = startedRosterRows.data?.rows ?? [];
      const withPapers = new Set((await ExamAttempt.find({ examSetId: setId }).distinct("studentId")).map(String));
      const of = (id: string) => rows.find((r: { studentId: string }) => r.studentId === id);
      return (
        of(studentId)?.hasStarted === true &&
        of(carolId)?.hasStarted === true &&
        of(secondStudentId)?.hasStarted === true &&
        rows.every((r: { studentId: string; hasStarted: boolean }) => r.hasStarted === withPapers.has(String(r.studentId)))
      );
    })(),
    JSON.stringify(startedRosterRows.data?.rows?.map((r: { name: string; hasStarted: boolean }) => [r.name, r.hasStarted]))
  );

  // A published paper is frozen, and unpublishing is the deliberate way out.
  const liveQuestionId = String((await ExamForm.findById(formIds.A))?.questions?.[0]?._id ?? "");
  check("form A still has questions to try to edit", liveQuestionId.length > 0);
  const editPublished = await req("PUT", `/api/exam-forms/${formIds.A}/questions/${liveQuestionId}`, { prompt: "محاولة تعديل بعد النشر" }, teacherToken);
  check("a published set cannot have its questions edited", editPublished.status === 409, JSON.stringify(editPublished.data));
  const genPublished = await req("POST", `/api/exam-sets/${setId}/forms/A`, undefined, teacherToken);
  check("nor be regenerated", genPublished.status === 409, JSON.stringify(genPublished.data));
  const delPublished = await req("DELETE", `/api/exam-sets/${setId}`, undefined, teacherToken);
  check("nor be deleted out from under the students", delPublished.status === 409);

  const unpublish = await req("PATCH", `/api/exam-sets/${setId}/status`, { status: "draft" }, teacherToken);
  check("unpublishing is allowed", unpublish.status === 200 && unpublish.data?.status === "draft");
  const editDraft = await req("PUT", `/api/exam-forms/${formIds.A}/questions/${liveQuestionId}`, { prompt: "ما ناتج جمع الكسرين التاليين؟" }, teacherToken);
  check("and then the questions can be edited again", editDraft.status === 200, JSON.stringify(editDraft.data));
  check("but the edit takes the review mark with it", editDraft.data?.form?.reviewedAt === null, JSON.stringify(editDraft.data?.form?.reviewedAt));
  const republishUnreviewed = await req("POST", `/api/exam-sets/${setId}/publish`, undefined, teacherToken);
  check("so it has to be reviewed again before it goes back out", republishUnreviewed.status === 409, JSON.stringify(republishUnreviewed.data));

  const closeSet = await req("PATCH", `/api/exam-sets/${setId}/status`, { status: "closed" }, teacherToken);
  check("a teacher can close a set", closeSet.status === 200 && closeSet.data?.status === "closed");
  const afterClose = await req("GET", "/api/exam-sets", undefined, studentToken2);
  check("a closed set disappears from the student list", afterClose.data?.length === 0, JSON.stringify(afterClose.data));
  const reopen = await req("PATCH", `/api/exam-sets/${setId}/status`, { status: "published" }, teacherToken);
  check("but it cannot be republished through the status route", reopen.status === 400, JSON.stringify(reopen.data));
  const badStatus = await req("PATCH", `/api/exam-sets/${setId}/status`, { status: "invented" }, teacherToken);
  check("and an invented status is refused", badStatus.status === 400);

  const expiredSet = await req("PUT", `/api/exam-sets/${setId}`, { openUntil: new Date(Date.now() - 86_400_000).toISOString() }, teacherToken);
  check("an open-until date can be set", expiredSet.status === 200, JSON.stringify(expiredSet.data));
  check("and a change that says nothing about the clock leaves the clock alone", expiredSet.data?.timeLimitMinutes === 45, JSON.stringify(expiredSet.data?.timeLimitMinutes));
  for (const label of ["A", "B", "C"]) {
    await req("POST", `/api/exam-forms/${formIds[label]}/review`, undefined, teacherToken);
  }
  const expired = await req("POST", `/api/exam-sets/${setId}/publish`, { openUntil: new Date(Date.now() - 86_400_000).toISOString() }, teacherToken);
  check("an already-lapsed window can be published", expired.status === 200, JSON.stringify(expired.data));
  const afterExpiry = await req("GET", "/api/exam-sets", undefined, studentToken2);
  check("and is then hidden from students", afterExpiry.data?.length === 0, JSON.stringify(afterExpiry.data));

  // Back to a draft so this set can be deleted by the cleanup below.
  const unpublishForCleanup = await req("PATCH", `/api/exam-sets/${setId}/status`, { status: "draft" }, teacherToken);
  check("it can be unpublished again", unpublishForCleanup.status === 200 && unpublishForCleanup.data?.status === "draft");

  console.log("13. The teacher's results matrix and a hand-set mark");
  const results = await req("GET", `/api/exam-sets/${setId}/results`, undefined, teacherToken);
  check("the owning teacher can read the class at a glance", results.status === 200, JSON.stringify(results.data)?.slice(0, 200));
  const rows = (results.data?.rows ?? []) as Array<Record<string, any>>;
  const rowFor = (id: string) => rows.find((r) => r.studentId === id);
  check("one row per student, and never twice for the same one", rows.length >= 4 && new Set(rows.map((r) => r.studentId)).size === rows.length, JSON.stringify(rows.map((r) => r.name)));
  check("including the students who have never opened it", rows.some((r) => r.status === "not_started" && r.attemptId === null));
  check("the one holding an open paper is marked as still going", (() => {
    const row = rowFor(secondStudentId);
    return row?.status === "draft" && row?.attemptId === bilalPaper.data?.attemptId;
  })(), JSON.stringify(rowFor(secondStudentId)));
  check("and a student who has sat twice gets their latest mark and their best", (() => {
    const row = rowFor(studentId);
    return row?.status === "graded" && row?.sittings === 2 && row?.bestPercent === 10 && row?.percent === 0;
  })(), JSON.stringify(rowFor(studentId)));
  check("with the paper they are holding named on the row", rowFor(studentId)?.formLabel === paper.data?.formLabel, JSON.stringify(rowFor(studentId)?.formLabel));
  check("per paper, so a form that came out unfairly hard is visible", (() => {
    const stats = results.data?.forms ?? [];
    const sat = stats.find((f: { formLabel: string }) => f.formLabel === paper.data?.formLabel);
    return stats.length === 3 && sat?.sat >= 1 && typeof sat?.averagePercent === "number";
  })(), JSON.stringify(results.data?.forms));
  check("the written answer the model was unsure of is queued for a human", (() => {
    const item = results.data?.pending?.find((p: { attemptId: string }) => p.attemptId === paper.data?.attemptId);
    return item?.questionId === firstShort.id && item?.aiConfidence === "low" && item?.studentName?.length > 0;
  })(), JSON.stringify(results.data?.pending)?.slice(0, 300));
  check("carrying the student's text, the model answer and the rubric to judge it by", (() => {
    const item = results.data?.pending?.find((p: { attemptId: string }) => p.attemptId === paper.data?.attemptId);
    return item?.textAnswer === "الزاوية الحادة أقل من تسعين درجة." && item?.modelAnswer === "الزاوية الحادة أقل من تسعين درجة." && item?.rubric?.length === 2;
  })());
  check("a student cannot read the class results", (await req("GET", `/api/exam-sets/${setId}/results`, undefined, studentToken2)).status === 403);
  check("nor can another teacher", (await req("GET", `/api/exam-sets/${setId}/results`, undefined, otherToken)).status === 404);

  const markBody = { questionId: firstShort.id, teacherScore: 2, teacherFeedback: "Close, but state the bound." };
  const studentMark = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, markBody, studentToken2);
  check("a student cannot mark their own paper", studentMark.status === 403, JSON.stringify(studentMark.data));
  const otherMark = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, markBody, otherToken);
  check("nor can a teacher who does not own the set", otherMark.status === 404, JSON.stringify(otherMark.data));
  const draftMark = await req("PUT", `/api/exam-attempts/${bilalPaper.data?.attemptId}/grade`, markBody, teacherToken);
  check("and a paper that is still open cannot be marked", draftMark.status === 409, JSON.stringify(draftMark.data));
  const mcqMark = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, { questionId: firstMcq.id, teacherScore: 1 }, teacherToken);
  check("nor a multiple-choice answer, which the key already settles", mcqMark.status === 400, JSON.stringify(mcqMark.data));
  const blankMark = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, { questionId: "000000000000000000000000", teacherScore: 1 }, teacherToken);
  check("nor a question that is not on the paper", blankMark.status === 400, JSON.stringify(blankMark.data));

  const marked = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, markBody, teacherToken);
  check("the owning teacher can mark a written answer", marked.status === 200 && marked.data?.changed === true, JSON.stringify(marked.data)?.slice(0, 200));
  check("the short half carries the mark, not the model's", marked.data?.attempt?.shortScore === 2, JSON.stringify(marked.data?.attempt?.shortScore));
  check("so the total is MCQ + the teacher's mark", marked.data?.attempt?.totalScore === 3, JSON.stringify(marked.data?.attempt?.totalScore));
  check("and the percent moves with it", marked.data?.attempt?.percent === 30, JSON.stringify(marked.data?.attempt?.percent));
  check("the answer is stamped as hand-marked, with the note", (() => {
    const row = marked.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstShort.id);
    return row?.overriddenByTeacher === true && row?.aiScore === 2 && row?.aiFeedback === "Close, but state the bound.";
  })());
  check("and the attempt is no longer waiting for a teacher", marked.data?.attempt?.needsReview === false, JSON.stringify(marked.data?.attempt?.needsReview));
  check("so it leaves the queue", !(await req("GET", `/api/exam-sets/${setId}/results`, undefined, teacherToken)).data?.pending?.some((p: { attemptId: string; questionId: string }) => p.attemptId === paper.data?.attemptId && p.questionId === firstShort.id));
  const studentSees = await req("GET", `/api/exam-attempts/${paper.data?.attemptId}`, undefined, studentToken2);
  check("the student sees the corrected mark on their own result", studentSees.data?.attempt?.percent === 30, JSON.stringify(studentSees.data?.attempt?.percent));
  check("and no longer sees the warning", studentSees.data?.attempt?.needsReview === false, JSON.stringify(studentSees.data?.needsReview));
  check("while their own best of the two sittings is unchanged", (await req("GET", `/api/exam-sets/${setId}/attempts`, undefined, studentToken2)).data?.bestPercent === 30);
  check("marking it the same again changes nothing", (await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, markBody, teacherToken)).data?.changed === false);

  const cleared = await req("PUT", `/api/exam-attempts/${paper.data?.attemptId}/grade`, { questionId: firstShort.id, teacherScore: null }, teacherToken);
  check("clearing the hand-set mark hands the answer back to the model", cleared.status === 200 && cleared.data?.changed === true, JSON.stringify(cleared.data)?.slice(0, 200));
  check("so the short half drops back to what the model said", cleared.data?.attempt?.shortScore === 0 && cleared.data?.attempt?.percent === 10, JSON.stringify([cleared.data?.attempt?.shortScore, cleared.data?.attempt?.percent]));
  check("and it is back in the queue, because the model was still unsure", (() => {
    const item = cleared.data?.attempt?.questions?.find((q: { id: string }) => q.id === firstShort.id);
    return item?.overriddenByTeacher === false && cleared.data?.attempt?.needsReview === true;
  })());
  check("and waiting for a teacher again on the class screen", (await req("GET", `/api/exam-sets/${setId}/results`, undefined, teacherToken)).data?.pending?.some((p: { attemptId: string; questionId: string }) => p.attemptId === paper.data?.attemptId && p.questionId === firstShort.id));

  console.log("13b. Points, badges and the leaderboard after an AI exam");
  const aiProfile = await req("GET", "/api/students/me", undefined, studentToken2);
  const aiPoints = aiProfile.data?.points;
  check("a generated exam counts towards the student's points", aiPoints?.aiExams?.earned > 0, JSON.stringify(aiPoints));
  check("against the paper's own maximum", aiPoints?.aiExams?.possible > 0);
  check("and the total is at least the exam on its own", aiPoints?.total?.earned >= aiPoints?.aiExams?.earned, JSON.stringify(aiPoints?.total));
  // This student sat the set twice (section 13 checked `sittings === 2`). The
  // bucket is denominated against one paper, not two.
  const paperMax = rowFor(studentId)?.maxGrade ?? 0;
  check("a re-sit does not inflate the denominator", paperMax > 0 && aiPoints?.aiExams?.possible === paperMax, JSON.stringify([aiPoints?.aiExams, paperMax]));

  const openPaperProfile = await req("GET", "/api/students/me", undefined, bilalToken);
  check("but a paper still open earns nothing yet", openPaperProfile.data?.points?.aiExams?.earned === 0, JSON.stringify(openPaperProfile.data?.points?.aiExams));

  const aiBadges = await req("GET", "/api/me/badges", undefined, studentToken2);
  check("the generated-exam badges are in the catalogue", (() => {
    const all = [...(aiBadges.data?.earned ?? []), ...(aiBadges.data?.locked ?? [])];
    return all.some((b: { id: string }) => b.id === "ai_exam_90") && all.some((b: { id: string }) => b.id === "ai_exam_perfect");
  })(), JSON.stringify([...(aiBadges.data?.earned ?? []), ...(aiBadges.data?.locked ?? [])].map((b: { id: string }) => b.id)));
  check("no AI badge yet, because the paper was not good enough", (aiBadges.data?.earned ?? []).every((b: { id: string }) => !b.id.startsWith("ai_exam_")), JSON.stringify((aiBadges.data?.earned ?? []).map((b: { id: string }) => b.id)));
  check("the manual 90% badge is unaffected by the AI work", (aiBadges.data?.earned ?? []).some((b: { id: string }) => b.id === "exam_90"), JSON.stringify((aiBadges.data?.earned ?? []).map((b: { id: string }) => b.id)));

  const aiBoard = await req("GET", "/api/leaderboard?limit=50", undefined, studentToken2);
  check("the leaderboard carries the generated exam's points", (() => {
    const row = (aiBoard.data ?? []).find((e: { name: string }) => e.name.includes("Amina"));
    return !!row && row.earned >= (aiPoints?.aiExams?.earned ?? 0);
  })(), JSON.stringify(aiBoard.data));

  console.log("14. Exam set cleanup");
  const delSet = await req("DELETE", `/api/exam-sets/${setId}`, undefined, teacherToken);
  check("teacher deletes an exam set", delSet.status === 204);
  const goneSet = await req("GET", `/api/exam-sets/${setId}`, undefined, teacherToken);
  check("deleted set is gone", goneSet.status === 404);
  check("its forms go with it", (await ExamForm.countDocuments({ examSetId: setId })) === 0);
  check("and the papers dealt from it", (await ExamAssignment.countDocuments({ examSetId: setId })) === 0);
  check("and the attempts sat on them", (await ExamAttempt.countDocuments({ examSetId: setId })) === 0);
  const goneForm = await req("POST", `/api/exam-forms/${formId}/verify`, undefined, teacherToken);
  check("its forms cannot be reached afterwards", goneForm.status === 404, JSON.stringify(goneForm.data));
  const goneRoster = await req("GET", `/api/exam-sets/${setId}/assignments`, undefined, teacherToken);
  check("nor its roster", goneRoster.status === 404);
  const goneList = await req("GET", "/api/exam-sets", undefined, studentToken2);
  check("and a deleted set is not offered to students", goneList.data?.length === 0, JSON.stringify(goneList.data));

  console.log("15. Book cleanup");
  const delBook = await req("DELETE", `/api/books/${bookId}`, undefined, teacherToken);
  check("teacher deletes a book", delBook.status === 204);
  const goneBook = await req("GET", `/api/books/${bookId}`, undefined, teacherToken);
  check("deleted book is gone", goneBook.status === 404);
  const orphanPages = await req("GET", `/api/books/${bookId}/pages`, undefined, teacherToken);
  check("deleted book has no pages", orphanPages.status === 404);

  server.close();
  await mongod.stop();

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E test crashed:", err);
  process.exit(1);
});