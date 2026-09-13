import mongoose from "mongoose";

let cached = global as unknown as { mongoose?: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } };

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.mongoose?.conn) return cached.mongoose.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined");

  const opts = { serverSelectionTimeoutMS: 5000 };

  if (!cached.mongoose) cached.mongoose = { conn: null, promise: null };

  if (!cached.mongoose.promise) {
    cached.mongoose.promise = mongoose.connect(uri, opts).then((m) => {
      console.log("MongoDB connected");
      return m;
    });
  }

  cached.mongoose.conn = await cached.mongoose.promise;
  return cached.mongoose.conn;
}