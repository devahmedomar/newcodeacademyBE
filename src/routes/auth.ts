import { Router } from "express";
import { login, register, me } from "../controllers/authController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.post("/login", login);
router.post("/register", authGuard, roleGuard("teacher"), register);
router.get("/me", authGuard, me);

export default router;