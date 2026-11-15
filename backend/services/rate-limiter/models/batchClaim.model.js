import mongoose from "mongoose";

const batchClaimSchema = new mongoose.Schema(
  {
    nodeId: {
      type: String,
      required: true,
    },
    epoch: {
      type: Number,
      required: true,
    },
    seq: {
      type: Number,
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      index: { expires: 3600 }, // Keep claims for 1 hour for idempotency deduplication
    },
  },
  {
    timestamps: false,
  }
);

// Compound unique index ensuring idempotency per edge node stream
batchClaimSchema.index({ nodeId: 1, epoch: 1, seq: 1 }, { unique: true });

const BatchClaim = mongoose.model("BatchClaim", batchClaimSchema);

export default BatchClaim;
