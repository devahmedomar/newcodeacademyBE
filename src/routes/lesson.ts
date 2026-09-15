import { Router } from "express";
import * as c from "../controllers/lessonController";
import * as quiz from "../controllers/quizController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard);
router.get("/", c.list);
router.post("/", roleGuard("teacher"), c.create);
router.put("/:id", roleGuard("teacher"), c.update);
router.delete("/:id", roleGuard("teacher"), c.remove);
router.get("/:id/quiz", quiz.getByLesson);
router.put("/:id/quiz", roleGuard("teacher"), quiz.saveQuiz);
router.delete("/:id/quiz", roleGuard("teacher"), quiz.deleteQuiz);

export default router;