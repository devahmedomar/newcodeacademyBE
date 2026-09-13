import "reflect-metadata";

process.env.NODE_ENV = process.env.NODE_ENV || "production";

// Load env vars locally; on Vercel they come from the dashboard.
import dotenv from "dotenv";
dotenv.config();

import app from "../src/app";

export default app;