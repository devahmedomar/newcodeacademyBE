import { Router } from "express";
import * as c from "../controllers/quizController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard);
router.post("/:quizId/attempts", roleGuard("student"), c.submitAttempt);

export default router;