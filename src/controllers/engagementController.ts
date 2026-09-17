import { Response } from "express";
import { Types } from "mongoose";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";
import { WatchActivity } from "../models/WatchActivity";
import { Lesson } from "../models/Lesson";
import { QuizAttempt } from "../models/QuizAttempt";
import { Homework } from "../models/Homework";
import { ExamGrade } from "../models/ExamGrade";
import { ExamTemplate } from "../models/ExamTemplate";
import { User } from "../models/User";
import { BADGES, levelFromPoints } from "../config/badges";

export const WEEKLY_GOAL = 5;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function localDateString(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prevDay(dateStr: string) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return localDateString(d);
}

function weekStartMonday(dateStr: string) {
  const d = new Date(`${dateStr}T12:00:00`);
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return localDateString(d);
}

async function buildActivity(studentId: string) {
  const grouped = await WatchActivity.aggregate<{ date: string; count: number }>([
    { $match: { studentId: new Types.ObjectId(studentId) } },
    { $group: { _id: "$date", count: { $sum: 1 } } },
    { $project: { date: "$_id", count: 1, _id: 0 } },
  ]);

  const daySet = new Set(grouped.map((g) => g.date));
  const yesterday = prevDay(localDateString(new Date()));

  let streak = 0;
  let cur = localDateString(new Date());
  while (daySet.has(cur)) {
    streak++;
    cur = prevDay(cur);
  }
  if (streak === 0 && daySet.has(yesterday)) {
    streak = 1;
    cur = prevDay(yesterday);
    while (daySet.has(cur)) {
      streak++;
      cur = prevDay(cur);
    }
  }

  const sorted = grouped.map((g) => g.date).sort();
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const dateStr of sorted) {
    if (prev && prevDay(dateStr) === prev) run++;
    else run = 1;
    if (run > longestStreak) longestStreak = run;
    prev = dateStr;
  }

  const today = localDateString(new Date());
  const weekStart = weekStartMonday(today);
  const weekly = await WatchActivity.aggregate<{ _id: unknown }>([
    {
      $match: { studentId: new Types.ObjectId(studentId), date: { $gte: weekStart } },
    },
    { $group: { _id: "$lessonId" } },
  ]);

  const watched = await WatchActivity.aggregate<{ _id: unknown }>([
    { $match: { studentId: new Types.ObjectId(studentId) } },
    { $group: { _id: "$lessonId" } },
  ]);

  const window = new Date(localDateString(new Date()));
  window.setDate(window.getDate() - 365);
  const floor = localDateString(window);

  return {
    streak,
    longestStreak,
    weekProgress: weekly.length,
    weeklyGoal: WEEKLY_GOAL,
    todayWatched: daySet.has(today),
    watchedLessons: watched.map((w) => String(w._id)),
    days: grouped
      .filter((g) => g.date >= floor)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((g) => ({ date: g.date, count: g.count })),
  };
}

export async function getActivity(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const activity = await buildActivity(String(req.user!._id));
    res.json(activity);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function markWatched(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { lessonId } = req.body;
    if (!lessonId || typeof lessonId !== "string") {
      return res.status(400).json({ message: "lessonId is required" });
    }
    const lesson = await Lesson.findById(lessonId);
    if (!lesson || !lesson.published) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    const date = localDateString(new Date());
    await WatchActivity.findOneAndUpdate(
      { studentId: req.user!._id, lessonId, date },
      { $setOnInsert: { watchedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const activity = await buildActivity(String(req.user!._id));
    res.json(activity);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function getBadges(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const studentId = String(req.user!._id);

    const [activity, quizAttempts, homeworks, examGrades] = await Promise.all([
      buildActivity(studentId),
      QuizAttempt.find({ studentId }).select("quizId score total percent").lean(),
      Homework.find({ studentId }).select("points maxPoints").lean(),
      ExamGrade.find({ studentId }).populate("examId").lean(),
    ]);

    const bestByQuiz = new Map<string, { score: number; total: number }>();
    let attemptCount = 0;
    let perfectQuiz = false;
    for (const a of quizAttempts) {
      attemptCount++;
      if (a.percent === 100) perfectQuiz = true;
      const id = String(a.quizId);
      const cur = bestByQuiz.get(id);
      if (!cur || a.score > cur.score) bestByQuiz.set(id, { score: a.score, total: a.total });
    }
    const quizEarned = [...bestByQuiz.values()].reduce((s, b) => s + b.score, 0);
    const hwEarned = homeworks.reduce((s, h) => s + h.points, 0);
    const examEarned = (examGrades as unknown as Array<{ grade: number; examId: any }>).reduce(
      (s, e) => s + (e.examId ? e.grade : 0),
      0
    );
    const pointsTotal = quizEarned + hwEarned + examEarned;
    const highExam = (examGrades as unknown as Array<{ grade: number; examId: any }>).some(
      (e) => e.examId && e.grade / e.examId.maxGrade >= 0.9
    );

    const criteria: Record<string, boolean> = {
      first_video: activity.watchedLessons.length >= 1,
      video_5: activity.watchedLessons.length >= 5,
      video_10: activity.watchedLessons.length >= 10,
      streak_3: activity.longestStreak >= 3,
      streak_7: activity.longestStreak >= 7,
      points_100: pointsTotal >= 100,
      points_250: pointsTotal >= 250,
      quiz_perfect: perfectQuiz,
      quiz_runner: attemptCount >= 5,
      exam_90: highExam,
      homework_50: hwEarned >= 50,
    };

    const earned = BADGES.filter((b) => criteria[b.id]).map((b) => ({ ...b, earned: true }));
    const locked = BADGES.filter((b) => !criteria[b.id]).map((b) => ({ ...b, earned: false }));

    res.json({ level: levelFromPoints(pointsTotal), earned, locked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function updateSettings(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const { avatar, notifications } = req.body;
    const user = req.user!;
    if (typeof avatar === "string" && avatar.trim()) {
      user.avatar = avatar.trim().slice(0, 8);
    }
    if (typeof notifications === "boolean") {
      user.notifications = notifications;
    }
    await user.save();
    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      notifications: user.notifications,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}