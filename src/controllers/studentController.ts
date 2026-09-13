import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { ExamGrade } from "../models/ExamGrade";
import { Homework } from "../models/Homework";
import { Payment } from "../models/Payment";
import { Lesson } from "../models/Lesson";
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

    const [examGrades, homeworks, payments, lessons] = await Promise.all([
      ExamGrade.find({ studentId: requestedId }).populate("examId"),
      Homework.find({ studentId: requestedId }).sort({ createdAt: -1 }),
      Payment.find({ studentId: requestedId }).sort({ month: -1 }),
      Lesson.find({ published: true }).sort({ module: 1, order: 1 }),
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

    res.json({
      user: {
        id: user.id,
        _id: user.id,
        name: user.name,
        email: user.email,
        enrollmentDate: user.enrollmentDate,
      },
      exams,
      homeworks,
      payments,
      lessons,
      currentMonth,
      currentPayment: currentPayment ?? null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}