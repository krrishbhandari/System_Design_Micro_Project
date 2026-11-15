import mongoose from "mongoose";

const usageSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      index: true,
    },
    agent: {
      type: String,
      required: true,
    },
    // Truncated to the current minute window for analytics
    windowStart: {
      type: Date,
      required: true,
      index: true,
    },
    admittedCount: {
      type: Number,
      default: 0,
    },
    deniedCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

usageSchema.index({ key: 1, windowStart: 1 }, { unique: true });

const AggregateUsage = mongoose.model("AggregateUsage", usageSchema);

export default AggregateUsage;
