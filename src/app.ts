import express from "express";
import cors from "cors";
import { connectDB } from "./config/db";
import { seedTeacher } from "./config/seed";
import authRoutes from "./routes/auth";
import apiRoutes from "./routes/index";
import { AuthRequest, authGuard, roleGuard } from "./middleware/auth";
import { User } from "./models/User";

const app = express();

const corsOrigins =
  process.env.CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? [];
const DEV_ORIGINS = ["http://localhost:4200", "http://localhost:4201"];

app.use(
  cors({
    origin(origin, cb) {
      // Allow non-browser requests (curl, server-to-server) and everything when no list is configured.
      if (!origin || corsOrigins.length === 0) return cb(null, true);
      if (corsOrigins.includes(origin) || DEV_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await connectDB();
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db-error" });
  }
});

app.use("/auth", authRoutes);
app.use("/api", apiRoutes);

app.get("/students", authGuard, roleGuard("teacher"), async (req: AuthRequest, res) => {
  try {
    await connectDB();
    const students = await User.find({ role: "student" })
      .sort({ name: 1 })
      .select("-passwordHash");
    res.json(students);
  } catch (err) {
    console.error("list students error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default app;