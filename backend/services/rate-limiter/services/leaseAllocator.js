import Rule from "../models/rule.model.js";
import Lease from "../models/lease.model.js";

// Default rules matching project requirements & tiers
const DEFAULT_RULES = [
  // Free tier
  { agent: "chat", plan: "free", capacity: 20, refillRatePerSec: 0.33, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },
  { agent: "search", plan: "free", capacity: 5, refillRatePerSec: 0.083, cost: 1, maxLeaseUnits: 2, leaseTtlMs: 5000, version: 1 },
  { agent: "coding", plan: "free", capacity: 5, refillRatePerSec: 0.083, cost: 1, maxLeaseUnits: 2, leaseTtlMs: 5000, version: 1 },
  { agent: "pdf", plan: "free", capacity: 5, refillRatePerSec: 0.083, cost: 1, maxLeaseUnits: 2, leaseTtlMs: 5000, version: 1 },
  { agent: "ppt", plan: "free", capacity: 5, refillRatePerSec: 0.083, cost: 1, maxLeaseUnits: 2, leaseTtlMs: 5000, version: 1 },
  { agent: "vision", plan: "free", capacity: 5, refillRatePerSec: 0.083, cost: 1, maxLeaseUnits: 2, leaseTtlMs: 5000, version: 1 },

  // Starter tier (increased capacities)
  { agent: "chat", plan: "starter", capacity: 40, refillRatePerSec: 0.66, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },
  { agent: "search", plan: "starter", capacity: 15, refillRatePerSec: 0.25, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },
  { agent: "coding", plan: "starter", capacity: 15, refillRatePerSec: 0.25, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },
  { agent: "pdf", plan: "starter", capacity: 15, refillRatePerSec: 0.25, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },
  { agent: "ppt", plan: "starter", capacity: 15, refillRatePerSec: 0.25, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },
  { agent: "vision", plan: "starter", capacity: 15, refillRatePerSec: 0.25, cost: 1, maxLeaseUnits: 5, leaseTtlMs: 5000, version: 1 },

  // Pro tier (maximum limits)
  { agent: "chat", plan: "pro", capacity: 100, refillRatePerSec: 1.66, cost: 1, maxLeaseUnits: 20, leaseTtlMs: 5000, version: 1 },
  { agent: "search", plan: "pro", capacity: 30, refillRatePerSec: 0.5, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },
  { agent: "coding", plan: "pro", capacity: 30, refillRatePerSec: 0.5, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },
  { agent: "pdf", plan: "pro", capacity: 30, refillRatePerSec: 0.5, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },
  { agent: "ppt", plan: "pro", capacity: 30, refillRatePerSec: 0.5, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },
  { agent: "vision", plan: "pro", capacity: 30, refillRatePerSec: 0.5, cost: 1, maxLeaseUnits: 10, leaseTtlMs: 5000, version: 1 },

  // Default fallback rule
  { agent: "default", plan: "all", capacity: 10, refillRatePerSec: 0.16, cost: 1, maxLeaseUnits: 3, leaseTtlMs: 5000, version: 1 },
];

export const seedDefaultRulesIfEmpty = async () => {
  const count = await Rule.countDocuments();
  if (count === 0) {
    console.log("Seeding initial rate limit rules...");
    await Rule.insertMany(DEFAULT_RULES);
    console.log("Default rules seeded successfully.");
  }
};

export const getRulesMap = async () => {
  const rules = await Rule.find().lean();
  const ruleMap = {};
  for (const r of rules) {
    const key = `${r.agent}:${r.plan}`;
    ruleMap[key] = r;
  }
  return ruleMap;
};

/**
 * Calculates and commits a lease grant for an edge node
 */
export const allocateLease = async ({ key, nodeId, region, requestedUnits, plan = "free", agent = "chat", epoch }) => {
  const now = new Date();

  // 1. Resolve rule for this agent and plan
  let rule = await Rule.findOne({ agent, plan }).lean();
  if (!rule) {
    rule = await Rule.findOne({ agent, plan: "free" }).lean() ||
           await Rule.findOne({ agent: "default" }).lean() ||
           { capacity: 10, maxLeaseUnits: 3, leaseTtlMs: 5000, refillRatePerSec: 0.16 };
  }

  // 2. Query all other active leases currently held across any node for this key
  const activeLeases = await Lease.find({
    key,
    expiresAt: { $gt: now },
  }).lean();

  // Total units currently committed across all nodes
  const totalLeasedUnits = activeLeases.reduce((acc, l) => {
    // If it's this node, we will overwrite its lease, so exclude its previous grant
    if (l.nodeId === nodeId) return acc;
    return acc + Math.max(0, l.grantedUnits - (l.usedUnits || 0));
  }, 0);

  // 3. Compute remaining global capacity available to allocate
  const availableGlobalUnits = Math.max(0, rule.capacity - totalLeasedUnits);

  // Clamp requested units between 1 and min(requestedUnits, rule.maxLeaseUnits, availableGlobalUnits)
  const desired = requestedUnits || rule.maxLeaseUnits;
  const grantedUnits = Math.min(desired, rule.maxLeaseUnits, availableGlobalUnits);

  const ttlMs = rule.leaseTtlMs || 5000;
  const expiresAt = new Date(now.getTime() + ttlMs);

  // 4. Upsert the active lease record for this (key, nodeId)
  await Lease.findOneAndUpdate(
    { key, nodeId },
    {
      key,
      nodeId,
      region,
      grantedUnits,
      usedUnits: 0,
      epoch,
      expiresAt,
    },
    { upsert: true, returnDocument: 'after' }
  );

  return {
    key,
    grantedUnits,
    leaseTtlMs: ttlMs,
    expiresAt: expiresAt.toISOString(),
    capacity: rule.capacity,
    refillRatePerSec: rule.refillRatePerSec,
    cost: rule.cost,
  };
};
