import { Response } from "express";
import { Exam } from "../models/Exam";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const q = req.user!.role === "teacher" ? {} : { studentId: req.user!._id };
    const exams = await Exam.find(q).sort({ date: -1 }).populate("studentId", "name email");
    res.json(exams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { studentId, subject, lessonRef, title, grade, maxGrade, date } = req.body;
    if (!studentId || !subject || !title || grade === undefined || maxGrade === undefined) {
      return res.status(400).json({ message: "Student, subject, title, grade and maxGrade required" });
    }
    const exam = await Exam.create({ studentId, subject, lessonRef, title, grade, maxGrade, date });
    res.status(201).json(exam);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const exam = await Exam.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    res.json(exam);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const exam = await Exam.findByIdAndDelete(req.params.id);
    if (!exam) return res.status(404).json({ message: "Exam not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}