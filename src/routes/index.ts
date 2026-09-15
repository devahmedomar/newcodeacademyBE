import { Router } from "express";
import examRoutes from "./exam";
import homeworkRoutes from "./homework";
import lessonRoutes from "./lesson";
import paymentRoutes from "./payment";
import quizRoutes from "./quiz";
import studentRoutes from "./student";

const router = Router();

router.use("/exams", examRoutes);
router.use("/homework", homeworkRoutes);
router.use("/lessons", lessonRoutes);
router.use("/payments", paymentRoutes);
router.use("/quizzes", quizRoutes);
router.use("/students", studentRoutes);

router.get("/ping", (_req, res) => res.json({ message: "pong" }));

export default router;