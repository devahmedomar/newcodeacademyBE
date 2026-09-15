import { Response } from "express";
import { Quiz } from "../models/Quiz";
import { QuizAttempt } from "../models/QuizAttempt";
import { Lesson } from "../models/Lesson";
import { AuthRequest } from "../middleware/auth";
import { connectDB } from "../config/db";

export async function getByLesson(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const quiz = await Quiz.findOne({ lessonId: req.params.id });
    if (!quiz) return res.status(404).json({ message: "This lesson has no quiz yet" });

    const isTeacher = req.user!.role === "teacher";
    res.json({
      _id: quiz.id,
      lessonId: String(quiz.lessonId),
      questions: quiz.questions.map((q) =>
        isTeacher
          ? { question: q.question, options: q.options, correctIndex: q.correctIndex }
          : { question: q.question, options: q.options }
      ),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function saveQuiz(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const lesson = await Lesson.findById(req.params.id);
    if (!lesson) return res.status(404).json({ message: "Lesson not found" });

    const { questions } = req.body;
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ message: "Add at least one question" });
    }

    const cleaned: Array<{ question: string; options: string[]; correctIndex: number }> = [];
    for (const [i, q] of questions.entries()) {
      const question = typeof q?.question === "string" ? q.question.trim() : "";
      const options = Array.isArray(q?.options)
        ? (q.options as unknown[]).map((o) => String(o).trim())
        : [];
      const correctIndex = Number(q?.correctIndex);

      if (!question) return res.status(400).json({ message: `Question ${i + 1} needs a title` });
      if (options.length < 2 || options.length > 6 || options.some((o) => !o)) {
        return res.status(400).json({ message: `Question ${i + 1} needs 2 to 6 non-empty options` });
      }
      if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
        return res.status(400).json({ message: `Question ${i + 1} has an invalid correct answer` });
      }
      cleaned.push({ question, options, correctIndex });
    }

    const quiz = await Quiz.findOneAndUpdate(
      { lessonId: lesson.id },
      { questions: cleaned },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    res.json(quiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function deleteQuiz(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const quiz = await Quiz.findOneAndDelete({ lessonId: req.params.id });
    if (!quiz) return res.status(404).json({ message: "This lesson has no quiz" });
    await QuizAttempt.deleteMany({ quizId: quiz.id });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}

export async function submitAttempt(req: AuthRequest, res: Response) {
  try {
    await connectDB();
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    const lesson = await Lesson.findById(quiz.lessonId);
    if (!lesson || !lesson.published) {
      return res.status(403).json({ message: "Quiz not available yet" });
    }

    const { answers } = req.body;
    if (!Array.isArray(answers) || answers.length !== quiz.questions.length) {
      return res.status(400).json({ message: "Answer every question" });
    }

    const chosen = answers.map((a) => Number(a));
    for (let i = 0; i < quiz.questions.length; i++) {
      const n = chosen[i];
      const optionCount = quiz.questions[i].options.length;
      if (!Number.isInteger(n) || n < 0 || n >= optionCount) {
        return res.status(400).json({ message: `Invalid answer for question ${i + 1}` });
      }
    }

    let score = 0;
    const results = quiz.questions.map((q, i) => {
      const isCorrect = q.correctIndex === chosen[i];
      if (isCorrect) score++;
      return { question: q.question, options: q.options, chosen: chosen[i], correctIndex: q.correctIndex };
    });
    const total = quiz.questions.length;
    const percent = Math.round((score / total) * 100);

    const attempt = await QuizAttempt.create({
      quizId: quiz.id,
      studentId: req.user!._id,
      score,
      total,
      percent,
      answers: results.map((r) => ({ question: r.question, chosen: r.chosen, correct: r.correctIndex })),
    });

    res.status(201).json({ _id: attempt.id, quizId: quiz.id, score, total, percent, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
}