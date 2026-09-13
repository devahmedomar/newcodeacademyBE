import { Schema, model, Document } from "mongoose";

export interface IPayment extends Document {
  studentId: Schema.Types.ObjectId;
  month: string;
  amount: number;
  status: "paid" | "unpaid" | "late";
  paidOn?: Date;
  markedBy: Schema.Types.ObjectId;
}

const paymentSchema = new Schema<IPayment>(
  {
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["paid", "unpaid", "late"], default: "unpaid" },
    paidOn: { type: Date },
    markedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

paymentSchema.index({ studentId: 1, month: 1 }, { unique: true });

export const Payment = model<IPayment>("Payment", paymentSchema);