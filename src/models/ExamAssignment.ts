import { Schema, model, Document } from "mongoose";

/**
 * Which paper one student is sitting for one exam set.
 *
 * This is the anti-copying mechanism, and it is deliberately a separate document
 * rather than a field on `ExamSet`: the same student gets a different form for
 * every set, and a teacher can override one row without touching anyone else's.
 *
 * The unique index on `{examSetId, studentId}` is what makes re-publishing safe —
 * the same publish request can be sent twice and the second one updates rows
 * instead of duplicating them.
 */

export type AssignmentSource = "auto" | "teacher";

export interface IExamAssignment extends Document {
  examSetId: Schema.Types.ObjectId;
  studentId: Schema.Types.ObjectId;
  formId: Schema.Types.ObjectId;
  /** Denormalised from the form so the roster and student list need no join. */
  formLabel: string;
  /** Whether the balancer or the teacher chose this form. */
  source: AssignmentSource;
  assignedAt: Date;
}

const examAssignmentSchema = new Schema<IExamAssignment>(
  {
    examSetId: { type: Schema.Types.ObjectId, ref: "ExamSet", required: true, index: true },
    studentId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    formId: { type: Schema.Types.ObjectId, ref: "ExamForm", required: true },
    formLabel: { type: String, required: true, uppercase: true },
    source: { type: String, enum: ["auto", "teacher"], default: "auto" },
    assignedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// One paper per student per set. The index is also the upsert key for publishing.
examAssignmentSchema.index({ examSetId: 1, studentId: 1 }, { unique: true });

// "Which students still need a paper for this set?" is the query publishing runs.
examAssignmentSchema.index({ examSetId: 1, formLabel: 1 });

export const ExamAssignment = model<IExamAssignment>("ExamAssignment", examAssignmentSchema);
