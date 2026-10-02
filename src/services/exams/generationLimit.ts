/**
 * Per-teacher throttle for the expensive AI steps (blueprint, form generation,
 * verify, single-question repair).
 *
 * Generation is the one endpoint family where a runaway client can burn the
 * Gemini quota for the whole school: one "Generate" click is 1 blueprint + N
 * forms + N verifications, each of which may retry with backoff. The budget below
 * is deliberately generous for real use — a teacher generating three forms for
 * the week — while still stopping a loop of retries.
 *
 * The window is in-process. That is enough for a single instance and costs
 * nothing, and it is the only option that does not add a dependency: serverless
 * invocations are short-lived, so a shared store would be more machinery than the
 * quota is worth.
 */

interface Budget {
  /** Epoch ms at which every slot in the window frees up. */
  resetsAt: number;
  used: number;
}

const WINDOW_MS = 60_000;

/** `1 blueprint + 4 forms + 4 verifications` with headroom for retries. */
const DEFAULT_LIMIT = Number(process.env.AI_EXAM_CALLS_PER_MINUTE || 40);

const budgets = new Map<string, Budget>();

/** Called on every AI exam step. Throws with a 429-shaped message. */
export function assertWithinGenerationBudget(teacherId: string, limit = DEFAULT_LIMIT): void {
  const now = Date.now();
  const budget = budgets.get(teacherId);

  if (!budget || budget.resetsAt <= now) {
    budgets.set(teacherId, { resetsAt: now + WINDOW_MS, used: 1 });
    return;
  }

  if (budget.used >= limit) {
    const waitSeconds = Math.ceil((budget.resetsAt - now) / 1000);
    throw Object.assign(
      new Error(`Too many AI requests. Try again in ${waitSeconds}s.`),
      { statusCode: 429 }
    );
  }

  budget.used += 1;
}

/** Test seam: forget one teacher's budget, or all of them. */
export function resetGenerationBudget(teacherId?: string): void {
  if (teacherId) budgets.delete(teacherId);
  else budgets.clear();
}
