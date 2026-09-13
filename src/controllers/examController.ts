import { Response } from "express";
import { ExamTemplate } from "../models/ExamTemplate";
import { ExamGrade } from "../models/ExamGrade";
import { User } from "../models/User";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const [templates, agg] = await Promise.all([
      ExamTemplate.find().sort({ date: -1 }),
      ExamGrade.aggregate([
        { $group: { _id: "$examId", count: { $sum: 1 }, avg: { $avg: "$grade" } } },
      ]),
    ]);

    const stats = new Map(agg.map((a) => [String(a._id), a]));
    const exams = templates.map((t) => {
      const stat = stats.get(String(t._id));
      const averagePercent =
        stat && stat.count && t.maxGrade ? Math.round((stat.avg / t.maxGrade) * 100) : null;
      return {
        _id: t.id,
        title: t.title,
        subject: t.subject,
        maxGrade: t.maxGrade,
        date: t.date,
        lessonRef: t.lessonRef,
        gradedCount: stat?.count ?? 0,
        averagePercent,
      };
    });

    res.json(exams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { title, subject, maxGrade, date } = req.body;
    if (!title || !subject || maxGrade === undefined) {
      return res.status(400).json({ message: "Title, subject and maxGrade required" });
    }
    const template = await ExamTemplate.create({
      title,
      subject,
      maxGrade: Number(maxGrade),
      date: date || undefined,
    });
    res.status(201).json(template);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { title, subject, maxGrade, date } = req.body;
    const template = await ExamTemplate.findByIdAndUpdate(
      req.params.id,
      {
        ...(title !== undefined ? { title } : {}),
        ...(subject !== undefined ? { subject } : {}),
        ...(maxGrade !== undefined ? { maxGrade: Number(maxGrade) } : {}),
        ...(date !== undefined ? { date } : {}),
      },
      { new: true, runValidators: true }
    );
    if (!template) return res.status(404).json({ message: "Exam not found" });
    res.json(template);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const template = await ExamTemplate.findByIdAndDelete(req.params.id);
    if (!template) return res.status(404).json({ message: "Exam not found" });
    await ExamGrade.deleteMany({ examId: template.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function listGrades(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const exam = await ExamTemplate.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    const grades = await ExamGrade.find({ examId: exam.id }).populate("studentId", "name email");
    res.json({
      exam: { _id: exam.id, title: exam.title, subject: exam.subject, maxGrade: exam.maxGrade, date: exam.date },
      grades: grades.map((g) => ({ _id: g.id, grade: g.grade, student: g.studentId })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function upsertGrade(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const exam = await ExamTemplate.findById(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });

    const { studentId, grade } = req.body;
    if (!studentId || grade === undefined) {
      return res.status(400).json({ message: "studentId and grade required" });
    }
    const num = Number(grade);
    if (!Number.isFinite(num) || num < 0) {
      return res.status(400).json({ message: "Grade must be a positive number" });
    }
    if (num > exam.maxGrade) {
      return res.status(400).json({ message: `Grade cannot exceed max grade (${exam.maxGrade})` });
    }

    const student = await User.findById(studentId);
    if (!student || student.role !== "student") {
      return res.status(400).json({ message: "Student not found" });
    }

    const saved = await ExamGrade.findOneAndUpdate(
      { examId: exam.id, studentId },
      { grade: num },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}