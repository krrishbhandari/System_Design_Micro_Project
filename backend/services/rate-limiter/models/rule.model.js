import mongoose from "mongoose";

const ruleSchema = new mongoose.Schema(
  {
    agent: {
      type: String,
      required: true,
      enum: ["chat", "search", "coding", "pdf", "ppt", "vision", "default"],
    },
    plan: {
      type: String,
      required: true,
      enum: ["free", "starter", "pro", "all"],
      default: "all",
    },
    // Maximum burst capacity for this agent/plan
    capacity: {
      type: Number,
      required: true,
    },
    // Refill rate in tokens per second
    refillRatePerSec: {
      type: Number,
      required: true,
    },
    // Unit cost per invocation
    cost: {
      type: Number,
      default: 1,
    },
    // Maximum lease slice in tokens that an edge node can hold at once
    maxLeaseUnits: {
      type: Number,
      default: 5,
    },
    // Maximum lease validity in ms
    leaseTtlMs: {
      type: Number,
      default: 5000,
    },
    // Monotonically increasing version counter to detect stale edge caches
    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to quickly fetch rules by agent and plan
ruleSchema.index({ agent: 1, plan: 1 }, { unique: true });

const Rule = mongoose.model("RateLimitRule", ruleSchema);

export default Rule;
