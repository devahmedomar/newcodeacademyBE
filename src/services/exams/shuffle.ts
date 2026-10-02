import type { Types } from "mongoose";

/**
 * The second layer of anti-copying: even two students on the same form must not see
 * the same paper.
 *
 * The permutation is generated once, from a seed, and then persisted on the attempt.
 * It is a pure function of `(seed, ids)` so it can be tested without a database and
 * re-derived from a stored attempt if it is ever lost, but the stored copy is the one
 * that counts.
 *
 * A seed rather than `Math.random()` matters for one reason: a student who refreshes
 * mid-exam and asks the server to hand their paper back again must get *the same
 * paper*. Regenerating a fresh shuffle on every request would quietly reorder the
 * questions under someone who was mid-answer.
 */

export type RefId = Types.ObjectId;

export interface ShufflePlan {
  questionOrder: string[];
  optionOrder: Record<string, string[]>;
}

/**
 * A 32-bit string hash (FNV-1a).
 *
 * Only needs to be stable and well spread — this is not security, it is a way of
 * turning `studentId:formId:attemptId` into a starting point for a shuffle.
 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A small deterministic generator, so the same seed always produces the same paper.
 *
 * `Math.random()` is not reproducible and `crypto` is not needed: this only has to
 * spread a 40-element array differently per student.
 */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates with a seeded generator. Returns a new array. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build the paper this student will see.
 *
 * Every question is reordered, and every MCQ's options are reordered independently.
 * Option *ids* are what travel — the client never learns a position, so a student
 * cannot answer "the third one" and be right or wrong by accident when the order
 * changes underneath them.
 */
export function buildShufflePlan(
  questions: Array<{ _id: RefId; type: string; options: Array<{ id: string }> }>,
  seed: string
): ShufflePlan {
  const base = hashSeed(seed);
  const questionOrder = seededShuffle(
    questions.map((q) => String(q._id)),
    base
  );

  const optionOrder: Record<string, string[]> = {};
  questions.forEach((q, index) => {
    const ids = q.options.map((o) => o.id);
    if (ids.length < 2) {
      // A one-option or zero-option question has nothing to shuffle.
      optionOrder[String(q._id)] = ids;
      return;
    }
    // A different stream per question, so one question's shuffle cannot shift another's.
    optionOrder[String(q._id)] = seededShuffle(ids, hashSeed(`${base}:${String(q._id)}:${index}`));
  });

  return { questionOrder, optionOrder };
}

/** The seed for an attempt. Stable for the same three ids, and unique per sitting. */
export function attemptSeed(
  examSetId: Types.ObjectId | string,
  studentId: Types.ObjectId | string,
  formId: Types.ObjectId | string,
  nonce: Types.ObjectId | string
): string {
  return `${String(examSetId)}:${String(studentId)}:${String(formId)}:${String(nonce)}`;
}
