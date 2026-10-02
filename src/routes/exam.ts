import { Router } from "express";
import * as c from "../controllers/examController";
import { authGuard, roleGuard } from "../middleware/auth";

/**
 * The manual `ExamTemplate` / `ExamGrade` gradebook.
 *
 * Both reads are teacher-only, not merely authenticated. `GET /:id/grades` returns
 * every student's mark for an exam, so leaving it authenticated would let any
 * logged-in student read the whole class's results — the one number in this app
 * that is nobody else's business. The AI exam pipeline's own results route is
 * guarded the same way for the same reason.
 */
const router = Router();

router.use(authGuard);
router.get("/", roleGuard("teacher"), c.list);
router.post("/", roleGuard("teacher"), c.create);
router.put("/:id", roleGuard("teacher"), c.update);
router.delete("/:id", roleGuard("teacher"), c.remove);
router.get("/:id/grades", roleGuard("teacher"), c.listGrades);
router.put("/:id/grades", roleGuard("teacher"), c.upsertGrade);

export default router;