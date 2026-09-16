import { Router } from "express";
import { login, register, me, changePassword } from "../controllers/authController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.post("/login", login);
router.post("/register", authGuard, roleGuard("teacher"), register);
router.get("/me", authGuard, me);
router.put("/password", authGuard, changePassword);

export default router;