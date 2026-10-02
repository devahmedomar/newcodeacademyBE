import { ExamGrade } from "../models/ExamGrade";
import { ExamTemplate } from "../models/ExamTemplate";
import { Homework } from "../models/Homework";
import { QuizAttempt } from "../models/QuizAttempt";
import { ExamAttempt } from "../models/ExamAttempt";

/**
 * One place to answer "how many points does a student have, and where did they
 * come from".
 *
 * This used to be open-coded in three places (leaderboard, student profile,
 * badges) that had already drifted apart, so adding the AI-exam bucket would
 * have made it four. Two rules are load-bearing and are enforced here so the
 * callers cannot disagree:
 *
 *  - A repeated sitting counts once. Quiz attempts count their best attempt per
 *    quiz and AI exam attempts their best sitting per set (`MAX_EXAM_ATTEMPTS`
 *    allows a second try), so neither the numerator nor the denominator grows
 *    for a re-sit.
 *  - A draft attempt counts for nothing. `status: "draft"` is an in-progress
 *    sitting whose scores are still zero, so it is excluded everywhere.
 */
export interface PointsBucket {
  earned: number;
  possible: number;
}

export interface PointsBuckets {
  quizzes: PointsBucket;
  homeworks: PointsBucket;
  exams: PointsBucket;
  aiExams: PointsBucket;
  total: PointsBucket;
}

const GRADED_STATUSES = ["submitted", "graded", "grading_failed"];

function empty(): PointsBucket {
  return { earned: 0, possible: 0 };
}

function totalOf(buckets: Omit<PointsBuckets, "total">): PointsBucket {
  return Object.values(buckets).reduce<PointsBucket>(
    (acc, b) => ({ earned: acc.earned + b.earned, possible: acc.possible + b.possible }),
    empty()
  );
}

function percentOf(b: PointsBucket): number {
  return b.possible > 0 ? Math.round((b.earned / b.possible) * 100) : 0;
}

/** A sitting of an AI-generated set, reduced to what points care about. */
export interface AiExamBest {
  setId: string;
  earned: number;
  possible: number;
  percent: number;
}

/**
 * The student's best sitting of each AI exam set.
 *
 * "Best" is percent first, then raw score, then the earliest submission — the
 * last key only exists so a tie cannot reshuffle between two identical papers.
 * Sets with a zero `maxGrade` are dropped: they would add earned points against
 * no denominator and skew every percentage they appear in.
 */
function bestAiAttempts(
  rows: Array<{
    examSetId: unknown;
    totalScore: number;
    maxGrade: number;
    percent: number;
    submittedAt?: Date;
  }>
): AiExamBest[] {
  const best = new Map<string, AiExamBest & { at: number }>();
  for (const r of rows) {
    if (!r.maxGrade || r.maxGrade <= 0) continue;
    const setId = String(r.examSetId);
    const cur = best.get(setId);
    const better =
      !cur ||
      r.percent > cur.percent ||
      (r.percent === cur.percent && r.totalScore > cur.earned);
    if (better) {
      best.set(setId, {
        setId,
        earned: r.totalScore,
        possible: r.maxGrade,
        percent: r.percent,
        at: r.submittedAt ? new Date(r.submittedAt).getTime() : Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.percent - a.percent || b.earned - a.earned || a.at - b.at)
    .map(({ setId, earned, possible, percent }) => ({ setId, earned, possible, percent }));
}

function sumAi(rows: AiExamBest[]): PointsBucket {
  return rows.reduce<PointsBucket>(
    (acc, r) => ({ earned: acc.earned + r.earned, possible: acc.possible + r.possible }),
    empty()
  );
}

/** Best sitting per AI exam set for one student. */
export async function aiExamBests(studentId: unknown): Promise<AiExamBest[]> {
  const rows = await ExamAttempt.find({ studentId, status: { $in: GRADED_STATUSES } })
    .select("examSetId totalScore maxGrade percent submittedAt")
    .lean();
  return bestAiAttempts(rows);
}

/**
 * The student's percentage on every manual exam they were graded on.
 *
 * The profile and the leaderboard only need the totals, but the `exam_90` badge
 * needs to know about one exam in particular, so the percentages come back
 * alongside the buckets instead of costing a second round of queries.
 */
async function manualExamPercents(
  gradeRows: unknown
): Promise<number[]> {
  const rows = gradeRows as Array<{ grade: number; examId: { maxGrade: number } | null }>;
  return rows
    .filter((r) => r.examId && r.examId.maxGrade > 0)
    .map((r) => Math.round((r.grade / r.examId!.maxGrade) * 100));
}

export interface StudentPoints extends PointsBuckets {
  /** Percentage on each manual exam, for the legacy `exam_90` badge. */
  manualExamPercents: number[];
  /** Best sitting of each AI exam set, for the AI badges. */
  aiExamBests: AiExamBest[];
}

/**
 * Every bucket for one student plus the per-exam detail the badges need, in one
 * set of queries. The manual `exams` bucket keeps its original behaviour: one
 * `ExamGrade` row per exam per student, so summing the rows is already
 * "best of one".
 */
export async function studentPoints(studentId: unknown): Promise<StudentPoints> {
  const [quizRows, hwRows, gradeRows, aiRows] = await Promise.all([
    QuizAttempt.find({ studentId }).select("quizId score total").lean(),
    Homework.find({ studentId }).select("points maxPoints").lean(),
    ExamGrade.find({ studentId }).populate("examId", "maxGrade").lean(),
    ExamAttempt.find({ studentId, status: { $in: GRADED_STATUSES } })
      .select("examSetId totalScore maxGrade percent submittedAt")
      .lean(),
  ]);

  const bestByQuiz = new Map<string, { score: number; total: number }>();
  for (const a of quizRows) {
    const id = String(a.quizId);
    const cur = bestByQuiz.get(id);
    if (!cur || a.score > cur.score) bestByQuiz.set(id, { score: a.score, total: a.total });
  }

  const quizzes = [...bestByQuiz.values()].reduce<PointsBucket>(
    (acc, a) => ({ earned: acc.earned + a.score, possible: acc.possible + a.total }),
    empty()
  );
  const homeworks = hwRows.reduce<PointsBucket>(
    (acc, h) => ({ earned: acc.earned + h.points, possible: acc.possible + h.maxPoints }),
    empty()
  );
  const grades = gradeRows as unknown as Array<{
    grade: number;
    examId: { maxGrade: number } | null;
  }>;
  const exams = grades.reduce<PointsBucket>(
    (acc, e) => ({
      earned: acc.earned + (e.examId ? e.grade : 0),
      possible: acc.possible + (e.examId ? e.examId.maxGrade : 0),
    }),
    empty()
  );
  const aiExamBests = bestAiAttempts(aiRows);
  const aiExams = sumAi(aiExamBests);

  return {
    quizzes,
    homeworks,
    exams,
    aiExams,
    total: totalOf({ quizzes, homeworks, exams, aiExams }),
    manualExamPercents: await manualExamPercents(gradeRows),
    aiExamBests,
  };
}

/** Just the buckets, for callers that do not need the per-exam detail. */
export async function pointsForStudent(studentId: unknown): Promise<PointsBuckets> {
  const { quizzes, homeworks, exams, aiExams, total } = await studentPoints(studentId);
  return { quizzes, homeworks, exams, aiExams, total };
}

/** Point totals for every student who has earned anything, keyed by user id. */
export async function leaderboardBuckets(): Promise<Map<string, PointsBucket>> {
  const examTemplateColl = ExamTemplate.collection.name;
  const [examAgg, homeworkAgg, quizAgg, aiAgg] = await Promise.all([
    ExamGrade.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $lookup: { from: examTemplateColl, localField: "examId", foreignField: "_id", as: "tmpl" } },
      { $unwind: "$tmpl" },
      { $group: { _id: "$studentId", earned: { $sum: "$grade" }, possible: { $sum: "$tmpl.maxGrade" } } },
    ]),
    Homework.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $group: { _id: "$studentId", earned: { $sum: "$points" }, possible: { $sum: "$maxPoints" } } },
    ]),
    QuizAttempt.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $sort: { score: -1 } },
      {
        $group: {
          _id: { studentId: "$studentId", quizId: "$quizId" },
          score: { $first: "$score" },
          total: { $first: "$total" },
        },
      },
      { $group: { _id: "$_id.studentId", earned: { $sum: "$score" }, possible: { $sum: "$total" } } },
    ]),
    ExamAttempt.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $match: { status: { $in: GRADED_STATUSES }, maxGrade: { $gt: 0 } } },
      // Best sitting per student per set, then one row per student. The trailing
      // sort keys only break exact ties so the leaderboard cannot reshuffle.
      {
        $sort: {
          studentId: 1,
          examSetId: 1,
          percent: -1,
          totalScore: -1,
          submittedAt: 1,
          _id: 1,
        },
      },
      {
        $group: {
          _id: { studentId: "$studentId", examSetId: "$examSetId" },
          earned: { $first: "$totalScore" },
          possible: { $first: "$maxGrade" },
        },
      },
      { $group: { _id: "$_id.studentId", earned: { $sum: "$earned" }, possible: { $sum: "$possible" } } },
    ]),
  ]);

  const acc = new Map<string, PointsBucket>();
  const add = (rows: Array<{ _id: unknown; earned: number; possible: number }>) => {
    for (const r of rows) {
      const key = String(r._id);
      const cur = acc.get(key) ?? empty();
      acc.set(key, {
        earned: cur.earned + r.earned,
        possible: cur.possible + r.possible,
      });
    }
  };
  add(examAgg);
  add(homeworkAgg);
  add(quizAgg);
  add(aiAgg);
  return acc;
}

export { percentOf };
