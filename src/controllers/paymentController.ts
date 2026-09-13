import { Response } from "express";
import { Payment } from "../models/Payment";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function list(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const q = req.user!.role === "teacher" ? {} : { studentId: req.user!._id };
    const payments = await Payment.find(q).sort({ month: -1 }).populate("studentId", "name email");
    res.json(payments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { studentId, month, amount, status, paidOn } = req.body;
    if (!studentId || !month || amount === undefined) {
      return res.status(400).json({ message: "Student, month and amount required" });
    }
    const payment = await Payment.create({
      studentId,
      month,
      amount,
      status,
      paidOn,
      markedBy: req.user!._id,
    });
    res.status(201).json(payment);
  } catch (err: any) {
    if (err?.code === 11000) return res.status(409).json({ message: "Payment record already exists for this month" });
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const body = { ...req.body, markedBy: req.user!._id };
    if (body.status === "paid" && !body.paidOn) body.paidOn = new Date();
    const payment = await Payment.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true });
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.json(payment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const payment = await Payment.findByIdAndDelete(req.params.id);
    if (!payment) return res.status(404).json({ message: "Payment not found" });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}