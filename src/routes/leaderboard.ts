import { Router } from "express";
import { top } from "../controllers/leaderboardController";

const router = Router();

router.get("/", top);

export default router;