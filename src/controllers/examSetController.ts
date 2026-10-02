import { Response } from "express";
import { Book } from "../models/Book";
import { ExamAssignment, type IExamAssignment } from "../models/ExamAssignment";
import { ExamAttempt, type IExamAttempt } from "../models/ExamAttempt";
import { ExamSet, type IExamSet } from "../models/ExamSet";
import { ExamForm, computeMaxGrade, type IExamForm, type IExamQuestion } from "../models/ExamForm";
import { User } from "../models/User";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { assertAiConfigured } from "../services/ai/gemini";
import { generateBlueprint } from "../services/exams/blueprint";
import { generateForm, promptsOfOtherForms, saveForm } from "../services/exams/formGenerator";
import { rewriteQuestion, verifyAndRepair, type VerifyResult } from "../services/exams/verify";
import { loadRangePages, type RangePages } from "../services/exams/pages";
import { assertWithinGenerationBudget } from "../services/exams/generationLimit";
import { hasStartedAttempt, studentsWhoStarted } from "./attemptController";
import {
  existingLabelsByStudent,
  loadAssignableStudents,
  planBalancedAssignment,
  saveAssignments,
} from "../services/exams/assignment";
import {
  applyTeacherEdit,
  clampInt,
  coerceDifficulty,
  coverageOf,
  formLabels,
  isFormLabel,
  type TeacherEdit,
  type VerifyIssue,
} from "../services/exams/questions";

/**
 * Teacher endpoints for the AI exam pipeline.
 *
 * Generation is client-driven: one request per step (blueprint, then a form, then
 * verify) rather than one long call, because a request has to finish inside the
 * serverless time limit. Each step is therefore safe to retry — the blueprint is
 * overwritten, a form is upserted by label — and each is rate limited so a retry
 * loop cannot drain the Gemini quota.
 *
 * These routes are teacher-only. The answer key is returned here on purpose,
 * because the review screen needs to show which option is right; the
 * student-facing reader arrives in Phase 4 and strips it.
 */

function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function teacherId(req: AuthRequest): string {
  return String(req.user!._id);
}

/**
 * Read a whole number from the body, or say why it is unusable.
 *
 * Used for the page range, where silently "fixing" a teacher's input would mean
 * quietly building the exam from different pages than the ones on screen. The
 * question counts below are clamped instead, because a cap there is harmless.
 */
function intField(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false; error: string } {
  if (body[key] === undefined || body[key] === null || body[key] === "") {
    return { ok: true, value: fallback };
  }
  const n = Math.trunc(Number(body[key]));
  if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
  if (n < min || n > max) {
    return { ok: false, error: `${key} must be between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

/**
 * Map a thrown error onto a status the UI can act on. The quota throttle and the
 * "no API key" case carry their own meaning; a validation problem is the
 * teacher's to fix; anything else is the model failing on us.
 */
function errorStatus(err: unknown): number {
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 429) return 429;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/GEMINI_API_KEY|not configured/i.test(message)) return 503;
  if (/is required|must not be|blueprint|page range|at least one question/i.test(message)) return 400;
  return 502;
}

async function loadSet(req: AuthRequest, id: string): Promise<IExamSet | null> {
  return ExamSet.findOne({ _id: id, teacherId: teacherId(req) });
}

/** Load the page text for a set's range; refuses to work on an empty range. */
function rangeFor(set: IExamSet): Promise<RangePages> {
  return loadRangePages(String(set.bookId), set.pageFrom, set.pageTo);
}

/* -------------------------------------------------------------------------- */
/* Create / read                                                               */
/* -------------------------------------------------------------------------- */

/** POST /api/exam-sets — a draft with no AI work done yet. */
export async function createExamSet(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const body = (req.body ?? {}) as Record<string, unknown>;

    const title = String(body.title ?? "").trim();
    if (!title) return fail(res, 400, "title is required");

    const book = await Book.findOne({ _id: body.bookId, teacherId: teacherId(req) });
    if (!book) return fail(res, 404, "Book not found");
    if (book.status !== "ready") {
      return fail(
        res,
        409,
        book.status === "needs_transcription"
          ? "This book still needs its pages transcribed. Finish that on the Books page first."
          : `This book is not ready (status: ${book.status})`
      );
    }

    const from = intField(body, "pageFrom", 1, 1, book.pageCount);
    if (!from.ok) return fail(res, 400, from.error);
    // The lower bound is `pageFrom`, so a backwards range is reported as such
    // rather than quietly narrowed to a single page.
    const to = intField(body, "pageTo", from.value, from.value, book.pageCount);
    if (!to.ok) return fail(res, 400, to.error);

    const pageFrom = from.value;
    const pageTo = to.value;

    const mcqCount = clampInt(body.mcqCount, 0, 20, 8);
    const shortCount = clampInt(body.shortCount, 0, 10, 2);
    if (mcqCount + shortCount < 1) return fail(res, 400, "An exam needs at least one question");

    const set = await ExamSet.create({
      teacherId: teacherId(req),
      bookId: book._id,
      title,
      ...(body.weekLabel ? { weekLabel: String(body.weekLabel).trim() } : {}),
      ...(body.lessonRef ? { lessonRef: String(body.lessonRef).trim() } : {}),
      pageFrom,
      pageTo,
      difficulty: coerceDifficulty(body.difficulty),
      mcqCount,
      shortCount,
      formCount: clampInt(body.formCount, 2, 4, 3),
      verifyOnGenerate: body.verifyOnGenerate !== false,
      ...(body.timeLimitMinutes
        ? { timeLimitMinutes: clampInt(body.timeLimitMinutes, 1, 300, 60) }
        : {}),
      passPercent: clampInt(body.passPercent, 0, 100, 50),
      maxAttempts: clampInt(body.maxAttempts, 1, 10, 1),
      status: "draft",
    });

    res.status(201).json(serializeSet(set, null));
  } catch (err) {
    console.error("createExamSet error:", err);
    return fail(res, 500, err instanceof Error ? err.message : "Server error");
  }
}

/** GET /api/exam-sets */
export async function listExamSets(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const sets = await ExamSet.find({ teacherId: teacherId(req) })
      .sort({ createdAt: -1 })
      .limit(100);

    // One aggregation instead of a query per set: the list screen shows how many
    // forms are built, what a paper is worth, and how many questions still need a
    // teacher's eye.
    const stats = await ExamForm.aggregate([
      { $match: { examSetId: { $in: sets.map((s) => s._id) } } },
      {
        $group: {
          _id: "$examSetId",
          forms: { $sum: 1 },
          maxGrade: { $max: "$maxGrade" },
          questions: { $sum: { $size: { $ifNull: ["$questions", []] } } },
          flagged: {
            $sum: {
              $size: {
                $ifNull: [
                  {
                    $filter: {
                      input: { $ifNull: ["$questions", []] },
                      cond: { $eq: ["$$this.verify.status", "flagged"] },
                    },
                  },
                  [],
                ],
              },
            },
          },
        },
      },
    ]);
    const bySet = new Map(stats.map((s) => [String(s._id), s]));

    // Book titles come from one lookup rather than a populate per set, so the list
    // can name its source book without N extra queries.
    const books = await Book.find({ _id: { $in: sets.map((s) => s.bookId) } })
      .select("title pageCount charCount ocrUsed status")
      .lean();
    const byBook = new Map(books.map((b) => [String(b._id), b]));

    res.json(
      sets.map((set) => {
        const stat = bySet.get(String(set._id));
        return {
          ...serializeSet(set, null),
          book: byBook.get(String(set.bookId)) ?? null,
          formsBuilt: stat?.forms ?? 0,
          maxGrade: stat?.maxGrade ?? 0,
          questions: stat?.questions ?? 0,
          flagged: stat?.flagged ?? 0,
        };
      })
    );
  } catch (err) {
    console.error("listExamSets error:", err);
    return fail(res, 500, "Server error");
  }
}

/** GET /api/exam-sets/:id — metadata, blueprint, and every form in full. */
export async function getExamSet(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const [book, forms] = await Promise.all([
      Book.findById(set.bookId).select("title pageCount charCount ocrUsed status").lean(),
      ExamForm.find({ examSetId: set._id }).sort({ formLabel: 1 }),
    ]);

    res.json({
      ...serializeSet(set, forms),
      book: book
        ? {
            _id: String(book._id),
            title: book.title,
            pageCount: book.pageCount,
            charCount: book.charCount,
            ocrUsed: book.ocrUsed,
            status: book.status,
          }
        : null,
    });
  } catch (err) {
    console.error("getExamSet error:", err);
    return fail(res, 500, "Server error");
  }
}

/** PUT /api/exam-sets/:id — metadata only; the page range freezes once generated. */
export async function updateExamSet(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.pageFrom !== undefined || body.pageTo !== undefined) {
      if (set.blueprint?.topics?.length) {
        return fail(
          res,
          409,
          "The page range cannot change once questions have been generated. Create a new exam set instead."
        );
      }
      const from = intField(body, "pageFrom", set.pageFrom, 1, 10_000);
      if (!from.ok) return fail(res, 400, from.error);
      const to = intField(body, "pageTo", set.pageTo, from.value, 10_000);
      if (!to.ok) return fail(res, 400, to.error);
      set.pageFrom = from.value;
      set.pageTo = to.value;
    }

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) return fail(res, 400, "title is required");
      set.title = title;
    }
    if (body.weekLabel !== undefined) set.weekLabel = String(body.weekLabel).trim();
    if (body.lessonRef !== undefined) set.lessonRef = String(body.lessonRef).trim();
    if (body.difficulty !== undefined) set.difficulty = coerceDifficulty(body.difficulty);
    if (body.mcqCount !== undefined) set.mcqCount = clampInt(body.mcqCount, 0, 20, set.mcqCount);
    if (body.shortCount !== undefined) set.shortCount = clampInt(body.shortCount, 0, 10, set.shortCount);
    if (body.formCount !== undefined) set.formCount = clampInt(body.formCount, 2, 4, set.formCount);
    if (body.verifyOnGenerate !== undefined) set.verifyOnGenerate = Boolean(body.verifyOnGenerate);
    if (body.passPercent !== undefined) {
      set.passPercent = clampInt(body.passPercent, 0, 100, set.passPercent);
    }
    if (body.maxAttempts !== undefined) {
      set.maxAttempts = clampInt(body.maxAttempts, 1, 10, set.maxAttempts);
    }
    // Only when the body says so: a PUT about the page range must not quietly
    // cancel the clock the teacher set. An explicit blank clears the limit.
    if (body.timeLimitMinutes !== undefined) {
      const raw = body.timeLimitMinutes;
      set.timeLimitMinutes =
        raw === null || raw === "" || raw === false
          ? undefined
          : clampInt(raw, 1, 300, 60);
    }
    if (body.openUntil !== undefined) {
      const date = body.openUntil ? new Date(String(body.openUntil)) : undefined;
      set.openUntil = date && !Number.isNaN(date.getTime()) ? date : undefined;
    }

    await set.save();
    const forms = await ExamForm.find({ examSetId: set._id }).sort({ formLabel: 1 });
    res.json(serializeSet(set, forms));
  } catch (err) {
    console.error("updateExamSet error:", err);
    return fail(res, 500, err instanceof Error ? err.message : "Server error");
  }
}

/** DELETE /api/exam-sets/:id — cascades to the forms. */
export async function deleteExamSet(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");
    if (set.status === "published") {
      return fail(res, 409, "Close this exam before deleting it — students may already have sat it");
    }

    await ExamForm.deleteMany({ examSetId: set._id });
    // A hand dealt to a student outlives the set it came from, so the assignment
    // has to go with it — otherwise the portal would offer a set that is gone. The
    // attempts go too: a result is meaningless without the paper it was scored
    // against, and the stored shuffle points at questions that are about to vanish.
    await ExamAssignment.deleteMany({ examSetId: set._id });
    await ExamAttempt.deleteMany({ examSetId: set._id });
    await set.deleteOne();
    res.status(204).end();
  } catch (err) {
    console.error("deleteExamSet error:", err);
    return fail(res, 500, "Server error");
  }
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

/** POST /api/exam-sets/:id/blueprint — Gemini call 1. */
export async function createBlueprint(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");
    // Re-reading the pages rewrites the topic list every form is held to, so a
    // published set is not frozen just for its questions.
    if (!assertNotPublished(set, res)) return;

    assertAiConfigured();
    assertWithinGenerationBudget(teacherId(req));

    const range = await rangeFor(set);
    const blueprint = await generateBlueprint(set, range);

    set.blueprint = { ...blueprint, createdAt: new Date() };
    await set.save();

    res.json({
      blueprint: set.blueprint,
      topics: blueprint.topics.length,
      summary: blueprint.summary,
      pagesUsed: range.pages.length,
      estimatedTokens: range.estimatedTokens,
    });
  } catch (err) {
    console.error("createBlueprint error:", err);
    return fail(res, errorStatus(err), err instanceof Error ? err.message : "Server error");
  }
}

/**
 * POST /api/exam-sets/:id/forms/:label — Gemini call for one form.
 *
 * The client calls this once per label so it can show real progress. Calling it
 * again for a label that already exists replaces that form, which is how a
 * teacher retries a paper they do not like.
 */
export async function createForm(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const label = String(req.params.label ?? "").toUpperCase();
    if (!isFormLabel(label) || !formLabels(set.formCount).includes(label)) {
      return fail(res, 400, `Form label must be one of ${formLabels(set.formCount).join(", ")}`);
    }
    // Checked before the quota and the API key: "you skipped a step" is a more
    // useful thing to say than "you are not configured", and it costs nothing.
    if (!set.blueprint?.topics?.length) {
      return fail(res, 400, "This exam set has no blueprint yet. Run the blueprint step first.");
    }
    if (!assertNotPublished(set, res)) return;

    assertAiConfigured();
    assertWithinGenerationBudget(teacherId(req));

    const range = await rangeFor(set);
    const alreadyUsed = await promptsOfOtherForms(String(set._id), label);
    const generated = await generateForm(set, label, range, alreadyUsed);

    let questions: IExamQuestion[] = await saveForm(String(set._id), label, generated.questions);

    let verify: VerifyResult | undefined;
    if (set.verifyOnGenerate) {
      const used = [...alreadyUsed, ...questions.map((q) => q.prompt)];
      const outcome = await verifyAndRepair(set, questions, range, used);
      questions = outcome.questions;
      await ExamForm.updateOne(
        { examSetId: set._id, formLabel: label },
        { $set: { questions, maxGrade: computeMaxGrade(questions), verifiedAt: new Date() } }
      );
      verify = outcome.result;
    }

    const form = await ExamForm.findOne({ examSetId: set._id, formLabel: label });
    const body: Record<string, unknown> = {
      form: serializeForm(form, set),
      diagnostics: {
        rejected: generated.rejected,
        duplicates: generated.duplicates,
        trimmed: generated.trimmed,
        ...(verify ? { repaired: verify.repaired, flagged: verify.flagged } : {}),
      },
      coverage: coverageOf(questions, set.blueprint?.topics ?? []),
    };

    // A short form is a failure, not a quiet partial result: the paper would
    // otherwise reach students with a question missing and a lower total grade.
    if (generated.missing.mcq > 0 || generated.missing.short > 0) {
      return res.status(502).json({
        ...body,
        message: `The model produced ${generated.missing.mcq} fewer multiple-choice and ${generated.missing.short} fewer short-answer questions than requested. Generate this form again.`,
      });
    }

    res.json(body);
  } catch (err) {
    console.error("createForm error:", err);
    return fail(res, errorStatus(err), err instanceof Error ? err.message : "Server error");
  }
}

/**
 * POST /api/exam-forms/:formId/verify — audit an existing form and repair what
 * failed. Separate from generation so it can be re-run after a round of edits.
 */
export async function verifyForm(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { form, set } = await loadFormAndSet(req, req.params.formId);
    if (!form || !set) return fail(res, 404, "Exam form not found");
    if (form.questions.length === 0) return fail(res, 409, "This form has no questions yet");
    if (!assertNotPublished(set, res)) return;

    assertAiConfigured();
    assertWithinGenerationBudget(teacherId(req));

    const range = await rangeFor(set);
    const siblings = await promptsOfOtherForms(String(set._id), form.formLabel);
    const used = [...siblings, ...form.questions.map((q) => q.prompt)];

    const outcome = await verifyAndRepair(set, form.questions, range, used);
    form.questions = outcome.questions as unknown as IExamForm["questions"];
    form.maxGrade = computeMaxGrade(form.questions);
    form.verifiedAt = new Date();
    // A repair rewrote the paper after a human read it, so the stamp goes. If
    // nothing needed repairing the paper is untouched and the stamp stands.
    if (outcome.result.repaired > 0) form.reviewedAt = undefined;
    await form.save();

    res.json({
      form: serializeForm(form, set),
      result: outcome.result,
      coverage: coverageOf(form.questions, set.blueprint?.topics ?? []),
    });
  } catch (err) {
    console.error("verifyForm error:", err);
    return fail(res, errorStatus(err), err instanceof Error ? err.message : "Server error");
  }
}

/* -------------------------------------------------------------------------- */
/* Review: edit / regenerate / delete one question                            */
/* -------------------------------------------------------------------------- */

/** PUT /api/exam-forms/:formId/questions/:qid */
export async function updateQuestion(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { form, set } = await loadFormAndSet(req, req.params.formId);
    if (!form || !set) return fail(res, 404, "Exam form not found");

    const question = form.questions.id(req.params.qid);
    if (!question) return fail(res, 404, "Question not found");
    if (!assertNotPublished(set, res)) return;

    const outcome = applyTeacherEdit(
      question,
      (req.body ?? {}) as TeacherEdit,
      {
        pageFrom: set.pageFrom,
        pageTo: set.pageTo,
        topics: (set.blueprint?.topics ?? []).map((t) => t.topic),
      }
    );
    if (!outcome.ok) return fail(res, 400, outcome.error);

    question.set({ ...outcome.question, editedByTeacher: true });
    question.markModified("options");
    question.markModified("rubric");

    form.maxGrade = computeMaxGrade(form.questions);
    form.status = "ready";
    // The paper just changed, so whatever a teacher had read about it no longer
    // describes it. Publishing asks again.
    form.reviewedAt = undefined;
    await form.save();

    res.json({ form: serializeForm(form, set) });
  } catch (err) {
    console.error("updateQuestion error:", err);
    return fail(res, 500, err instanceof Error ? err.message : "Server error");
  }
}

/**
 * POST /api/exam-forms/:formId/questions/:qid/regenerate — replace one question
 * with a fresh one from the same source pages, avoiding every prompt already used
 * in this set.
 */
export async function regenerateQuestion(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { form, set } = await loadFormAndSet(req, req.params.formId);
    if (!form || !set) return fail(res, 404, "Exam form not found");
    if (!set.blueprint?.topics?.length) {
      return fail(res, 409, "This exam set has no blueprint yet. Run the blueprint step first.");
    }

    const question = form.questions.id(req.params.qid);
    if (!question) return fail(res, 404, "Question not found");
    if (!assertNotPublished(set, res)) return;

    assertAiConfigured();
    assertWithinGenerationBudget(teacherId(req));

    const range = await rangeFor(set);
    const siblings = await promptsOfOtherForms(String(set._id), form.formLabel);
    const used = [
      ...siblings,
      ...form.questions.map((q) => q.prompt).filter((p) => p !== question.prompt),
    ];

    const body = (req.body ?? {}) as Record<string, unknown>;
    const issue: VerifyIssue = isVerifyIssue(body.issue) ? body.issue : "ambiguous";

    const replacement = await rewriteQuestion(
      set,
      question,
      issue,
      String(body.note ?? "").trim(),
      range,
      used
    );
    if (!replacement) {
      return fail(res, 502, "The model could not produce a usable replacement. Try again.");
    }

    question.set({ ...replacement, _id: question._id });
    question.markModified("options");
    question.markModified("rubric");
    form.maxGrade = computeMaxGrade(form.questions);
    form.verifiedAt = new Date();
    form.reviewedAt = undefined;
    await form.save();

    res.json({ form: serializeForm(form, set) });
  } catch (err) {
    console.error("regenerateQuestion error:", err);
    return fail(res, errorStatus(err), err instanceof Error ? err.message : "Server error");
  }
}

/** DELETE /api/exam-forms/:formId/questions/:qid */
export async function deleteQuestion(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { form, set } = await loadFormAndSet(req, req.params.formId);
    if (!form || !set) return fail(res, 404, "Exam form not found");

    const question = form.questions.id(req.params.qid);
    if (!question) return fail(res, 404, "Question not found");
    if (!assertNotPublished(set, res)) return;
    if (form.questions.length <= 1) {
      return fail(res, 409, "A form needs at least one question. Regenerate the form instead.");
    }

    form.questions.pull(question._id);
    form.maxGrade = computeMaxGrade(form.questions);
    form.reviewedAt = undefined;
    await form.save();

    res.json({ form: serializeForm(form, set) });
  } catch (err) {
    console.error("deleteQuestion error:", err);
    return fail(res, 500, err instanceof Error ? err.message : "Server error");
  }
}

/**
 * A published set is frozen.
 *
 * Once a paper is out there, a question is no longer a draft: a student may
 * already have answered it, and a regenerated question would silently rewrite the
 * thing their grade was marked against. Unpublishing is the deliberate way out.
 */
function assertNotPublished(set: IExamSet, res: Response): boolean {
  if (set.status === "published") {
    fail(res, 409, "Unpublish this exam set before changing it — students may already have sat it");
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Publish & assign                                                            */
/* -------------------------------------------------------------------------- */

export interface PublishBlocker {
  label: string;
  reason: string;
}

/**
 * Everything standing between a set and its students, in one list.
 *
 * Returned as a list rather than failing on the first problem, because the screen
 * that calls publish is a checklist and a teacher fixing a set wants to see the
 * whole of it at once — a short form, a form nobody has read, and a missing
 * blueprint should not take three round trips to discover.
 */
export function publishBlockers(
  set: { blueprint?: { topics?: unknown[] }; mcqCount: number; shortCount: number },
  forms: Array<{
    formLabel: string;
    questions: unknown[];
    reviewedAt?: Date;
    status: string;
  }>,
  labels: string[]
): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];

  if (!set.blueprint?.topics?.length) {
    blockers.push({ label: "blueprint", reason: "Run the blueprint step first" });
  }

  const byLabel = new Map(forms.map((f) => [f.formLabel, f]));
  const wanted = set.mcqCount + set.shortCount;

  for (const label of labels) {
    const form = byLabel.get(label);
    if (!form) {
      blockers.push({ label, reason: `Form ${label} has not been generated` });
      continue;
    }
    if (form.status === "generating") {
      blockers.push({ label, reason: `Form ${label} is still being generated` });
      continue;
    }
    if (form.questions.length < wanted) {
      blockers.push({
        label,
        reason: `Form ${label} has ${form.questions.length} of ${wanted} questions`,
      });
      continue;
    }
    // A verify pass is a machine check; the review stamp is a human one. Publishing
    // requires the human one, because that is the whole point of the review screen.
    if (!form.reviewedAt) {
      blockers.push({ label, reason: `Form ${label} has not been marked as reviewed` });
    }
  }

  return blockers;
}

/**
 * POST /api/exam-sets/:id/publish
 *
 * Publishes the set and deals a paper to every student. Existing assignments are
 * left alone, so sending this twice is safe: it tops up anyone who has no paper
 * yet and never reshuffles a hand that has already been dealt.
 */
export async function publishExamSet(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const labels = formLabels(set.formCount);
    const forms = await ExamForm.find({ examSetId: set._id }).sort({ formLabel: 1 });
    const blockers = publishBlockers(set, forms, labels);
    if (blockers.length > 0) {
      // The whole list goes back, so the review screen can show the checklist.
      return res.status(409).json({ message: "This exam set is not ready to publish", blockers });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.openUntil !== undefined) {
      const date = body.openUntil ? new Date(String(body.openUntil)) : undefined;
      set.openUntil = date && !Number.isNaN(date.getTime()) ? date : undefined;
    }

    set.status = "published";
    set.publishedAt = new Date();
    await set.save();

    const formIdsByLabel = new Map<string, string>(
      forms.map((f) => [f.formLabel, String(f._id)])
    );
    const [students, existing] = await Promise.all([
      loadAssignableStudents(),
      existingLabelsByStudent(String(set._id)),
    ]);
    const balance = planBalancedAssignment(students, labels, existing);
    const written = await saveAssignments(String(set._id), balance.plan, formIdsByLabel);

    res.json({
      set: serializeSet(set, forms),
      assignments: {
        students: students.length,
        written,
        kept: existing.size,
        skippedInactive: balance.skippedInactive,
        perForm: balance.perForm,
      },
    });
  } catch (err) {
    console.error("publishExamSet error:", err);
    return fail(res, 500, err instanceof Error ? err.message : "Server error");
  }
}

/** GET /api/exam-sets/:id/assignments — who has which paper. */
export async function listAssignments(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const forms = await ExamForm.find({ examSetId: set._id }).select("formLabel maxGrade").lean();
    const [rows, students] = await Promise.all([
      ExamAssignment.find({ examSetId: set._id })
        .sort({ formLabel: 1 })
        .lean<Array<{
          studentId: IExamAssignment["studentId"];
          formId: IExamAssignment["formId"];
          formLabel: string;
          source: string;
          assignedAt: Date;
        }>>(),
      loadAssignableStudents(),
    ]);
    const names = await User.find({ _id: { $in: students.map((s) => s.id) } })
      .select("name active")
      .lean();
    const byId = new Map(names.map((u) => [String(u._id), u]));
    const started = await studentsWhoStarted(String(set._id));

    const assigned = new Map(rows.map((r) => [String(r.studentId), r]));

    res.json({
      status: set.status,
      formLabels: formLabels(set.formCount),
      forms: forms.map((f) => ({
        formLabel: f.formLabel,
        maxGrade: f.maxGrade,
        students: rows.filter((r) => r.formLabel === f.formLabel).length,
      })),
      // Every student appears, assigned or not, so an unassigned name is visible
      // rather than silently missing from the roster.
      rows: students.map((student) => {
        const row = assigned.get(student.id);
        return {
          studentId: student.id,
          name: byId.get(student.id)?.name ?? "Unknown student",
          active: byId.get(student.id)?.active !== false,
          formId: row ? String(row.formId) : null,
          formLabel: row?.formLabel ?? null,
          source: row?.source ?? null,
          assignedAt: row?.assignedAt ?? null,
          // Shown so the roster can lock the picker for a paper that is already in
          // a student's hands; the override route refuses it either way.
          hasStarted: started.has(student.id),
        };
      }),
    });
  } catch (err) {
    console.error("listAssignments error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * GET /api/exam-sets/:id/results — the class at a glance, and the queue of written
 * answers waiting for a human.
 *
 * One row per student, not one per student × form: every student holds exactly one
 * paper, so a full matrix would be mostly empty cells and the interesting question —
 * "who still needs me, and what did they write?" — is answered by sorting on
 * `needsReview` first.
 *
 * The `pending` list is the part that makes the screen usable. A paper of forty
 * questions does not fit on a phone, and a teacher with a class of thirty is not
 * going to open thirty attempts to find the four answers the model was unsure about.
 * So the low-confidence, still-unmarked written answers come back in one flat list
 * with the text, the model's score, the model answer and the rubric attached.
 *
 * Every sitting is included, not just the best one: the newest is what a student
 * sees, and if they have sat it twice the teacher needs to see both to understand
 * why a mark moved.
 */
export async function listSetResults(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const [forms, students, attempts] = await Promise.all([
      ExamForm.find({ examSetId: set._id }).sort({ formLabel: 1 }).lean(),
      loadAssignableStudents(),
      ExamAttempt.find({ examSetId: set._id })
        .sort({ createdAt: -1 })
        .lean<Array<IExamAttempt>>(),
    ]);
    const names = await User.find({ _id: { $in: students.map((s) => s.id) } })
      .select("name email active")
      .lean();
    const byId = new Map(names.map((u) => [String(u._id), u]));

    const attemptsByStudent = new Map<string, IExamAttempt[]>();
    for (const a of attempts) {
      const key = String(a.studentId);
      const list = attemptsByStudent.get(key) ?? [];
      list.push(a);
      attemptsByStudent.set(key, list);
    }

    const formById = new Map(forms.map((f) => [String(f._id), f]));

    const rows = students.map((student) => {
      const mine = attemptsByStudent.get(student.id) ?? [];
      // Newest first, so `sittings[0]` is the mark the student is looking at.
      const ordered = [...mine].sort(
        (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
      );
      const latest = ordered[0] ?? null;
      const submitted = ordered.filter((a) => a.status !== "draft");
      return {
        studentId: student.id,
        name: byId.get(student.id)?.name ?? "Unknown student",
        email: byId.get(student.id)?.email ?? "",
        active: byId.get(student.id)?.active !== false,
        formLabel: formById.get(String(latest?.formId ?? ""))?.formLabel ?? null,
        status: latest ? latest.status : "not_started",
        attemptId: latest ? String(latest._id) : null,
        percent: latest?.percent ?? 0,
        totalScore: latest?.totalScore ?? 0,
        maxGrade: latest?.maxGrade ?? 0,
        needsReview: Boolean(latest?.needsReview),
        submittedAt: latest?.submittedAt ?? null,
        sittings: ordered.length,
        bestPercent: submitted.reduce((max, a) => Math.max(max, a.percent ?? 0), 0),
      };
    });

    // Per-paper averages, so a teacher can see that one form is unfairly hard.
    const formStats = forms.map((form) => {
      const sat = attempts.filter(
        (a) => String(a.formId) === String(form._id) && a.status !== "draft"
      );
      const percent = sat.length
        ? Math.round((sat.reduce((sum, a) => sum + (a.percent ?? 0), 0) / sat.length) * 10) / 10
        : 0;
      return {
        formId: String(form._id),
        formLabel: form.formLabel,
        maxGrade: form.maxGrade,
        sat: sat.length,
        averagePercent: percent,
      };
    });

    const pending: Array<Record<string, unknown>> = [];
    for (const attempt of attempts) {
      if (attempt.status === "draft") continue;
      const form = formById.get(String(attempt.formId));
      if (!form) continue;
      const byQuestion = new Map(form.questions.map((q) => [String(q._id), q]));
      const student = byId.get(String(attempt.studentId));
      for (const answer of attempt.answers ?? []) {
        const question = byQuestion.get(String(answer.questionId));
        if (!question || answer.type !== "short") continue;
        if (answer.teacherScore !== undefined) continue;
        if (answer.aiConfidence !== "low" && answer.aiScore !== undefined) continue;
        pending.push({
          attemptId: String(attempt._id),
          examSetId: String(set._id),
          studentId: String(attempt.studentId),
          studentName: student?.name ?? "Unknown student",
          formLabel: form.formLabel,
          questionId: String(answer.questionId),
          prompt: question.prompt,
          textAnswer: answer.textAnswer ?? "",
          aiScore: answer.aiScore ?? null,
          aiMax: answer.aiMax ?? question.maxPoints,
          aiFeedback: answer.aiFeedback ?? "",
          aiConfidence: answer.aiConfidence ?? null,
          modelAnswer: question.modelAnswer ?? "",
          rubric: question.rubric ?? [],
          maxPoints: question.maxPoints,
          submittedAt: attempt.submittedAt ?? null,
        });
      }
    }
    // Worst confidence first, then the least marks, so the queue is ordered by how
    // much a human is needed rather than by when it arrived.
    pending.sort((a, b) => {
      const conf = (v: unknown) => (v === "low" ? 0 : v === "medium" ? 1 : 2);
      return conf(a.aiConfidence) - conf(b.aiConfidence) || Number(a.aiScore ?? 0) - Number(b.aiScore ?? 0);
    });

    res.json({
      status: set.status,
      passPercent: set.passPercent ?? 0,
      maxAttempts: set.maxAttempts,
      forms: formStats,
      rows: rows.sort((a, b) => {
        if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
        if (a.status !== b.status) return a.status === "not_started" ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
      pending,
    });
  } catch (err) {
    console.error("listSetResults error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * PATCH /api/exam-sets/:id/assignments/:studentId — move one student to a paper.
 *
 * Refused while the student is deactivated, and refused for a form that belongs to
 * another set: both mistakes would be invisible later, when the student opens an
 * exam and finds a paper from someone else's set.
 *
 * Also refused once the student has opened the set. Their questions are shuffled and
 * written down the moment the paper is issued, so moving them now would leave a
 * result sitting against a paper they never saw — and a grade the teacher thinks is
 * for form B is really for form A. Unpublishing the set is the way out of that.
 */
export async function overrideAssignment(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const student = await User.findOne({ _id: req.params.studentId, role: "student" });
    if (!student) return fail(res, 404, "Student not found");
    if (student.active === false) {
      return fail(res, 409, "That student's account is deactivated. Reactivate it first.");
    }

    if (await hasStartedAttempt(String(set._id), String(student._id))) {
      return fail(
        res,
        409,
        "That student has already started this exam, so their paper cannot be changed. Unpublish the set first if you need to move them."
      );
    }

    const label = String((req.body as Record<string, unknown>)?.formLabel ?? "").toUpperCase();
    if (!isFormLabel(label) || !formLabels(set.formCount).includes(label)) {
      return fail(res, 400, "formLabel must be one of this set's forms");
    }
    const form = await ExamForm.findOne({ examSetId: set._id, formLabel: label });
    if (!form) return fail(res, 404, `Form ${label} has not been generated yet`);

    const row = await ExamAssignment.findOneAndUpdate(
      { examSetId: set._id, studentId: student._id },
      {
        $set: {
          formId: form._id,
          formLabel: label,
          source: "teacher",
          assignedAt: new Date(),
        },
        $setOnInsert: { examSetId: set._id, studentId: student._id },
      },
      { upsert: true, new: true }
    );

    res.json({
      studentId: String(student._id),
      formId: String(row!.formId),
      formLabel: row!.formLabel,
      source: row!.source,
      assignedAt: row!.assignedAt,
    });
  } catch (err) {
    console.error("overrideAssignment error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * PATCH /api/exam-sets/:id/status — pull a set back to a draft, or close it.
 *
 * Only ever reduces access. Going back to `published` has to go through
 * `POST /publish` so the review gate cannot be side-stepped.
 */
export async function setExamStatus(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const set = await loadSet(req, req.params.id);
    if (!set) return fail(res, 404, "Exam set not found");

    const wanted = String((req.body as Record<string, unknown>)?.status ?? "");
    if (wanted === "published") {
      return fail(res, 400, "Use the publish endpoint to publish this set");
    }
    if (wanted !== "draft" && wanted !== "closed") {
      return fail(res, 400, "status must be draft or closed");
    }
    if (set.status === wanted) {
      return res.json(serializeSet(set, null));
    }
    if (set.status === "published" && wanted === "draft") {
      // Papers already handed out keep their assignments; the set is simply no
      // longer listed for students, which is the point of unpublishing.
      console.warn(`exam set ${String(set._id)} unpublished by teacher ${teacherId(req)}`);
    }

    set.status = wanted;
    await set.save();
    res.json(serializeSet(set, null));
  } catch (err) {
    console.error("setExamStatus error:", err);
    return fail(res, 500, "Server error");
  }
}

/** POST /api/exam-forms/:formId/review — the teacher says they have read the form. */
export async function markFormReviewed(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { form, set } = await loadFormAndSet(req, req.params.formId);
    if (!form || !set) return fail(res, 404, "Exam form not found");
    if (form.questions.length === 0) {
      return fail(res, 409, "This form has no questions yet");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    form.reviewedAt = body.reviewed === false ? undefined : new Date();
    await form.save();
    res.json({ form: serializeForm(form, set) });
  } catch (err) {
    console.error("markFormReviewed error:", err);
    return fail(res, 500, "Server error");
  }
}

/* -------------------------------------------------------------------------- */
/* Student-facing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/exam-sets as a student: the sets they have been given a paper for.
 *
 * This is the only student-facing exam-set read in this phase, and it is built to
 * be safe by omission — no questions, no form id, no blueprint, no explanation and
 * above all no answer key. A set appears only if it is published, still open, and
 * actually assigned to this student, so an unassigned or closed set simply does not
 * exist as far as the portal is concerned.
 */
export async function listAvailableExamSets(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const studentId = String(req.user!._id);
    const now = new Date();

    const rows = await ExamAssignment.find({ studentId }).lean<Array<{
      examSetId: IExamAssignment["examSetId"];
      formLabel: string;
    }>>();
    const setIds = rows.map((r) => r.examSetId);
    if (setIds.length === 0) return res.json([]);

    const sets = await ExamSet.find({
      _id: { $in: setIds },
      status: "published",
      $or: [{ openUntil: { $exists: false } }, { openUntil: null }, { openUntil: { $gt: now } }],
    })
      .sort({ createdAt: -1 })
      .lean();

    if (sets.length === 0) return res.json([]);

    // The papers and their question counts, without loading any question content.
    const forms = await ExamForm.find({
      examSetId: { $in: sets.map((s) => s._id) },
      formLabel: { $in: rows.map((r) => r.formLabel) },
    })
      .select("examSetId formLabel maxGrade status questions")
      .lean();
    const formBySet = new Map(forms.map((f) => [`${String(f.examSetId)}:${f.formLabel}`, f]));
    const byStudent = new Map(rows.map((r) => [String(r.examSetId), r.formLabel]));

    res.json(
      sets.map((s) => {
        const label = byStudent.get(String(s._id)) ?? "";
        const form = formBySet.get(`${String(s._id)}:${label}`);
        return {
          _id: String(s._id),
          title: s.title,
          weekLabel: s.weekLabel,
          lessonRef: s.lessonRef,
          difficulty: s.difficulty,
          mcqCount: s.mcqCount,
          shortCount: s.shortCount,
          formCount: s.formCount,
          timeLimitMinutes: s.timeLimitMinutes,
          passPercent: s.passPercent,
          maxAttempts: s.maxAttempts,
          openUntil: s.openUntil ?? null,
          publishedAt: (s as unknown as { publishedAt?: Date }).publishedAt ?? null,
          formLabel: label,
          questionCount: form?.questions?.length ?? 0,
          maxGrade: form?.maxGrade ?? 0,
        };
      })
    );
  } catch (err) {
    console.error("listAvailableExamSets error:", err);
    return fail(res, 500, "Server error");
  }
}

/** GET /api/exam-sets — teachers see their sets, students see what they were given. */
export async function listExamSetsForCaller(req: AuthRequest, res: Response) {
  if (req.user?.role === "student") return listAvailableExamSets(req, res);
  return listExamSets(req, res);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const VERIFY_ISSUES: VerifyIssue[] = [
  "none",
  "ambiguous",
  "multiple_correct",
  "not_in_source",
  "bad_distractor",
];

function isVerifyIssue(value: unknown): value is VerifyIssue {
  return VERIFY_ISSUES.includes(value as VerifyIssue);
}

/**
 * Load a form only when its parent set belongs to this teacher, so a leaked form
 * id is useless.
 */
async function loadFormAndSet(
  req: AuthRequest,
  formId: string
): Promise<{ form: IExamForm; set: IExamSet } | { form: null; set: null }> {
  const form = await ExamForm.findById(formId);
  if (!form) return { form: null, set: null };
  const set = await ExamSet.findOne({ _id: form.examSetId, teacherId: teacherId(req) });
  return set ? { form, set } : { form: null, set: null };
}

function serializeSet(set: IExamSet, forms: IExamForm[] | null) {
  const base = {
    _id: String(set._id),
    bookId: String(set.bookId),
    title: set.title,
    weekLabel: set.weekLabel,
    lessonRef: set.lessonRef,
    pageFrom: set.pageFrom,
    pageTo: set.pageTo,
    difficulty: set.difficulty,
    mcqCount: set.mcqCount,
    shortCount: set.shortCount,
    formCount: set.formCount,
    formLabels: formLabels(set.formCount),
    verifyOnGenerate: set.verifyOnGenerate,
    timeLimitMinutes: set.timeLimitMinutes,
    passPercent: set.passPercent,
    maxAttempts: set.maxAttempts,
    status: set.status,
    openUntil: set.openUntil,
    publishedAt: set.publishedAt,
    blueprint: set.blueprint,
    hasBlueprint: Boolean(set.blueprint?.topics?.length),
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
  };

  return forms === null ? base : { ...base, forms: forms.map((f) => serializeForm(f, set)) };
}

function serializeForm(form: IExamForm | null, set: IExamSet) {
  if (!form) return null;
  return {
    _id: String(form._id),
    examSetId: String(form.examSetId),
    formLabel: form.formLabel,
    questions: form.questions.map((q) => ({
      _id: String(q._id),
      type: q.type,
      prompt: q.prompt,
      options: (q.options ?? []).map((o) => ({ id: o.id, text: o.text })),
      correctOptionId: q.correctOptionId,
      modelAnswer: q.modelAnswer,
      rubric: q.rubric ?? [],
      maxPoints: q.maxPoints,
      explanation: q.explanation,
      topic: q.topic,
      sourcePages: q.sourcePages ?? [],
      editedByTeacher: q.editedByTeacher,
      verify: q.verify,
    })),
    maxGrade: form.maxGrade,
    status: form.status,
    // `?? null` rather than a bare pass-through: a date that was never set would
    // otherwise vanish from the JSON, and the client would have to treat a missing
    // key and a null one as the same thing.
    verifiedAt: form.verifiedAt ?? null,
    reviewedAt: form.reviewedAt ?? null,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    coverage: coverageOf(form.questions, set.blueprint?.topics ?? []),
  };
}
