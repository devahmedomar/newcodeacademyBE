import { Router } from "express";
import * as c from "../controllers/examController";
import { authGuard, roleGuard } from "../middleware/auth";

const router = Router();

router.use(authGuard);
router.get("/", c.list);
router.post("/", roleGuard("teacher"), c.create);
router.put("/:id", roleGuard("teacher"), c.update);
router.delete("/:id", roleGuard("teacher"), c.remove);

export default router;