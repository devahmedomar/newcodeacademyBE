import { Request, Response } from "express";
import { User } from "../models/User";
import { ExamGrade } from "../models/ExamGrade";
import { ExamTemplate } from "../models/ExamTemplate";
import { Homework } from "../models/Homework";
import { QuizAttempt } from "../models/QuizAttempt";
import { connectDB } from "../config/db";

export async function top(req: Request, res: Response) {
  try {
    await connectDB();
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 50);

    const examTemplateColl = ExamTemplate.collection.name;
    const examAgg = await ExamGrade.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $lookup: { from: examTemplateColl, localField: "examId", foreignField: "_id", as: "tmpl" } },
      { $unwind: "$tmpl" },
      { $group: { _id: "$studentId", earned: { $sum: "$grade" }, possible: { $sum: "$tmpl.maxGrade" } } },
    ]);
    const homeworkAgg = await Homework.aggregate<{ _id: unknown; earned: number; possible: number }>([
      { $group: { _id: "$studentId", earned: { $sum: "$points" }, possible: { $sum: "$maxPoints" } } },
    ]);
    const quizAgg = await QuizAttempt.aggregate<{
      _id: unknown;
      earned: number;
      possible: number;
    }>([
      { $sort: { score: -1 } },
      {
        $group: {
          _id: { studentId: "$studentId", quizId: "$quizId" },
          score: { $first: "$score" },
          total: { $first: "$total" },
        },
      },
      { $group: { _id: "$_id.studentId", earned: { $sum: "$score" }, possible: { $sum: "$total" } } },
    ]);

    const acc = new Map<string, { earned: number; possible: number }>();
    const add = (rows: Array<{ _id: unknown; earned: number; possible: number }>) => {
      for (const r of rows) {
        const key = String(r._id);
        const cur = acc.get(key) ?? { earned: 0, possible: 0 };
        cur.earned += r.earned;
        cur.possible += r.possible;
        acc.set(key, cur);
      }
    };
    add(examAgg);
    add(homeworkAgg);
    add(quizAgg);

    const ids = [...acc.keys()];
    if (ids.length === 0) return res.json([]);

    const users = await User.find({ _id: { $in: ids }, role: "student", active: true })
      .select("name")
      .lean();

    const rows = users
      .map((u) => {
        const p = acc.get(String(u._id)) ?? { earned: 0, possible: 0 };
        return {
          _id: String(u._id),
          name: u.name,
          earned: p.earned,
          possible: p.possible,
          percent: p.possible > 0 ? Math.round((p.earned / p.possible) * 100) : 0,
        };
      })
      .sort((a, b) => b.earned - a.earned || b.percent - a.percent || a.name.localeCompare(b.name))
      .slice(0, limit);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}