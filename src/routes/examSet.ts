import { Router, type RequestHandler } from "express";
import * as set from "../controllers/examSetController";
import * as attempt from "../controllers/attemptController";
import { authGuard, roleGuard, type AuthRequest } from "../middleware/auth";

/**
 * AI exam pipeline.
 *
 * `authGuard` is applied to the whole router and the teacher-only routes add
 * `roleGuard` on top, because the role lives on the user that `authGuard` attaches.
 * The router is no longer teacher-only: `GET /` is role-aware so a student asking
 * for their exam list does not have to guess a second path, while every route that
 * can spend a teacher's Gemini quota or touch a paper stays behind the role guard.
 *
 * The generation endpoints are one request per step on purpose — the client asks
 * for the blueprint, then each form in turn — so a long pipeline never has to
 * finish inside a single serverless invocation.
 */

const guard = [authGuard, roleGuard("teacher")] as const;
const studentOnly = [authGuard, roleGuard("student")] as const;

/**
 * `GET /:id` is the one path both roles use, and they mean different things by it:
 * a teacher gets the set with its blueprint and answer keys, a student gets their
 * own shuffled paper with the key stripped. Keeping it on one path means the portal
 * never has to know which of the two it is looking at.
 */
const examSetForCaller: RequestHandler = (req, res) => {
  const authReq = req as AuthRequest;
  if (authReq.user?.role === "student") return attempt.getMyPaper(authReq, res);
  return set.getExamSet(authReq, res);
};

/** Mounted at `/api/exam-sets`. */
export const examSetRoutes = Router();
examSetRoutes.use(authGuard);

// Role-aware: teachers get their own sets, students get the ones assigned to them.
examSetRoutes.get("/", set.listExamSetsForCaller);
examSetRoutes.get("/:id", examSetForCaller);

examSetRoutes.post("/", ...guard, set.createExamSet);
examSetRoutes.put("/:id", ...guard, set.updateExamSet);
examSetRoutes.delete("/:id", ...guard, set.deleteExamSet);

examSetRoutes.post("/:id/blueprint", ...guard, set.createBlueprint);
examSetRoutes.post("/:id/forms/:label", ...guard, set.createForm);

// Publish, unpublish, and the roster of papers. `:studentId` is the student's user
// id, which is why the override lives under the set rather than under the student.
examSetRoutes.post("/:id/publish", ...guard, set.publishExamSet);
examSetRoutes.patch("/:id/status", ...guard, set.setExamStatus);
examSetRoutes.get("/:id/assignments", ...guard, set.listAssignments);
examSetRoutes.patch("/:id/assignments/:studentId", ...guard, set.overrideAssignment);

// The class at a glance, and the written answers still waiting for a teacher.
examSetRoutes.get("/:id/results", ...guard, set.listSetResults);

/**
 * Sitting a paper. Student-only rather than merely authenticated: a teacher asking
 * for a student's paper here would be reading a keyless payload for a set they own,
 * which is harmless but pointless, and the strict role makes the route's intent
 * obvious at a glance.
 */
examSetRoutes.get("/:id/attempts", ...studentOnly, attempt.listMyAttempts);
examSetRoutes.post("/:id/attempts", ...studentOnly, attempt.submitMyAttempt);
examSetRoutes.put("/:id/attempts/current", ...studentOnly, attempt.saveMyDraft);

/** Mounted at `/api/exam-attempts/:id`, which is where the result is polled. */
export const examAttemptRoutes = Router();
examAttemptRoutes.get("/:id", ...studentOnly, attempt.getMyAttempt);

/**
 * A teacher marking a written answer by hand. Same collection, opposite side of the
 * fence: reading an attempt is the student's route, changing a mark is the
 * teacher's, and the two guards are what keep them apart.
 */
examAttemptRoutes.put("/:id/grade", ...guard, attempt.overrideAttemptGrade);

/**
 * Mounted at `/api/exam-forms`. A form belongs to a set, but the review actions
 * address it on its own so the review screen does not have to carry the set id
 * around; ownership is still checked through the parent set.
 */
export const examFormRoutes = Router();
examFormRoutes.use(...guard);

examFormRoutes.post("/:formId/verify", set.verifyForm);
examFormRoutes.put("/:formId/questions/:qid", set.updateQuestion);
examFormRoutes.post("/:formId/questions/:qid/regenerate", set.regenerateQuestion);
examFormRoutes.delete("/:formId/questions/:qid", set.deleteQuestion);

// The review stamp. Publishing refuses a form without one, so this is the button
// that decides whether a paper is allowed out of the door.
examFormRoutes.post("/:formId/review", set.markFormReviewed);
