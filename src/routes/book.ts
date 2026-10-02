import { Router } from "express";
import multer from "multer";
import * as c from "../controllers/bookController";
import { authGuard, roleGuard } from "../middleware/auth";
import { UPLOAD_CHUNK_BYTES } from "../services/books/pdfExtract";

const router = Router();

/**
 * Chunks arrive as raw binary in a multipart field. Keep the limit tight: the
 * client slices at 3 MB and Vercel rejects bodies over 4.5 MB anyway.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_CHUNK_BYTES + 1024, files: 1 },
});

const teacherOnly = roleGuard("teacher");

router.use(authGuard, teacherOnly);

router.post("/chunk", upload.single("chunk"), c.uploadChunk);
router.post("/transcribe-session", (_req, res) =>
  res.json({ sessionId: c.newUploadSessionId() })
);
router.post("/", c.createBook);
router.post("/:id/transcribe", upload.single("file"), c.transcribeBook);

router.get("/", c.listBooks);
router.get("/:id", c.getBook);
router.get("/:id/pages", c.getBookPages);
router.delete("/:id", c.deleteBook);

export default router;
