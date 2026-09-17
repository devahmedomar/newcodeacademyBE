import { Router } from "express";
import announcementRoutes from "./announcements";
import examRoutes from "./exam";
import homeworkRoutes from "./homework";
import leaderboardRoutes from "./leaderboard";
import lessonRoutes from "./lesson";
import meRoutes from "./me";
import paymentRoutes from "./payment";
import quizRoutes from "./quiz";
import studentRoutes from "./student";

const router = Router();

router.use("/announcements", announcementRoutes);
router.use("/exams", examRoutes);
router.use("/homework", homeworkRoutes);
router.use("/leaderboard", leaderboardRoutes);
router.use("/lessons", lessonRoutes);
router.use("/me", meRoutes);
router.use("/payments", paymentRoutes);
router.use("/quizzes", quizRoutes);
router.use("/students", studentRoutes);

router.get("/ping", (_req, res) => res.json({ message: "pong" }));

export default router;