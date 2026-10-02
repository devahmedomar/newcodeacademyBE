import { Types } from "mongoose";
import { ExamAssignment, type IExamAssignment } from "../../models/ExamAssignment";
import { User } from "../../models/User";

/** The ref type a document field carries, as opposed to a constructed `ObjectId`. */
type RefId = IExamAssignment["studentId"];

/**
 * Mongoose's two `ObjectId` classes — the one you get from `new Types.ObjectId()`
 * and the one its generated document types name — are the same value with two
 * type identities. This is the one place that gap is bridged.
 */
const asRef = (id: Types.ObjectId | string): RefId => id as unknown as RefId;

/**
 * Turning a finished exam set into one paper per student.
 *
 * The balancing itself is a pure function so it can be tested without a database:
 * given an ordered list of students and the form labels, decide who gets what.
 * Nothing here talks to Gemini, and nothing here re-reads a question — publishing
 * is bookkeeping.
 */

export interface AssignableStudent {
  id: string;
  active: boolean;
}

export interface PlannedAssignment {
  studentId: string;
  formLabel: string;
  source: "auto";
}

export interface BalanceResult {
  plan: PlannedAssignment[];
  /** Students skipped because their account is deactivated. */
  skippedInactive: number;
  /** How many students ended up on each form, keyed by label. */
  perForm: Record<string, number>;
}

/**
 * Deal the forms out in rotation.
 *
 * Rotation over the student's existing order is the whole algorithm: with 3 forms
 * and 40 students the papers come out 14/13/13, so nobody can be identified by
 * which paper they were holding. Existing assignments are respected — a teacher
 * who moved two students by hand, or a set that is being re-published, must not
 * have those rows silently reshuffled under them.
 *
 * The rotation is seeded by the forms that are *least* used rather than starting
 * at A every time, so adding a form or re-publishing keeps the spread even instead
 * of piling everyone back onto the first paper.
 */
export function planBalancedAssignment(
  students: AssignableStudent[],
  labels: string[],
  existing: Map<string, string> = new Map()
): BalanceResult {
  const order = [...labels].sort();
  if (order.length === 0) {
    return { plan: [], skippedInactive: 0, perForm: {} };
  }

  // Start from the least-used form so the spread survives re-publishing.
  const used = new Map<string, number>(order.map((l) => [l, 0]));
  for (const label of existing.values()) {
    if (used.has(label)) used.set(label, (used.get(label) ?? 0) + 1);
  }
  const leastUsed = (): string => {
    let best = order[0];
    for (const label of order) {
      if ((used.get(label) ?? 0) < (used.get(best) ?? 0)) best = label;
    }
    return best;
  };

  const plan: PlannedAssignment[] = [];
  const perForm: Record<string, number> = Object.fromEntries(order.map((l) => [l, 0]));
  let skippedInactive = 0;

  for (const student of students) {
    const kept = existing.get(student.id);
    if (kept && used.has(kept)) {
      // Already dealt a paper: keep it and count it towards the balance.
      plan.push({ studentId: student.id, formLabel: kept, source: "auto" });
      perForm[kept] = (perForm[kept] ?? 0) + 1;
      continue;
    }
    if (!student.active) {
      skippedInactive += 1;
      continue;
    }
    const label = leastUsed();
    used.set(label, (used.get(label) ?? 0) + 1);
    perForm[label] = (perForm[label] ?? 0) + 1;
    plan.push({ studentId: student.id, formLabel: label, source: "auto" });
  }

  return { plan, skippedInactive, perForm };
}

/** The student roster a set is published to, in the order the dashboard lists them. */
export async function loadAssignableStudents(): Promise<AssignableStudent[]> {
  const users = await User.find({ role: "student" }).sort({ name: 1 }).select("name active").lean();
  return users.map((u) => ({ id: String(u._id), active: u.active !== false }));
}

/**
 * Write the plan.
 *
 * One upsert per row on the unique `{examSetId, studentId}` index, so a repeated
 * publish is a no-op rather than a duplicate. `source` and `assignedAt` are
 * insert-only: a row a teacher moved keeps saying so, and keeps the date it was
 * first dealt.
 */
export async function saveAssignments(
  examSetId: Types.ObjectId | string,
  plan: PlannedAssignment[],
  formIdsByLabel: Map<string, string>
): Promise<number> {
  const setId = asRef(new Types.ObjectId(String(examSetId)));
  const now = new Date();
  const rows = plan
    .filter((p) => formIdsByLabel.has(p.formLabel))
    .map((p) => ({
      examSetId: setId,
      studentId: asRef(new Types.ObjectId(p.studentId)),
      formId: asRef(new Types.ObjectId(formIdsByLabel.get(p.formLabel)!)),
      formLabel: p.formLabel,
      source: p.source,
      assignedAt: now,
    }));

  if (rows.length === 0) return 0;
  const result = await ExamAssignment.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { examSetId: row.examSetId, studentId: row.studentId },
        update: {
          $set: { formId: row.formId, formLabel: row.formLabel },
          $setOnInsert: {
            examSetId: row.examSetId,
            studentId: row.studentId,
            source: row.source,
            assignedAt: row.assignedAt,
          },
        },
        upsert: true,
      },
    }))
  );
  return result.upsertedCount + result.modifiedCount;
}

/** Existing assignments as `studentId → formLabel`, for the balancer to respect. */
export async function existingLabelsByStudent(
  examSetId: Types.ObjectId | string
): Promise<Map<string, string>> {
  const rows = await ExamAssignment.find({ examSetId })
    .select("studentId formLabel")
    .lean<Array<{ studentId: RefId; formLabel: string }>>();
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(String(row.studentId), row.formLabel);
  }
  return map;
}
