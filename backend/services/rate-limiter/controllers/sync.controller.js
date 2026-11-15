import BatchClaim from "../models/batchClaim.model.js";
import AggregateUsage from "../models/usage.model.js";
import Rule from "../models/rule.model.js";
import Lease from "../models/lease.model.js";
import { allocateLease } from "../services/leaseAllocator.js";

/**
 * CONTROL PLANE: Background sync endpoint called every T ms by Regional Edge Nodes
 * POST /api/rate-limit/sync
 */
export const handleSync = async (req, res) => {
  try {
    const {
      nodeId,
      region = "default",
      epoch,
      seq,
      clientRuleVersion = 0,
      records = [],
      leaseRequests = [],
    } = req.body;

    if (!nodeId || epoch === undefined || seq === undefined) {
      return res.status(400).json({ message: "nodeId, epoch, and seq are required" });
    }

    // 1. Idempotency Check: Was this exact batch already processed?
    const existingClaim = await BatchClaim.findOne({ nodeId, epoch, seq });
    if (existingClaim) {
      // Duplicate batch delivery (e.g. edge retry on network latency / lost reply)
      // Return existing active leases without re-incrementing usage counts
      const activeLeases = await Lease.find({
        nodeId,
        expiresAt: { $gt: new Date() },
      }).lean();

      return res.status(200).json({
        status: "ACK",
        idempotentReplay: true,
        epoch,
        ackSeq: seq,
        leases: activeLeases.map((l) => ({
          key: l.key,
          grantedUnits: l.grantedUnits,
          leaseTtlMs: Math.max(0, new Date(l.expiresAt).getTime() - Date.now()),
        })),
        rulesUpdated: false,
      });
    }

    // Record the batch claim immediately
    await BatchClaim.create({ nodeId, epoch, seq });

    // 2. Process Usage Telemetry (Admitted & Denied Counts)
    const now = new Date();
    // Truncate to the start of the current minute
    const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());

    if (records.length > 0) {
      const bulkOps = records.map((rec) => {
        const parts = (rec.key || "").split(":");
        const userId = parts[0] || "unknown";
        const agent = parts[1] || "chat";

        return {
          updateOne: {
            filter: { key: rec.key, windowStart },
            update: {
              $inc: {
                admittedCount: rec.admitted || 0,
                deniedCount: rec.denied || 0,
              },
              $setOnInsert: {
                userId,
                agent,
                windowStart,
              },
            },
            upsert: true,
          },
        };
      });

      await AggregateUsage.bulkWrite(bulkOps, { ordered: false });
    }

    // 3. Process Lease Requests (Granting Token Bucket Quotas)
    const grantedLeases = [];
    for (const reqItem of leaseRequests) {
      const parts = (reqItem.key || "").split(":");
      const agent = reqItem.agent || parts[1] || "chat";
      const plan = reqItem.plan || "free";

      const grant = await allocateLease({
        key: reqItem.key,
        nodeId,
        region,
        requestedUnits: reqItem.requestedUnits,
        plan,
        agent,
        epoch,
      });

      grantedLeases.push(grant);
    }

    // 4. Stale Rule Check: Serve updated rules if edge is out-of-date
    const rules = await Rule.find().lean();
    const maxVersion = rules.reduce((max, r) => Math.max(max, r.version || 1), 1);
    const rulesUpdated = clientRuleVersion < maxVersion;

    return res.status(200).json({
      status: "ACK",
      epoch,
      ackSeq: seq,
      leases: grantedLeases,
      rules: rulesUpdated ? rules : undefined,
      rulesUpdated,
    });
  } catch (error) {
    console.error("Rate Limiter Sync Error:", error);
    return res.status(500).json({ message: `Sync error: ${error.message}` });
  }
};

/**
 * Bootstrap endpoint for Edge Nodes on first contact / cold start
 * GET /api/rate-limit/rules
 */
export const getRules = async (req, res) => {
  try {
    const rules = await Rule.find().lean();
    const maxVersion = rules.reduce((max, r) => Math.max(max, r.version || 1), 1);
    return res.status(200).json({
      version: maxVersion,
      rules,
    });
  } catch (error) {
    return res.status(500).json({ message: `Failed to fetch rules: ${error.message}` });
  }
};

/**
 * Health & Active Lease Status
 * GET /api/rate-limit/status
 */
export const getStatus = async (req, res) => {
  try {
    const activeLeasesCount = await Lease.countDocuments({
      expiresAt: { $gt: new Date() },
    });
    const rulesCount = await Rule.countDocuments();
    return res.status(200).json({
      status: "healthy",
      service: "Rate Limiter Coordinator",
      activeLeasesCount,
      rulesCount,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
