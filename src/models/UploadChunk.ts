import { Schema, model, Document } from "mongoose";

/**
 * One slice of an in-flight PDF upload. Vercel caps a single request body at
 * 4.5 MB on every plan, so the client posts the file in ~3 MB pieces and the
 * server stitches them back together once the last one lands.
 *
 * The `expiresAt` TTL index means an interrupted upload cleans itself up
 * instead of leaking chunks into the 512 MB M0 cluster.
 */
export interface IUploadChunk extends Document {
  sessionId: string;
  index: number;
  total: number;
  data: Buffer;
  expiresAt: Date;
}

const uploadChunkSchema = new Schema<IUploadChunk>(
  {
    sessionId: { type: String, required: true, index: true },
    index: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true, min: 1 },
    data: { type: Buffer, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Re-uploading the same slice overwrites rather than duplicating.
uploadChunkSchema.index({ sessionId: 1, index: 1 }, { unique: true });
// Mongo's TTL monitor purges the chunks.
uploadChunkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UploadChunk = model<IUploadChunk>("UploadChunk", uploadChunkSchema);

/**
 * Normalise a stored chunk payload into a real `Buffer`.
 *
 * Mongoose 8's `.lean()` returns a BSON `Binary` for `Buffer` fields rather than a
 * `Buffer`, so `Buffer.concat` on lean results throws. Hydrated documents are
 * fine; this covers the lean/serialised paths.
 */
export function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;

  if (value instanceof Uint8Array) return Buffer.from(value);

  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));

  // BSON Binary: `value(true)` hands back the raw bytes.
  if (value && typeof (value as { value?: unknown }).value === "function") {
    const raw = (value as { value: (asRaw?: boolean) => Buffer }).value(true);
    if (Buffer.isBuffer(raw)) return raw;
  }

  // Last resort: something with a `buffer` field.
  if (value && typeof value === "object" && "buffer" in value) {
    return toBuffer((value as { buffer: unknown }).buffer);
  }

  throw new Error("Uploaded chunk data is not a binary payload");
}

/** Ordered `(index, buffer)` pairs ready for `assembleChunks`. */
export function chunkBuffers(
  chunks: Array<{ index: number; data: unknown }>
): Array<{ index: number; data: Buffer }> {
  return chunks
    .map((c) => ({ index: c.index, data: toBuffer(c.data) }))
    .sort((a, b) => a.index - b.index);
}
