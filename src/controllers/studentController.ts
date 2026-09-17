import { Response } from "express";
import bcrypt from "bcryptjs";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { ExamGrade } from "../models/ExamGrade";
import { Homework } from "../models/Homework";
import { Payment } from "../models/Payment";
import { Lesson } from "../models/Lesson";
import { Quiz } from "../models/Quiz";
import { QuizAttempt } from "../models/QuizAttempt";
import { User } from "../models/User";

export async function profile(req: AuthRequest, res: Response) {
  try {
    await connectDB();

    const rawId = req.params.id || String(req.user!._id);
    const requestedId = rawId === "me" ? String(req.user!._id) : rawId;
    if (req.user!.role === "student" && requestedId !== String(req.user!._id)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const user = await User.findById(requestedId).select("-passwordHash");
    if (!user) return res.status(404).json({ message: "Student not found" });

    const [examGrades, homeworks, payments, lessons, quizAttempts] = await Promise.all([
      ExamGrade.find({ studentId: requestedId }).populate("examId"),
      Homework.find({ studentId: requestedId }).sort({ createdAt: -1 }),
      Payment.find({ studentId: requestedId }).sort({ month: -1 }),
      Lesson.find({ published: true }).sort({ module: 1, order: 1 }),
      QuizAttempt.find({ studentId: requestedId })
        .populate({
          path: "quizId",
          select: "lessonId",
          populate: { path: "lessonId", select: "title module" },
        })
        .sort({ createdAt: -1 }),
    ]);

    const exams = (examGrades as unknown as Array<{ examId: any; grade: number }>)
      .filter((g) => g.examId)
      .map((g) => ({
        _id: String(g.examId._id),
        studentId: requestedId,
        subject: g.examId.subject,
        lessonRef: g.examId.lessonRef,
        title: g.examId.title,
        grade: g.grade,
        maxGrade: g.examId.maxGrade,
        date: g.examId.date,
      }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const currentMonth = new Date().toISOString().slice(0, 7);
    const currentPayment = payments.find((p) => p.month === currentMonth);

    const lessonIds = lessons.map((l) => l._id);
    const quizzes = await Quiz.find({ lessonId: { $in: lessonIds } }).select("lessonId").lean();
    const quizSet = new Set(quizzes.map((z) => String(z.lessonId)));
    const lessonsOut = lessons.map((l) => {
      const o = l.toObject();
      return { ...o, hasQuiz: quizSet.has(String(l._id)) };
    });

    const attempts = (quizAttempts as unknown as Array<{ quizId: any }>)
      .filter((a) => a.quizId && a.quizId.lessonId)
      .map((a: any) => {
        const lesson = a.quizId.lessonId;
        return {
          _id: String(a._id),
          quizId: String(a.quizId._id),
          lessonId: String(lesson._id),
          lessonTitle: lesson.title,
          module: lesson.module,
          score: a.score,
          total: a.total,
          percent: a.percent,
          createdAt: a.createdAt,
        };
      });

    const bestByQuiz = new Map<string, (typeof attempts)[number]>();
    for (const a of attempts) {
      const cur = bestByQuiz.get(a.quizId);
      if (!cur || a.score > cur.score) bestByQuiz.set(a.quizId, a);
    }
    const quizBestAttempts = [...bestByQuiz.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const quizEarned = quizBestAttempts.reduce((s, a) => s + a.score, 0);
    const quizPossible = quizBestAttempts.reduce((s, a) => s + a.total, 0);
    const hwEarned = homeworks.reduce((s, h) => s + h.points, 0);
    const hwPossible = homeworks.reduce((s, h) => s + h.maxPoints, 0);
    const examEarned = exams.reduce((s, e) => s + e.grade, 0);
    const examPossible = exams.reduce((s, e) => s + e.maxGrade, 0);
    const totalEarned = quizEarned + hwEarned + examEarned;
    const totalPossible = quizPossible + hwPossible + examPossible;
    const points = {
      total: {
        earned: totalEarned,
        possible: totalPossible,
        percent: totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0,
      },
      quizzes: { earned: quizEarned, possible: quizPossible },
      homeworks: { earned: hwEarned, possible: hwPossible },
      exams: { earned: examEarned, possible: examPossible },
    };

    res.json({
      user: {
        id: user.id,
        _id: user.id,
        name: user.name,
        email: user.email,
        enrollmentDate: user.enrollmentDate,
        avatar: user.avatar,
        notifications: user.notifications,
      },
      exams,
      homeworks,
      payments,
      lessons: lessonsOut,
      quizAttempts: attempts,
      quizBestAttempts,
      points,
      currentMonth,
      currentPayment: currentPayment ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function changePassword(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = await User.findById(id);
    if (!user || user.role !== "student") {
      return res.status(404).json({ message: "Student not found" });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    await user.save();
    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user || user.role !== "student") {
      return res.status(404).json({ message: "Student not found" });
    }
    if (!user.active) {
      return res.status(400).json({ message: "Student is already deactivated" });
    }

    user.active = false;
    await user.save();

    return res.json({ message: "Student deactivated — all their data is kept" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function restore(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user || user.role !== "student") {
      return res.status(404).json({ message: "Student not found" });
    }

    user.active = true;
    await user.save();

    return res.json({ message: "Student restored" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}