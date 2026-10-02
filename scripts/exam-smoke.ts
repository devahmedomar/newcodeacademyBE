import { Types } from "mongoose";
import { computeMaxGrade, type IExamForm } from "../src/models/ExamForm";
import type { IAttemptAnswer } from "../src/models/ExamAttempt";
import type { IExamAttempt } from "../src/models/ExamAttempt";
import { renderQuestionsForVerify } from "../src/services/exams/formGenerator";
import { planBalancedAssignment, type AssignableStudent } from "../src/services/exams/assignment";
import { assertWithinGenerationBudget, resetGenerationBudget } from "../src/services/exams/generationLimit";
import { normaliseFindings } from "../src/services/exams/verify";
import { attemptSeed, buildShufflePlan } from "../src/services/exams/shuffle";
import {
  applyTeacherOverride,
  attemptsLeft,
  availability,
  buildStudentPaper,
  draftDeadline,
  draftStillOpen,
  normaliseSubmission,
  scoreMcq,
  serialiseAttempt,
  SUBMIT_GRACE_MINUTES,
  totalise,
} from "../src/services/exams/attempts";
import {
  applyTeacherEdit,
  buildForm,
  buildQuestion,
  clampInt,
  coerceDifficulty,
  coverageOf,
  formLabels,
  isFormLabel,
  normalizeForCompare,
  rebuildOptions,
  reconcileCounts,
  toRawQuestion,
  usedPromptList,
  type BuiltQuestion,
} from "../src/services/exams/questions";
import type { IBlueprintTopic } from "../src/models/ExamSet";

/**
 * Covers the pure exam-generation logic with no AI and no database: turning
 * model output into storable questions, the fairness rules, the teacher edit
 * path, and the verify pass's index alignment. Run with `npm run test:exam`.
 *
 * The rules under test are the ones that decide whether a paper is sound, so a
 * regression here means questions a student would see could be unanswerable.
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

const ctx = { pageFrom: 10, pageTo: 20, topics: ["الكسور", "الزوايا"] };

/** A well-formed MCQ as the model would return it. */
function rawMcq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "mcq",
    prompt: "ما ناتج جمع الكسرين التاليين؟",
    options: ["ثلاثة proudly", "", "", ""],
    correctIndex: 0,
    topic: "الكسور",
    sourcePages: [12],
    explanation: "الجمع المباشر يعطي ثلاثة.",
    ...over,
  };
}

function mcq(over: Record<string, unknown> = {}): Record<string, unknown> {
  return rawMcq({
    options: ["ثلاثة أرباع", "نصف", "ربع", "خمسة أثمان"],
    ...over,
  });
}

function rawShort(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "short",
    prompt: "عرّف الزاوية الحادة مع التمثيل الرباعي.",
    modelAnswer: "الزاوية الحادة هي التي قياسها أقل من تسعين درجة.",
    rubric: ["ذكر تعريف الزاوية الحادة", "ذكر أنها أقل من تسعين درجة"],
    topic: "الزوايا",
    sourcePages: [15, 16],
    ...over,
  };
}

function asQuestion(outcome: ReturnType<typeof buildQuestion>): BuiltQuestion | null {
  return outcome.ok ? outcome.question : null;
}

const mcqQuestion = asQuestion(buildQuestion(mcq(), ctx))!;
const shortQuestion = asQuestion(buildQuestion(rawShort(), ctx))!;

function main() {
  console.log("1. One question: stable option ids");
  {
    const q = asQuestion(buildQuestion(mcq(), ctx));
    check("builds a valid MCQ", q !== null);
    if (q) {
      check("gives every option a stable id", q.options.map((o) => o.id).join(",") === "o1,o2,o3,o4");
      check("maps correctIndex onto an option id", q.correctOptionId === "o1");
      check("scores an MCQ at one point", q.maxPoints === 1);
      check("an MCQ carries no rubric", q.rubric.length === 0);
      check("starts unverified and unedited", q.verify.status === "pending" && !q.editedByTeacher);
    }
  }

  console.log("2. One question: what gets thrown away");
  {
    check("rejects three options", !buildQuestion(mcq({ options: ["أ", "ب", "ج"] }), ctx).ok);
    check(
      "rejects two identical options",
      !buildQuestion(mcq({ options: ["نصف", "نصف", "ربع", "ثلث"] }), ctx).ok
    );
    check("rejects a correctIndex past the end", !buildQuestion(mcq({ correctIndex: 9 }), ctx).ok);
    check("rejects a correctIndex that is not a number", !buildQuestion(mcq({ correctIndex: "أ" }), ctx).ok);
    check("rejects an empty prompt", !buildQuestion(mcq({ prompt: "  " }), ctx).ok);
    check("rejects a short answer with no rubric", !buildQuestion(rawShort({ rubric: [] }), ctx).ok);
    check(
      "rejects a short answer with no model answer",
      !buildQuestion(rawShort({ modelAnswer: "" }), ctx).ok
    );
    check(
      "rejects a rubric that repeats a point",
      !buildQuestion(rawShort({ rubric: ["ذكر التعريف", "ذكر التعريف"] }), ctx).ok
    );
  }

  console.log("3. One question: the rest of the shape");
  {
    const q = asQuestion(buildQuestion(rawShort(), ctx));
    check("builds a valid short answer", q !== null);
    if (q) {
      check("a short answer has no options", q.options.length === 0);
      check("its points follow the rubric", q.maxPoints === 2);
      check("caps the points a long rubric can claim", asQuestion(
        buildQuestion(
          rawShort({ rubric: ["أ", "ب", "ج", "د", "هـ", "و"] }),
          ctx
        )
      )?.maxPoints === 5);
      check("never scores a question below two points", asQuestion(
        buildQuestion(rawShort({ rubric: ["أ"] }), ctx)
      )?.maxPoints === 2);
    }
    check("drops source pages outside the set's range", (() => {
      const out = asQuestion(buildQuestion(mcq({ sourcePages: [3, 12, 44] }), ctx));
      return out?.sourcePages.join(",") === "12";
    })());
    check("snaps a reworded topic onto the blueprint", (() => {
      const out = asQuestion(buildQuestion(mcq({ topic: "كسور" }), ctx));
      return out?.topic === "الكسور";
    })());
    check("strips markup out of model text", (() => {
      const out = asQuestion(buildQuestion(mcq({ prompt: "<b>ما ناتج الجمع؟</b>" }), ctx));
      return out?.prompt === "ما ناتج الجمع؟";
    })());
  }

  console.log("4. A whole form: counts, order, variety");
  {
    const list = [
      mcq(),
      rawShort(),
      mcq({ prompt: "ما ناتج ضرب الكسرين التاليين؟" }),
      mcq({ correctIndex: 7 }),
    ];
    const built = buildForm(list, { ...ctx, mcqCount: 2, shortCount: 1 });
    check("keeps the good questions", built.questions.length === 3);
    check("reports the broken one", built.rejected.length === 1 && built.rejected[0].index === 3);
    check("puts MCQs before short answers", built.questions.map((q) => q.type).join(",") === "mcq,mcq,short");

    const dupes = buildForm([mcq(), mcq({ prompt: "  ما ناتج جمع الكسرين التاليين؟  " })], {
      ...ctx,
      mcqCount: 2,
      shortCount: 0,
    });
    check("drops a question that repeats one in the same form", dupes.questions.length === 1 && dupes.duplicates === 1);

    const againstSiblings = buildForm([mcq()], {
      ...ctx,
      mcqCount: 1,
      shortCount: 0,
      alreadyUsed: ["ما ناتج جمع الكسرين التاليين؟"],
    });
    check("drops a question a sibling form already used", againstSiblings.questions.length === 0);

    const short = reconcileCounts([mcq(), mcq({ prompt: "سؤال آخر عن الكسور؟" }), rawShort()], {
      mcqCount: 1,
      shortCount: 1,
    });
    check("trims the surplus", short.questions.length === 2 && short.trimmed === 1);
    check("reports what the model failed to produce", (() => {
      const gap = reconcileCounts([mcq()], { mcqCount: 3, shortCount: 2 });
      return gap.missing.mcq === 2 && gap.missing.short === 2;
    })());
    check("does not pad a shortfall", reconcileCounts([mcq()], { mcqCount: 3, shortCount: 0 }).questions.length === 1);
  }

  console.log("5. Teacher edits go through the same rules");
  {
    const stored = asQuestion(buildQuestion(mcq(), ctx))!;
    const edit = applyTeacherEdit(stored, { prompt: "ما ناتج ضرب الكسرين؟" }, ctx);
    check("accepts a good edit", edit.ok);
    check("keeps the option ids on edit", edit.ok && edit.question.options.map((o) => o.id).join(",") === "o1,o2,o3,o4");
    check(
      "keeps the answer key on edit",
      edit.ok && edit.question.correctOptionId === "o1"
    );
    check(
      "marks a teacher-edited question as reviewed",
      edit.ok && edit.question.verify.status === "ok"
    );

    const broken = applyTeacherEdit(stored, { options: ["نصف", "نصف", "ربع"] }, ctx);
    check("refuses an edit that leaves three options", !broken.ok);

    const rekeyed = applyTeacherEdit(stored, { options: ["نصف", "ربع", "ثلث", "خمس"] }, ctx);
    check(
      "refuses a list where the old answer no longer exists",
      !rekeyed.ok
    );
    check(
      "accepts the same list once the teacher marks the answer by position",
      (() => {
        const out = applyTeacherEdit(
          stored,
          { options: ["نصف", "ربع", "ثلث", "خمس"], correctIndex: 2 },
          ctx
        );
        return (
          out.ok &&
          out.question.options.find((o) => o.id === out.question.correctOptionId)?.text === "ثلث"
        );
      })()
    );
    check(
      "refuses an answer position outside the list",
      !applyTeacherEdit(stored, { options: ["نصف", "ربع", "ثلث", "خمس"], correctIndex: 9 }, ctx).ok
    );

    const wrongPick = applyTeacherEdit(stored, { correctOptionId: "o9" }, ctx);
    check("refuses an answer key outside the options", !wrongPick.ok);

    const reordered = applyTeacherEdit(
      stored,
      { options: [
        { id: "o4", text: "خمسة أثمان" },
        { id: "o3", text: "ربع" },
        { id: "o2", text: "نصف" },
        { id: "o1", text: "ثلاثة أرباع" },
      ] },
      ctx
    );
    check(
      "keeps the answer key on the right option after a reorder",
      reordered.ok &&
        reordered.question.correctOptionId === "o1" &&
        reordered.question.options[3].id === "o1" &&
        reordered.question.options[3].text === "ثلاثة أرباع"
    );

    const textReorder = applyTeacherEdit(
      stored,
      { options: ["خمسة أثمان", "ثلاثة أرباع", "نصف", "ربع"] },
      ctx
    );
    check(
      "matches a reorder sent without ids by its text",
      textReorder.ok &&
        textReorder.question.correctOptionId === "o1" &&
        textReorder.question.options[1].text === "ثلاثة أرباع"
    );
  }

  console.log("6. Option re-keying on its own");
  {
    const existing = { options: [{ id: "o1" }, { id: "o2" }], correctOptionId: "o2" };
    check(
      "preserves ids the question already has",
      (() => {
        const out = rebuildOptions(existing, [
          { id: "o1", text: "أ" },
          { id: "o2", text: "ب" },
        ]);
        return out.ok && out.correctOptionId === "o2" && out.options[1].id === "o2";
      })()
    );
    check("gives fresh ids to options the UI invented", (() => {
      const out = rebuildOptions(existing, ["أ", "ب"]);
      return out.ok && out.options[0].id === "o1" && out.options[1].id === "o2";
    })());
    check(
      "refuses a list with no answer marked",
      !rebuildOptions(existing, ["أ", "ب", "ج", "د"], { correctOptionId: "o9" }).ok
    );
    check(
      "names the answer by position for a list sent without ids",
      (() => {
        const out = rebuildOptions(existing, ["أ", "ب", "ج", "د"], { correctIndex: 3 });
        return out.ok && out.correctOptionId === out.options[3].id;
      })()
    );
    check(
      "refuses an answer position outside the list",
      !rebuildOptions(existing, ["أ", "ب", "ج", "د"], { correctIndex: 9 }).ok
    );
    check("refuses an empty list", !rebuildOptions(existing, []).ok);
  }

  console.log("7. Verify pass alignment");
  {
    const findings = normaliseFindings(
      { results: [{ index: 0, valid: true, issue: "none", note: "سليم" }, { index: 1, valid: false, issue: "multiple_correct", note: "خياران صحيحان" }] },
      3
    );
    check("keeps one finding per question", findings.length === 3);
    check("honours a pass", findings[0].valid === true);
    check("honours a rejection", findings[1].valid === false && findings[1].issue === "multiple_correct");
    check("flags a question the reviewer skipped", (() => {
      const f = findings[2];
      return !f.valid && f.issue === "not_in_source" && f.note.length > 0;
    })());
    check(
      "names a cause when a rejection states none",
      normaliseFindings({ results: [{ index: 0, valid: false, issue: "none" }] }, 1)[0].issue === "ambiguous"
    );
    check(
      "ignores an out-of-range index",
      normaliseFindings({ results: [{ index: 99, valid: true, issue: "none" }] }, 1)[0].valid === false
    );
    check("treats no response at all as suspect", normaliseFindings(undefined, 2).every((f) => !f.valid));
  }

  console.log("8. The prompt the reviewer sees");
  {
    const raw = toRawQuestion(mcqQuestion);
    check("renders an MCQ as options plus a correctIndex", Array.isArray(raw.options) && raw.correctIndex === 0);
    check("renders a short answer with its rubric", Array.isArray(toRawQuestion(shortQuestion).rubric));
    const rendered = renderQuestionsForVerify([mcqQuestion, shortQuestion]);
    check("sends the whole form in one block", rendered.includes("الكسور") && rendered.includes("الزوايا"));
    check("includes the answer key, because the reviewer needs it", rendered.includes("correctIndex"));
  }

  console.log("9. Coverage against the blueprint");
  {
    const topics: IBlueprintTopic[] = [
      { topic: "الكسور", weight: 3, keywords: [] },
      { topic: "الزوايا", weight: 3, keywords: [] },
      { topic: "المثلثات", weight: 1, keywords: [] },
    ];
    const report = coverageOf([mcqQuestion, shortQuestion], topics);
    check("lists the covered topics", report.covered.join(",") === "الكسور,الزوايا");
    check("names a topic no question touches", report.missing.join(",") === "المثلثات");
    check("flags a question tagged off the map", (() => {
      const off = asQuestion(buildQuestion(mcq({ topic: "الضرب والجمع" }), ctx))!;
      return coverageOf([off], topics).offMap.length === 1;
    })());
  }

  console.log("10. Small helpers");
  {
    check("clamps a count into range", clampInt(99, 1, 10, 1) === 10);
    check("falls back on nonsense", clampInt("abc", 1, 10, 4) === 4);
    check("reads a difficulty it knows and defaults the rest", coerceDifficulty("hard") === "hard" && coerceDifficulty("insane") === "medium");
    check("labels forms A..D for the requested count", formLabels(3).join("") === "ABC");
    check("never offers fewer than two forms", formLabels(0).join("") === "AB");
    check("recognises a label in any case", isFormLabel("b") && !isFormLabel("Z"));
    check("ignores diacritics when comparing questions", normalizeForCompare("الكَسْر") === normalizeForCompare("الكسر"));
    check("unifies Arabic-Indic digits", normalizeForCompare("صفحة ١٢") === "صفحة 12");
    check("ignores punctuation and spacing", normalizeForCompare("ما ناتج الجمع؟") === normalizeForCompare("ما  ناتج  الجمع"));
    check("collects the prompts a sibling form already used", usedPromptList([
      { questions: [mcqQuestion, shortQuestion] },
    ]).length === 2);
  }

  console.log("11. Grades");
  {
    check("an MCQ and a short answer total three points", computeMaxGrade([mcqQuestion, shortQuestion]) === 3);
    check("an empty form is worth zero", computeMaxGrade([]) === 0);
  }

  console.log("12. The generation throttle");
  {
    resetGenerationBudget();
    const teacher = "teacher-throttle";
    check("allows calls up to the limit", (() => {
      try {
        for (let i = 0; i < 5; i++) assertWithinGenerationBudget(teacher, 5);
        return true;
      } catch {
        return false;
      }
    })());
    check("stops the call after that", (() => {
      try {
        assertWithinGenerationBudget(teacher, 5);
        return false;
      } catch (err) {
        return (err as { statusCode?: number }).statusCode === 429;
      }
    })());
    check("each teacher has their own budget", (() => {
      try {
        assertWithinGenerationBudget("another-teacher", 5);
        return true;
      } catch {
        return false;
      }
    })());
    resetGenerationBudget(teacher);
    check("can be reset", (() => {
      try {
        assertWithinGenerationBudget(teacher, 5);
        return true;
      } catch {
        return false;
      }
    })());
    resetGenerationBudget();
  }

  /* ---------------------------------------------------------------- */
  /* Shuffling                                                          */
  /* ---------------------------------------------------------------- */

  {
    const questionIds = Array.from({ length: 12 }, (_, i) => new Types.ObjectId());
    const optionIds = ["o1", "o2", "o3", "o4"];
    const questions = questionIds.map((id) => ({
      _id: id,
      type: "mcq" as const,
      options: optionIds.map((oid) => ({ id: oid, text: `خيار ${oid}` })),
    }));

    const a = buildShufflePlan(questions, "seed-a");
    const b = buildShufflePlan(questions, "seed-b");
    const aAgain = buildShufflePlan(questions, "seed-a");

    check("the same seed gives the same paper", JSON.stringify(a) === JSON.stringify(aAgain));
    check("two students get different question orders", JSON.stringify(a.questionOrder) !== JSON.stringify(b.questionOrder));
    check("every question appears exactly once", (() => {
      const sorted = [...a.questionOrder].sort();
      const expected = questionIds.map(String).sort();
      return JSON.stringify(sorted) === JSON.stringify(expected);
    })());
    check("the order is actually shuffled, not sorted", JSON.stringify(a.questionOrder) !== JSON.stringify(questionIds.map(String)));
    check("options are shuffled too", JSON.stringify(a.optionOrder[String(questionIds[0])]) !== JSON.stringify(optionIds));
    check("but every option survives the shuffle", (() => {
      for (const id of questionIds) {
        const got = [...a.optionOrder[String(id)]].sort();
        if (JSON.stringify(got) !== JSON.stringify(optionIds)) return false;
      }
      return true;
    })());
    check("one question's shuffle does not move another's", (() => {
      const first = a.optionOrder[String(questionIds[0])];
      const second = b.optionOrder[String(questionIds[0])];
      return JSON.stringify(first) !== JSON.stringify(second);
    })());
    check("seeds spread over many students", (() => {
      const orders = new Set(
        Array.from({ length: 40 }, (_, i) => JSON.stringify(buildShufflePlan(questions, `student-${i}`).questionOrder))
      );
      // Some collisions are expected in any permutation, but not near-degenerate ones.
      return orders.size > 30;
    })());
    check("a question with no options shuffles to nothing", (() => {
      const plan = buildShufflePlan([{ _id: new Types.ObjectId(), type: "short", options: [] }], "solo");
      return Object.values(plan.optionOrder)[0].length === 0;
    })());
    check("the attempt seed names all three ids", attemptSeed("set", "student", "form", "nonce") === "set:student:form:nonce");
  }

  /* ---------------------------------------------------------------- */
  /* The paper a student is handed                                      */
  /* ---------------------------------------------------------------- */

  const stubForm = () => {
    const mcq = {
      _id: new Types.ObjectId(),
      type: "mcq" as const,
      prompt: "ما ناتج الجمع؟",
      options: [
        { id: "o1", text: "ثلاثة" },
        { id: "o2", text: "أربعة" },
        { id: "o3", text: "خمسة" },
        { id: "o4", text: "ستة" },
      ],
      correctOptionId: "o2",
      modelAnswer: "",
      rubric: [],
      maxPoints: 1,
      explanation: "الجمع المباشر",
      topic: "الكسور",
      sourcePages: [12],
      editedByTeacher: false,
      verify: { status: "ok" as const, issue: "none" as const, note: "", checkedAt: new Date() },
    };
    const short = {
      _id: new Types.ObjectId(),
      type: "short" as const,
      prompt: "اشرح سبب الشرط",
      options: [],
      correctOptionId: undefined,
      modelAnswer: "لأن المجموع ثابت",
      rubric: ["يذكر الشرط", "يذكر السبب"],
      maxPoints: 3,
      explanation: "الإجابة النموذجية",
      topic: "الكسور",
      sourcePages: [12],
      editedByTeacher: false,
      verify: { status: "ok" as const, issue: "none" as const, note: "", checkedAt: new Date() },
    };
    return { _id: new Types.ObjectId(), maxGrade: 4, questions: [mcq, short] } as unknown as IExamForm;
  };

  {
    const form = stubForm();
    const [mcq, short] = form.questions;
    const plan = buildShufflePlan(
      [mcq, short].map((q) => ({ _id: q._id, type: q.type, options: q.options ?? [] })),
      "paper-seed"
    );
    const paper = buildStudentPaper(form, plan);

    check("the paper carries both questions", paper.questions.length === 2);
    check("the paper is worth the form's marks", paper.maxGrade === 4);
    check("the paper comes in the shuffled order", paper.questions[0].id === plan.questionOrder[0]);
    check("options come in this student's order", (() => {
      const first = paper.questions.find((q) => q.id === String(mcq._id))!;
      return JSON.stringify(first.options.map((o) => o.id)) === JSON.stringify(plan.optionOrder[String(mcq._id)]);
    })());
    check("the answer key is not in the paper", (() => {
      const text = JSON.stringify(paper);
      return !text.includes("o2") || !text.includes("الجمع المباشر") || !/"correctOptionId"|"explanation"|"modelAnswer"|"rubric"/.test(text);
    })());
    check("no paper field is named like an answer", (() => {
      return paper.questions.every((q) => !("correctOptionId" in q) && !("modelAnswer" in q) && !("explanation" in q));
    })());
    check("a short answer is sent with no options", (() => {
      const onPaper = paper.questions.find((q) => q.id === String(short._id))!;
      return onPaper.type === "short" && onPaper.options.length === 0;
    })());
    check("marks per question survive", paper.questions.find((q) => q.id === String(short._id))!.maxPoints === 3);
  }

  /* ---------------------------------------------------------------- */
  /* Reading a submission                                               */
  /* ---------------------------------------------------------------- */

  {
    const form = stubForm();
    const [mcq, short] = form.questions;
    const mcqId = String(mcq._id);
    const shortId = String(short._id);

    const right = normaliseSubmission(form, [{ questionId: mcqId, chosenOptionId: "o2" }]);
    check("the right option is marked correct", right.answers[0].isCorrect === true);
    const wrong = normaliseSubmission(form, [{ questionId: mcqId, chosenOptionId: "o3" }]);
    check("a wrong option is marked incorrect", wrong.answers[0].isCorrect === false);
    check("an unanswered MCQ is stored as nothing, not as a blank", normaliseSubmission(form, [{ questionId: mcqId }]).answers.length === 0);
    check("text is trimmed", normaliseSubmission(form, [{ questionId: shortId, textAnswer: "  إجابة  " }]).answers[0].textAnswer === "إجابة");
    check("blank text is not an answer", normaliseSubmission(form, [{ questionId: shortId, textAnswer: "   " }]).answers.length === 0);
    check("a very long answer is capped", normaliseSubmission(form, [{ questionId: shortId, textAnswer: "ا".repeat(9_000) }]).answers[0].textAnswer!.length === 4_000);
    check("the last of two answers to one question wins", (() => {
      const twice = normaliseSubmission(form, [
        { questionId: mcqId, chosenOptionId: "o1" },
        { questionId: mcqId, chosenOptionId: "o2" },
      ]);
      return twice.answers.length === 1 && twice.answers[0].chosenOptionId === "o2" && twice.duplicateQuestionIds.length === 1;
    })());
    check("a question from another paper is reported, not scored", (() => {
      const stray = normaliseSubmission(form, [{ questionId: new Types.ObjectId().toString(), chosenOptionId: "o1" }]);
      return stray.answers.length === 0 && stray.unknownQuestionIds.length === 1;
    })());
    check("an option id that is not on the question is refused", (() => {
      try {
        normaliseSubmission(form, [{ questionId: mcqId, chosenOptionId: "not-an-option" }]);
        return false;
      } catch {
        return true;
      }
    })());
    check("a short question is not answered by an option id", (() => {
      const sent = normaliseSubmission(form, [{ questionId: shortId, chosenOptionId: "o2" }]);
      return sent.answers.length === 0;
    })());
    check("a short question's text still counts when an option id came too", (() => {
      const sent = normaliseSubmission(form, [{ questionId: shortId, chosenOptionId: "o2", textAnswer: "إجابة" }]);
      return sent.answers.length === 1 && sent.answers[0].textAnswer === "إجابة";
    })());
    check("clearing an answer removes it", (() => {
      const cleared = normaliseSubmission(form, [
        { questionId: mcqId, chosenOptionId: "o2" },
        { questionId: mcqId },
      ]);
      return cleared.answers.length === 0 && cleared.duplicateQuestionIds.length === 1;
    })());
  }

  /* ---------------------------------------------------------------- */
  /* Totals                                                             */
  /* ---------------------------------------------------------------- */

  {
    const form = stubForm();
    const [mcq, short] = form.questions;
    const scored = scoreMcq(form, [
      { questionId: String(mcq._id), chosenOptionId: "o2" },
      { questionId: String(short._id), textAnswer: "لأن المجموع ثابت" },
    ]);
    check("the MCQ half is scored on submit", scored.mcqScore === 1 && scored.mcqMax === 1);
    check("only the MCQ half is scored there", scored.answers.length === 1);

    const withAi = totalise({
      answers: [
        ...scored.answers,
        { questionId: short._id, type: "short", textAnswer: "x", aiScore: 2, aiMax: 3, aiConfidence: "high" },
      ],
      mcqScore: scored.mcqScore,
      shortMax: 3,
      aiShortScore: 2,
      maxGrade: form.maxGrade,
    });
    check("a full paper totals its marks", withAi.totalScore === 3 && withAi.maxGrade === 4);
    check("the percentage is rounded to one decimal", withAi.percent === 75);
    check("a confident AI grade needs no teacher", withAi.needsReview === false);

    const lowConfidence = totalise({
      answers: [
        ...scored.answers,
        { questionId: short._id, type: "short", textAnswer: "x", aiScore: 0, aiMax: 3, aiConfidence: "low" },
      ],
      mcqScore: 1,
      shortMax: 3,
      aiShortScore: 0,
      maxGrade: 4,
    });
    check("a low-confidence answer waits for a teacher", lowConfidence.needsReview === true);

    const overridden = totalise({
      answers: [
        ...scored.answers,
        { questionId: short._id, type: "short", textAnswer: "x", aiScore: 0, aiMax: 3, aiConfidence: "low", teacherScore: 3 },
      ],
      mcqScore: 1,
      shortMax: 3,
      aiShortScore: 0,
      maxGrade: 4,
    });
    check("a teacher's mark beats the AI's", overridden.shortScore === 3 && overridden.totalScore === 4 && overridden.percent === 100);
    check("an overridden answer no longer needs review", overridden.needsReview === false);

    check("a grade above the maximum is clamped", totalise({
      answers: [{ questionId: short._id, type: "short", textAnswer: "x", aiScore: 99, aiMax: 3, aiConfidence: "high" }],
      mcqScore: 0,
      shortMax: 3,
      aiShortScore: 99,
      maxGrade: 4,
    }).shortScore === 3);

    check("an empty paper is zero, not a divide by zero", (() => {
      const empty = totalise({ answers: [], mcqScore: 0, shortMax: 0, aiShortScore: 0, maxGrade: 0 });
      return empty.percent === 0 && empty.totalScore === 0;
    })());
  }

  /* ---------------------------------------------------------------- */
  /* A teacher marking a written answer by hand                        */
  /* ---------------------------------------------------------------- */

  {
    const shortId = "6510000000000000000000a1";
    const mcqId = "6510000000000000000000a2";
    const maxById = new Map([
      [shortId, 4],
      [mcqId, 1],
    ]);
    const base: IAttemptAnswer[] = [
      { questionId: shortId, type: "short", textAnswer: "بضرب", aiScore: 1, aiMax: 4, aiConfidence: "low" },
      { questionId: mcqId, type: "mcq", chosenOptionId: "o1", isCorrect: true, textAnswer: "" },
    ];

    const set = applyTeacherOverride(base, { questionId: shortId, teacherScore: 3, teacherFeedback: " fight " }, maxById);
    check("a teacher's mark is written onto the answer", set.ok && set.changed && set.answers[0].teacherScore === 3);
    check("with their note, trimmed", set.ok && set.answers[0].teacherFeedback === "fight");
    check("and the original answers are not mutated", base[0].teacherScore === undefined);

    check("a live Mongoose subdocument is copied by value, not by its plumbing", (() => {
      // The routes pass the subdocuments straight off a fetched attempt: the fields
      // sit under `_doc` and are reached through getters, so they read fine but
      // spread as nothing. Copying one by spread therefore produced an answer with
      // no `type`, which `totalise` then dropped from the total — a mark the teacher
      // could see and the mark sheet could not. `toObject()` is the way out.
      const doc: Record<string, unknown> = { ...base[0] };
      const subdoc: Record<string, unknown> = {
        _doc: doc,
        toObject: () => ({ ...doc }),
      };
      for (const [key, value] of Object.entries(doc)) {
        Object.defineProperty(subdoc, key, { get: () => doc[key], enumerable: false });
      }
      const live = applyTeacherOverride(
        [subdoc as unknown as IAttemptAnswer, base[1]],
        { questionId: shortId, teacherScore: 3 },
        maxById
      );
      const totals = totalise({
        answers: live.ok ? live.answers : [],
        mcqScore: 1,
        shortMax: 4,
        aiShortScore: 1,
        maxGrade: 5,
      });
      return (
        live.ok &&
        live.answers[0].type === "short" &&
        live.answers[0].teacherScore === 3 &&
        totals.shortScore === 3 &&
        totals.totalScore === 4
      );
    })());

    check("a mark above the question's own maximum is clamped", (() => {
      const over = applyTeacherOverride(base, { questionId: shortId, teacherScore: 99 }, maxById);
      return over.ok && over.answers[0].teacherScore === 4;
    })());
    check("a negative mark is clamped to zero", (() => {
      const under = applyTeacherOverride(base, { questionId: shortId, teacherScore: -5 }, maxById);
      return under.ok && under.answers[0].teacherScore === 0;
    })());
    check("a fractional mark is kept, at two places", (() => {
      const half = applyTeacherOverride(base, { questionId: shortId, teacherScore: 1.5 }, maxById);
      return half.ok && half.answers[0].teacherScore === 1.5;
    })());

    check("a multiple-choice answer cannot be marked by hand", (() => {
      const mcq = applyTeacherOverride(base, { questionId: mcqId, teacherScore: 1 }, maxById);
      return !mcq.ok && /written answers/.test(mcq.reason);
    })());
    check("a question the student never answered cannot be marked", (() => {
      const missing = applyTeacherOverride(base, { questionId: "6510000000000000000000ff", teacherScore: 1 }, maxById);
      return !missing.ok && /not answered/.test(missing.reason);
    })());
    check("a non-numeric mark is refused rather than stored as zero", (() => {
      const text = applyTeacherOverride(base, { questionId: shortId, teacherScore: "good" }, maxById);
      return !text.ok && /number/.test(text.reason);
    })());
    check("a question id is required", !applyTeacherOverride(base, { questionId: "  " }, maxById).ok);

    check("clearing an override hands the answer back to the AI's mark", (() => {
      const marked = applyTeacherOverride(base, { questionId: shortId, teacherScore: 3 }, maxById);
      if (!marked.ok) return false;
      const cleared = applyTeacherOverride(marked.answers, { questionId: shortId, teacherScore: null }, maxById);
      if (!cleared.ok) return false;
      const after = cleared.answers[0];
      return (
        after.teacherScore === undefined &&
        after.teacherFeedback === undefined &&
        after.overriddenBy === undefined &&
        after.overriddenAt === undefined
      );
    })());
    check("and a cleared answer goes back to needing review if the AI was unsure", (() => {
      const marked = applyTeacherOverride(base, { questionId: shortId, teacherScore: 3 }, maxById);
      if (!marked.ok) return false;
      const cleared = applyTeacherOverride(marked.answers, { questionId: shortId, teacherScore: null }, maxById);
      if (!cleared.ok) return false;
      return totalise({
        answers: cleared.answers,
        mcqScore: 1,
        shortMax: 4,
        aiShortScore: 1,
        maxGrade: 5,
      }).needsReview === true;
    })());
    check("setting the same mark again reports no change", (() => {
      const marked = applyTeacherOverride(base, { questionId: shortId, teacherScore: 3 }, maxById);
      if (!marked.ok) return false;
      const again = applyTeacherOverride(marked.answers, { questionId: shortId, teacherScore: 3 }, maxById);
      return again.ok && again.changed === false;
    })());
    check("a teacher's note is capped like an answer", (() => {
      const long = applyTeacherOverride(
        base,
        { questionId: shortId, teacherScore: 1, teacherFeedback: "x".repeat(5_000) },
        maxById
      );
      return long.ok && (long.answers[0].teacherFeedback ?? "").length <= 2_000;
    })());
    check("the mark flows straight into the total", (() => {
      const marked = applyTeacherOverride(base, { questionId: shortId, teacherScore: 4 }, maxById);
      if (!marked.ok) return false;
      const totals = totalise({
        answers: marked.answers,
        mcqScore: 1,
        shortMax: 4,
        aiShortScore: 1,
        maxGrade: 5,
      });
      return totals.shortScore === 4 && totals.totalScore === 5 && totals.percent === 100 && totals.needsReview === false;
    })());
  }

  /* ---------------------------------------------------------------- */
  /* Windows, deadlines and the attempt cap                             */
  /* ---------------------------------------------------------------- */

  {
    const now = new Date("2026-03-01T10:00:00Z");
    const published = { status: "published" as const, openUntil: null };
    const closing = new Date("2026-03-01T09:59:00Z");
    const later = new Date("2026-03-01T10:01:00Z");

    check("a published set is open", availability(published, now).ok === true);
    check("a draft set is not", availability({ status: "draft", openUntil: null }, now).ok === false);
    check("a closed set is not", availability({ status: "closed", openUntil: null }, now).ok === false);
    check("a set past its closing time is shut", availability({ ...published, openUntil: closing }, now).ok === false);
    check("a set before its closing time is open", availability({ ...published, openUntil: later }, now).ok === true);

    const started = new Date("2026-03-01T09:50:00Z");
    check("a limited draft has a deadline", draftDeadline({ createdAt: started, timeLimitMinutes: 15 }, now)!.toISOString() === "2026-03-01T10:05:00.000Z");
    check("an unlimited draft has none", draftDeadline({ createdAt: started }, now) === null);
    check("a live draft is still open", draftStillOpen({ createdAt: started, timeLimitMinutes: 15 }, now).ok === true);
    check("an expired draft is shut", draftStillOpen({ createdAt: started, timeLimitMinutes: 5 }, now).ok === false);
    check(
      "a submit already in flight when the clock runs out still counts",
      draftStillOpen(
        { createdAt: started, timeLimitMinutes: 5 },
        new Date(started.getTime() + (5 + SUBMIT_GRACE_MINUTES - 1) * 60_000),
        SUBMIT_GRACE_MINUTES
      ).ok === true
    );
    check(
      "but the grace period is short, not an extension",
      draftStillOpen(
        { createdAt: started, timeLimitMinutes: 5 },
        new Date(now.getTime() + (5 + SUBMIT_GRACE_MINUTES + 1) * 60_000),
        SUBMIT_GRACE_MINUTES
      ).ok === false
    );
    check("the deadline does not move when the draft is resumed", (() => {
      const first = draftDeadline({ createdAt: started, timeLimitMinutes: 15 }, now);
      const later2 = draftDeadline({ createdAt: new Date(now.getTime() + 4 * 60_000), timeLimitMinutes: 15 }, now);
      return first!.toISOString() !== later2!.toISOString();
    })());

    check("attempts are counted against the set's cap", attemptsLeft(3, 1) === 2);
    check("a used-up cap leaves none", attemptsLeft(2, 2) === 0);
    check("an overshoot stays at zero rather than going negative", attemptsLeft(2, 5) === 0);
    check("a set with no cap gets the default", attemptsLeft(undefined, 0) === 2);
    check("a set asking for zero attempts is treated as unset", attemptsLeft(0, 0) === 2);
  }

  /* ---------------------------------------------------------------- */
  /* The result                                                         */
  /* ---------------------------------------------------------------- */

  {
    const form = stubForm();
    const [mcq, short] = form.questions;
    const plan = buildShufflePlan(
      [mcq, short].map((q) => ({ _id: q._id, type: q.type, options: q.options ?? [] })),
      "result-seed"
    );
    const attempt = {
      _id: new Types.ObjectId(),
      examSetId: new Types.ObjectId(),
      formId: form._id,
      questionOrder: plan.questionOrder,
      optionOrder: new Map(Object.entries(plan.optionOrder)),
      answers: [
        { questionId: mcq._id, type: "mcq", chosenOptionId: "o2", isCorrect: true, textAnswer: "" },
        { questionId: short._id, type: "short", textAnswer: "لأن المجموع ثابت", aiScore: 2, aiMax: 3, aiFeedback: "إجابة صحيحة", aiConfidence: "medium" },
      ],
      status: "graded" as const,
      mcqScore: 1,
      shortScore: 2,
      totalScore: 3,
      maxGrade: 4,
      percent: 75,
      needsReview: false,
      submittedAt: new Date(),
      gradedAt: new Date(),
      createdAt: new Date(),
    } as unknown as IExamAttempt;

    const result = serialiseAttempt(attempt, form) as {
      questions: Array<Record<string, unknown>>;
      percent: number;
    };
    const first = result.questions[0];
    const onResult = (id: string) => result.questions.find((q) => q.id === id)!;

    check("the result is in the order the student saw", result.questions[0].id === plan.questionOrder[0]);
    check("the result carries the key it withheld before", onResult(String(mcq._id)).correctOptionId === "o2");
    check("and the explanation", onResult(String(mcq._id)).explanation === "الجمع المباشر");
    check("a short answer gets its model answer and rubric", (() => {
      const row = onResult(String(short._id));
      return row.modelAnswer === "لأن المجموع ثابت" && JSON.stringify(row.rubric) === JSON.stringify(["يذكر الشرط", "يذكر السبب"]);
    })());
    check("the student's own choice comes back", onResult(String(mcq._id)).chosenOptionId === "o2");
    check("their text comes back", onResult(String(short._id)).textAnswer === "لأن المجموع ثابت");
    check("the AI's score and feedback come back", onResult(String(short._id)).aiScore === 2 && onResult(String(short._id)).aiFeedback === "إجابة صحيحة");
    check("the total is reported", result.percent === 75);
    check("an unattempted paper is not invented", (() => {
      const bare = serialiseAttempt({ ...attempt, answers: [] } as unknown as IExamAttempt, form) as {
        questions: Array<Record<string, unknown>>;
      };
      return bare.questions.every((q) => q.chosenOptionId === null && q.textAnswer === "");
    })());
    check("a missing question is skipped rather than rendered blank", (() => {
      const trimmed = serialiseAttempt({ ...attempt, questionOrder: [...attempt.questionOrder, new Types.ObjectId()] } as unknown as IExamAttempt, form) as {
        questions: unknown[];
      };
      return trimmed.questions.length === 2;
    })());
    check("the stored order wins over any recomputation", (() => {
      const forced = serialiseAttempt({ ...attempt, questionOrder: [String(short._id), String(mcq._id)] } as unknown as IExamAttempt, form) as {
        questions: Array<Record<string, unknown>>;
      };
      return forced.questions[0].id === String(short._id) && first.id === plan.questionOrder[0];
    })());
    check("a teacher override is what the student is shown", (() => {
      const taught = serialiseAttempt({
        ...attempt,
        answers: [{ ...attempt.answers[1], teacherScore: 3, teacherFeedback: "بعد المراجعة" }],
      } as unknown as IExamAttempt, form) as { questions: Array<Record<string, unknown>> };
      return taught.questions.find((q) => q.id === String(short._id))!.aiScore === 3;
    })());
  }

  /* ---------------------------------------------------------------- */
  /* Balanced assignment                                                */
  /* ---------------------------------------------------------------- */

  const roster = (n: number, active = true): AssignableStudent[] =>
    Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, active }));

  {
    const labels = ["A", "B", "C"];
    const even = planBalancedAssignment(roster(30), labels);
    check("spreads 30 students over 3 forms", JSON.stringify(even.perForm) === JSON.stringify({ A: 10, B: 10, C: 10 }), JSON.stringify(even.perForm));
    check("every student gets a form", even.plan.length === 30);
    check("no form is used twice in a row", (() => {
      for (let i = 1; i < even.plan.length; i++) {
        if (even.plan[i].formLabel === even.plan[i - 1].formLabel) return false;
      }
      return true;
    })());
    check("a remainder spreads rather than piling up", (() => {
      const seven = planBalancedAssignment(roster(7), labels);
      return Math.max(...Object.values(seven.perForm)) - Math.min(...Object.values(seven.perForm)) <= 1;
    })());
    check("a single student gets a paper", planBalancedAssignment(roster(1), labels).plan[0]?.formLabel === "A");
    check("no students means no assignments", planBalancedAssignment([], labels).plan.length === 0);

    // Re-publishing is the case that matters: a teacher may have re-run publish,
    // or moved two students by hand. Neither may be reshuffled.
    const existing = new Map([
      ["s1", "C"],
      ["s2", "C"],
      ["s3", "B"],
    ]);
    const again = planBalancedAssignment(roster(6), labels, existing);
    check("re-publishing keeps existing papers", ["s1", "s2", "s3"].every((id) => {
      const kept = again.plan.find((p) => p.studentId === id);
      return kept?.formLabel === existing.get(id);
    }));
    check("re-publishing tops up the rest", again.plan.length === 6);
    check("re-publishing evens the spread out", (() => {
      const counts = Object.values(again.perForm);
      return Math.max(...counts) - Math.min(...counts) <= 1;
    })());
    check("an unknown existing label is replaced, not trusted", (() => {
      const stale = new Map([["s1", "Z"]]);
      const fixed = planBalancedAssignment(roster(4), labels, stale);
      return fixed.plan.find((p) => p.studentId === "s1")?.formLabel !== "Z" && fixed.plan.length === 4;
    })());

    const withInactive = planBalancedAssignment(
      [...roster(2), { id: "s3", active: false }, ...roster(2, true)],
      labels
    );
    check("deactivated students are skipped", withInactive.skippedInactive === 1 && withInactive.plan.length === 4);
    check("a deactivated student keeps a paper they already had", (() => {
      const back = planBalancedAssignment(
        [{ id: "s3", active: false }],
        labels,
        new Map([["s3", "B"]])
      );
      return back.plan.length === 1 && back.plan[0].formLabel === "B" && back.skippedInactive === 0;
    })());
    check("more students than forms is fine", planBalancedAssignment(roster(7), ["A", "B"]).plan.length === 7);
    check("no forms at all deals nothing", (() => {
      const none = planBalancedAssignment(roster(5), []);
      return none.plan.length === 0 && none.perForm.A === undefined;
    })());
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
