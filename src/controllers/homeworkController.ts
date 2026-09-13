import { Response } from "express";
import { Homework } from "../models/Homework";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const q = req.user!.role === "teacher" ? {} : { studentId: req.user!._id };
    const items = await Homework.find(q).sort({ createdAt: -1 }).populate("studentId", "name email");
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { studentId, title, points, maxPoints, submittedAt, feedback } = req.body;
    if (!studentId || !title || points === undefined || maxPoints === undefined) {
      return res.status(400).json({ message: "Student, title, points and maxPoints required" });
    }
    const item = await Homework.create({ studentId, title, points, maxPoints, submittedAt, feedback });
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const item = await Homework.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ message: "Homework not found" });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const item = await Homework.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: "Homework not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}