import { Response } from "express";
import { Types } from "mongoose";
import { ExamAssignment } from "../models/ExamAssignment";
import { ExamAttempt, type IExamAttempt, type IAttemptAnswer } from "../models/ExamAttempt";
import { ExamForm, type IExamForm, type IExamQuestionDoc } from "../models/ExamForm";
import { ExamSet, type IExamSet } from "../models/ExamSet";
import { User } from "../models/User";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { isAiConfigured } from "../services/ai/gemini";
import {
  applyTeacherOverride,
  attemptsLeft as computeAttemptsLeft,
  availability,
  buildStudentPaper,
  draftStillOpen,
  gradableFrom,
  normaliseSubmission,
  optionOrderFor,
  planForAttempt,
  scoreMcq,
  serialiseAttempt,
  SUBMIT_GRACE_MINUTES,
  totalise,
  type OverrideInput,
  type SubmittedAnswer,
} from "../services/exams/attempts";
import { attemptSeed } from "../services/exams/shuffle";
import { gradeShortAnswers, type GradedShortAnswers } from "../services/exams/grading";

/**
 * Student endpoints for sitting a paper.
 *
 * Two invariants hold across every route here:
 *
 * 1. **A paper is only ever handed to the student it was assigned to.** The lookup is
 *    `{examSetId, studentId}` on the assignment, so a leaked set id gets a 404 and a
 *    leaked attempt id gets a 404, not another student's exam.
 * 2. **Before submitting, no answer key crosses the wire.** The paper route strips
 *    `correctOptionId`, `modelAnswer`, `rubric` and `explanation`; the result route is
 *    the only one that returns them, and only for the attempt's own owner.
 */

function fail(res: Response, status: number, message: string) {
  return res.status(status).json({ message });
}

function studentId(req: AuthRequest): string {
  return String(req.user!._id);
}

/** A set this student is actually allowed to sit. */
async function loadAssignedSet(
  setId: string,
  student: string
): Promise<{ set: IExamSet; form: IExamForm } | null> {
  if (!Types.ObjectId.isValid(setId)) return null;
  const assignment = await ExamAssignment.findOne({ examSetId: setId, studentId: student });
  if (!assignment) return null;
  const form = await ExamForm.findOne({ _id: assignment.formId });
  if (!form) return null;
  const set = await ExamSet.findById(String(assignment.examSetId));
  if (!set) return null;
  return { set, form };
}

/** Submitted-or-submitting sittings. A draft is not an attempt until it is sent. */
function countUsedAttempts(setId: string, student: string): Promise<number> {
  return ExamAttempt.countDocuments({
    examSetId: setId,
    studentId: student,
    status: { $in: ["submitted", "graded", "grading_failed"] },
  });
}

function submittedAnswersFrom(body: Record<string, unknown>): SubmittedAnswer[] {
  const raw = body.answers;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({
      questionId: String(a.questionId ?? ""),
      chosenOptionId: a.chosenOptionId === undefined ? undefined : String(a.chosenOptionId),
      textAnswer: a.textAnswer === undefined ? undefined : String(a.textAnswer),
    }));
}

/* -------------------------------------------------------------------------- */
/* Take the paper                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The one payload shape for "here is your paper".
 *
 * Keyless by construction: it is built from `buildStudentPaper`, which has no field
 * for an answer, so there is no way for the key to reach this response by accident.
 */
function paperResponse(
  attempt: IExamAttempt,
  form: IExamForm,
  state: "started" | "resumed"
): Record<string, unknown> {
  const paper = buildStudentPaper(form, {
    questionOrder: attempt.questionOrder.map(String),
    optionOrder: Object.fromEntries(
      attempt.questionOrder.map((id) => [String(id), optionOrderFor(attempt, String(id))])
    ),
  });
  return {
    attemptId: String(attempt._id),
    state,
    deadlineAt: deadlineFor(attempt),
    formLabel: form.formLabel,
    questionCount: paper.questions.length,
    maxGrade: paper.maxGrade,
    answers: attempt.answers,
    questions: paper.questions,
  };
}

/**
 * GET /api/exam-sets/:id — this student's paper, shuffled, key stripped.
 *
 * Creates the attempt on the way in, and that is the point: the shuffle is written
 * down the first time the paper is opened, so a refresh mid-exam hands back the same
 * questions in the same order instead of silently reordering the exam. A student
 * who already has a live draft gets that draft back rather than a new one, and one
 * who has already submitted gets their result — asking for the paper again must not
 * mint a second paper.
 */
export async function getMyPaper(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const student = studentId(req);
    const now = new Date();

    const loaded = await loadAssignedSet(req.params.id, student);
    if (!loaded) return fail(res, 404, "Exam not found");
    const { set, form } = loaded;

    const draft = await ExamAttempt.findOne({
      examSetId: String(set._id),
      studentId: student,
      status: "draft",
    });

    if (draft) {
      // A live draft is the one thing that always wins: it is the same paper the
      // student already started, and it is governed by its own clock rather than the
      // set's window, so a set that closes mid-exam does not cost them the paper.
      const open = draftStillOpen(draft, now);
      if (!open.ok) return fail(res, 409, open.reason);
      return res.json(paperResponse(draft, form, "resumed"));
    }

    const lastSubmitted = await ExamAttempt.findOne({
      examSetId: String(set._id),
      studentId: student,
      status: { $in: ["submitted", "graded", "grading_failed"] },
    }).sort({ createdAt: -1 });

    const window = availability(set, now);
    if (!window.ok) return fail(res, 409, window.reason);

    const used = lastSubmitted ? await countUsedAttempts(String(set._id), student) : 0;
    const left = computeAttemptsLeft(set.maxAttempts, used);
    if (left <= 0) {
      // Nothing left to sit. Hand back the last result rather than an error: the
      // student came here for their mark, and an error page would throw it away.
      if (lastSubmitted) {
        return res.json({
          attemptId: String(lastSubmitted._id),
          state: "already_submitted",
          attemptsLeft: 0,
          // The client shows this straight away, so the pass mark has to travel with
          // it rather than be re-derived from a cap that is already spent.
          passed: (lastSubmitted.percent ?? 0) >= (set.passPercent ?? 0),
          attempt: serialiseAttempt(lastSubmitted, form),
        });
      }
      return fail(res, 409, "You have used all your attempts for this exam.");
    }

    // A fresh object id doubles as the shuffle's nonce, so the seed is unique per
    // sitting and stable for the life of this draft.
    const nonce = new Types.ObjectId();
    const plan = planForAttempt(
      form.questions as Types.DocumentArray<IExamQuestionDoc>,
      attemptSeed(set._id, student, form._id, nonce)
    );

    let attempt: IExamAttempt;
    try {
      attempt = await ExamAttempt.create({
        examSetId: set._id,
        formId: form._id,
        studentId: new Types.ObjectId(student),
        questionOrder: plan.questionOrder.map((id) => new Types.ObjectId(id)),
        optionOrder: new Map(Object.entries(plan.optionOrder)),
        answers: [],
        status: "draft",
        timeLimitMinutes: set.timeLimitMinutes ?? undefined,
      });
    } catch (err) {
      // The partial unique index allows one live draft per set. Losing that race
      // means a double-click or a second tab, and the right answer is to serve the
      // draft that won rather than to fail the request.
      if ((err as { code?: number })?.code === 11000) {
        const winner = await ExamAttempt.findOne({
          examSetId: String(set._id),
          studentId: student,
          status: "draft",
        });
        if (winner) return res.json(paperResponse(winner, form, "resumed"));
      }
      throw err;
    }

    // A retry carries the previous result's headline with it, so a student sitting a
    // second paper can see what they had last time without a second request.
    return res.json({
      ...paperResponse(attempt, form, "started"),
      attemptsLeft: left,
      previousPercent: lastSubmitted?.percent ?? null,
      previousAttemptId: lastSubmitted ? String(lastSubmitted._id) : null,
    });
  } catch (err) {
    console.error("getMyPaper error:", err);
    return fail(res, 500, "Server error");
  }
}

function deadlineFor(attempt: IExamAttempt): string | null {
  if (!attempt.timeLimitMinutes) return null;
  const created = new Date(attempt.createdAt ?? Date.now());
  return new Date(created.getTime() + attempt.timeLimitMinutes * 60_000).toISOString();
}

/**
 * PUT /api/exam-sets/:id/attempts/current — save a draft.
 *
 * Exists because a weekly exam with short answers does not fit in one sitting. It
 * writes answers only: the shuffle cannot be touched, the deadline cannot be pushed
 * back, and a submitted attempt is closed to it.
 */
export async function saveMyDraft(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const student = studentId(req);
    const now = new Date();
    const body = (req.body ?? {}) as Record<string, unknown>;

    const draft = await ExamAttempt.findOne({
      examSetId: req.params.id,
      studentId: student,
      status: "draft",
    });
    if (!draft) return fail(res, 404, "No open attempt for this exam.");

    const open = draftStillOpen(draft, now);
    if (!open.ok) return fail(res, 409, open.reason);

    const form = await ExamForm.findById(String(draft.formId));
    if (!form) return fail(res, 404, "Exam not found");

    let answers: IAttemptAnswer[];
    let unknownQuestionIds: string[];
    try {
      const normalised = normaliseSubmission(form, submittedAnswersFrom(body));
      answers = normalised.answers;
      unknownQuestionIds = normalised.unknownQuestionIds;
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : "Invalid answers");
    }
    // A saved draft that quietly kept answers to questions that are not on the paper
    // would resurface them at submit time, so they are refused here as well.
    if (unknownQuestionIds.length > 0) {
      return fail(
        res,
        400,
        `These answers are not on your paper: ${unknownQuestionIds.slice(0, 5).join(", ")}`
      );
    }

    draft.answers = answers;
    draft.draftSavedAt = now;
    await draft.save();

    res.json({ saved: true, answers: draft.answers, savedAt: draft.draftSavedAt });
  } catch (err) {
    console.error("saveMyDraft error:", err);
    return fail(res, 500, "Server error");
  }
}

/* -------------------------------------------------------------------------- */
/* Submit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/exam-sets/:id/attempts — submit, and grade in the same request.
 *
 * The MCQ half is scored here and now. The short half costs one Gemini call for the
 * whole paper, so it runs inline (a few seconds, with the client on a spinner) rather
 * than as a background job the student has to be told to come back for. If that call
 * fails, the attempt is still graded — the short answers are worth zero and flagged
 * for a teacher, which is honest, rather than the submit failing and leaving a
 * student with a lost paper.
 */
export async function submitMyAttempt(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const student = studentId(req);
    const now = new Date();
    const body = (req.body ?? {}) as Record<string, unknown>;

    const attempt = await ExamAttempt.findOne({
      examSetId: req.params.id,
      studentId: student,
      status: "draft",
    });
    if (!attempt) return fail(res, 404, "No open attempt for this exam.");

    // Handing in gets a grace period so a submit already in flight when the clock
    // reaches zero still counts.
    const open = draftStillOpen(attempt, now, SUBMIT_GRACE_MINUTES);
    if (!open.ok) return fail(res, 409, open.reason);

    const form = await ExamForm.findById(String(attempt.formId));
    const set = await ExamSet.findById(String(attempt.examSetId));
    if (!form || !set) return fail(res, 404, "Exam not found");

    const submitted = submittedAnswersFrom(body);
    let mcq: ReturnType<typeof scoreMcq>;
    try {
      mcq = scoreMcq(form, submitted);
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : "Invalid answers");
    }

    // Re-run normalisation over the whole paper to get the short answers too; the
    // MCQ pass above already threw if an option id was bogus.
    const { answers: all, unknownQuestionIds, duplicateQuestionIds } = normaliseSubmission(form, submitted);
    if (unknownQuestionIds.length > 0) {
      return fail(
        res,
        400,
        `These answers are not on your paper: ${unknownQuestionIds.slice(0, 5).join(", ")}`
      );
    }

    const questionById = new Map<string, IExamQuestionDoc>();
    form.questions.forEach((q) => questionById.set(String(q._id), q));
    const shortAnswered = all.filter((a) => a.type === "short");
    const shortMax = form.questions
      .filter((q) => q.type === "short")
      .reduce((sum, q) => sum + q.maxPoints, 0);

    // An explicit draft, when the client sent one, replaces what was saved: the
    // student can go back and change an answer after a refresh. A submit with no
    // answers in the body keeps the saved draft, which is what "I just want to hand
    // this in" means.
    const useDraft = submitted.length === 0 && attempt.answers.length > 0;
    const effective = useDraft ? attempt.answers : all;
    const effectiveShorts = effective.filter((a) => a.type === "short");
    const effectiveMcqs = effective.filter((a) => a.type === "mcq");

    let graded: GradedShortAnswers = new Map();
    if (effectiveShorts.length > 0) {
      graded = isAiConfigured()
        ? await gradeShortAnswers(
            set,
            effectiveShorts.map((a) => ({
              questionId: String(a.questionId),
              answer: {
                question: gradableFrom(questionById.get(String(a.questionId))!),
                studentAnswer: a.textAnswer ?? "",
              },
            }))
          )
        : new Map();
    }

    for (const a of effectiveShorts) {
      const questionId = String(a.questionId);
      const max = questionById.get(questionId)?.maxPoints ?? 0;
      const result = graded.get(questionId);
      if (result) {
        a.aiScore = result.score;
        a.aiMax = result.max;
        a.aiFeedback = result.feedback;
        a.aiConfidence = result.confidence;
      } else {
        // No AI, a failed call, or an answer the model skipped.
        a.aiScore = 0;
        a.aiMax = max;
        a.aiFeedback = "";
        a.aiConfidence = "low";
      }
    }

    const answers = [...effectiveMcqs, ...effectiveShorts];
    const aiShortScore = effectiveShorts.reduce((sum, a) => sum + (a.aiScore ?? 0), 0);
    const mcqScore = effectiveMcqs.reduce(
      (sum, a) => sum + (a.isCorrect ? (questionById.get(String(a.questionId))?.maxPoints ?? 0) : 0),
      0
    );
    const totals = totalise({
      answers,
      mcqScore,
      shortMax,
      aiShortScore,
      maxGrade: form.maxGrade,
    });

    attempt.answers = answers;
    attempt.status = "graded";
    attempt.submittedAt = now;
    attempt.gradedAt = now;
    attempt.mcqScore = totals.mcqScore;
    attempt.shortScore = totals.shortScore;
    attempt.totalScore = totals.totalScore;
    attempt.maxGrade = totals.maxGrade;
    attempt.percent = totals.percent;
    attempt.needsReview = totals.needsReview;
    await attempt.save();

    res.json({
      attemptId: String(attempt._id),
      passed: totals.percent >= (set.passPercent ?? 0),
      duplicateQuestionIds,
      attempt: serialiseAttempt(attempt, form),
    });
  } catch (err) {
    console.error("submitMyAttempt error:", err);
    return fail(res, 500, "Server error");
  }
}

/* -------------------------------------------------------------------------- */
/* Read                                                                        */
/* -------------------------------------------------------------------------- */

/** GET /api/exam-attempts/:id — poll a result, or hand back a live paper's progress. */
export async function getMyAttempt(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const student = studentId(req);
    if (!Types.ObjectId.isValid(req.params.id)) return fail(res, 404, "Attempt not found");

    const attempt = await ExamAttempt.findOne({ _id: req.params.id, studentId: student });
    if (!attempt) return fail(res, 404, "Attempt not found");

    const form = await ExamForm.findById(String(attempt.formId));
    res.json({
      status: attempt.status,
      needsReview: attempt.needsReview,
      // A draft is progress, not a result: no key, no score.
      ...(attempt.status === "draft"
        ? { attemptId: String(attempt._id), answers: attempt.answers, deadlineAt: deadlineFor(attempt) }
        : { attempt: serialiseAttempt(attempt, form) }),
    });
  } catch (err) {
    console.error("getMyAttempt error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * GET /api/exam-sets/:id/attempts — my sittings on this set, best score first.
 *
 * The list is what the portal's card is built from, and it carries `attemptsLeft` so
 * the UI can say "one attempt left" without counting rows itself.
 */
export async function listMyAttempts(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const student = studentId(req);
    const loaded = await loadAssignedSet(req.params.id, student);
    if (!loaded) return fail(res, 404, "Exam not found");

    const [rows, used, draftCount] = await Promise.all([
      ExamAttempt.find({ examSetId: String(loaded.set._id), studentId: student })
        .sort({ createdAt: -1 })
        .lean(),
      countUsedAttempts(String(loaded.set._id), student),
      ExamAttempt.countDocuments({ examSetId: String(loaded.set._id), studentId: student, status: "draft" }),
    ]);

    const submitted = rows.filter((r) => r.status !== "draft");
    const best = submitted.reduce((max, r) => Math.max(max, r.percent ?? 0), 0);

    res.json({
      attemptsLeft: computeAttemptsLeft(loaded.set.maxAttempts, used),
      bestPercent: best,
      hasDraft: draftCount > 0,
      attempts: rows.map((r) => ({
        _id: String(r._id),
        status: r.status,
        percent: r.percent ?? 0,
        totalScore: r.totalScore ?? 0,
        maxGrade: r.maxGrade ?? 0,
        needsReview: Boolean(r.needsReview),
        answersGiven: Array.isArray(r.answers) ? r.answers.length : 0,
        submittedAt: r.submittedAt ?? null,
        gradedAt: r.gradedAt ?? null,
        createdAt: r.createdAt ?? null,
      })),
    });
  } catch (err) {
    console.error("listMyAttempts error:", err);
    return fail(res, 500, "Server error");
  }
}

/**
 * Whether a student has already begun this set.
 *
 * Used by the teacher-side override to refuse moving someone who has started: their
 * paper is shuffled and persisted, so moving them would leave a result on a paper
 * they never saw.
 */
export async function hasStartedAttempt(examSetId: string, studentIdValue: string): Promise<boolean> {
  return Boolean(
    await ExamAttempt.findOne({ examSetId, studentId: studentIdValue }).select("_id").lean()
  );
}

/** The students who have started, for the teacher roster. */
export async function studentsWhoStarted(examSetId: string): Promise<Set<string>> {
  const rows = await ExamAttempt.find({ examSetId })
    .select("studentId")
    .lean<Array<{ studentId: unknown }>>();
  return new Set(rows.map((r) => String(r.studentId)));
}

/* -------------------------------------------------------------------------- */
/* Teacher override                                                            */
/* -------------------------------------------------------------------------- */

/**
 * PUT /api/exam-attempts/:id/grade — a teacher setting one written answer's mark.
 *
 * This is the last word on a disputed answer, so it is deliberately narrow:
 *
 * - **The set has to belong to the teacher.** The attempt is found by id, so without
 *   the `teacherId` check any teacher could mark any student's paper anywhere.
 * - **A draft cannot be marked.** There is nothing to mark until it is handed in,
 *   and marking a draft would invent a score for work that may never arrive.
 * - **The totals are recomputed, not patched.** The mark is written on the answer
 *   and then the whole attempt is re-totalled from the same `totalise` the AI
 *   grading used, so the per-answer figure, the short total, the total and the
 *   percent can never drift apart — which is exactly the bug an "adjust the
 *   percentage" endpoint would introduce.
 */
export async function overrideAttemptGrade(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    if (!Types.ObjectId.isValid(req.params.id)) return fail(res, 404, "Attempt not found");

    const attempt = await ExamAttempt.findById(req.params.id);
    if (!attempt) return fail(res, 404, "Attempt not found");
    if (attempt.status === "draft") {
      return fail(res, 409, "This attempt has not been handed in yet.");
    }

    const set = await ExamSet.findById(String(attempt.examSetId)).select("teacherId passPercent");
    if (!set || String(set.teacherId) !== String(req.user!._id)) {
      // The same 404 as a missing attempt: a teacher should not be able to probe
      // for which sets other teachers own.
      return fail(res, 404, "Attempt not found");
    }

    const form = await ExamForm.findById(String(attempt.formId));
    const maxById = new Map((form?.questions ?? []).map((q) => [String(q._id), q.maxPoints]));
    const outcome = applyTeacherOverride(attempt.answers, (req.body ?? {}) as OverrideInput, maxById);
    if (!outcome.ok) return fail(res, 400, outcome.reason);

    if (outcome.changed) {
      const now = new Date();
      // The override is stamped with whoever made the last call: a second teacher
      // correcting a first one owns it now, not the original marker.
      for (const a of outcome.answers) {
        if (a.teacherScore === undefined) continue;
        a.overriddenBy = new Types.ObjectId(String(req.user!._id)) as never;
        a.overriddenAt = now;
      }

      const shortMax = (form?.questions ?? [])
        .filter((q) => q.type === "short")
        .reduce((sum, q) => sum + q.maxPoints, 0);
      const aiShortScore = outcome.answers
        .filter((a) => a.type === "short")
        .reduce((sum, a) => sum + (a.aiScore ?? 0), 0);
      const totals = totalise({
        answers: outcome.answers,
        mcqScore: attempt.mcqScore,
        shortMax,
        aiShortScore,
        maxGrade: attempt.maxGrade || form?.maxGrade || 0,
      });

      attempt.answers = outcome.answers;
      attempt.mcqScore = totals.mcqScore;
      attempt.shortScore = totals.shortScore;
      attempt.totalScore = totals.totalScore;
      attempt.maxGrade = totals.maxGrade;
      attempt.percent = totals.percent;
      // A hand-set mark is a teacher's decision, so that answer stops counting as
      // "waiting for a teacher" — otherwise the row would sit in the review queue
      // forever and `needsReview` could never clear.
      attempt.needsReview = totals.needsReview;
      await attempt.save();
    }

    res.json({
      changed: outcome.changed,
      passed: (attempt.percent ?? 0) >= (set.passPercent ?? 0),
      attempt: serialiseAttempt(attempt, form),
    });
  } catch (err) {
    console.error("overrideAttemptGrade error:", err);
    return fail(res, 500, "Server error");
  }
}
