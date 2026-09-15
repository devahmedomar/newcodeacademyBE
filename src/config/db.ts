import mongoose from "mongoose";

let cached = global as unknown as { mongoose?: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } };

export async function connectDB(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not defined");

  if (!cached.mongoose) cached.mongoose = { conn: null, promise: null };

  if (!cached.mongoose.promise || mongoose.connection.readyState === 0) {
    cached.mongoose.promise = mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }).then((m) => {
      console.log("MongoDB connected");
      return m;
    });
  }

  cached.mongoose.conn = await cached.mongoose.promise;
  return mongoose;
}