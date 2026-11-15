import mongoose from "mongoose";

const leaseSchema = new mongoose.Schema(
  {
    // Unique key identifying rate limit subject, e.g. "user_64f1...:coding" or "ip_127.0.0.1:chat"
    key: {
      type: String,
      required: true,
      index: true,
    },
    // The regional edge node holding this lease
    nodeId: {
      type: String,
      required: true,
      index: true,
    },
    region: {
      type: String,
      required: true,
    },
    // Number of tokens granted to this node in this lease period
    grantedUnits: {
      type: Number,
      required: true,
    },
    // Number of tokens consumed so far (reported back in sync)
    usedUnits: {
      type: Number,
      default: 0,
    },
    epoch: {
      type: Number,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 60 }, // MongoDB TTL auto-cleanup after 60 seconds
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to quickly find active leases by key and node
leaseSchema.index({ key: 1, nodeId: 1 });

const Lease = mongoose.model("NodeLease", leaseSchema);

export default Lease;
