/**
 * High-performance In-Memory Local KV Store for Regional Edge Node
 * Holds local leases, bucket states, pending counts, and cached rules.
 */
class LocalKVStore {
  constructor() {
    this.leases = new Map();
    this.bucketStates = new Map();
    this.rules = new Map();
    this.pendingCounts = new Map();
    this.ruleVersion = 0;
    this.lastSyncEpoch = Math.floor(Date.now() / 1000);
    this.seq = 0;
    this.isCoordinatorReachable = true;
  }

  // --- Rules ---
  setRules(ruleList, version = 1) {
    this.rules.clear();
    for (const r of ruleList) {
      const key = `${r.agent}:${r.plan}`;
      this.rules.set(key, r);
    }
    this.ruleVersion = version;
  }

  getRule(agent, plan = "free") {
    return (
      this.rules.get(`${agent}:${plan}`) ||
      this.rules.get(`${agent}:free`) ||
      this.rules.get(`${agent}:all`) ||
      this.rules.get(`default:all`) || {
        capacity: 10,
        refillRatePerSec: 0.16,
        cost: 1,
        maxLeaseUnits: 3,
        leaseTtlMs: 5000,
      }
    );
  }

  // --- Leases & Token Buckets ---
  getLease(key) {
    const lease = this.leases.get(key);
    if (!lease) return null;

    // Check if lease expired
    if (Date.now() > lease.expiresAt) {
      return null;
    }
    return lease;
  }

  setLease(key, leaseData) {
    const now = Date.now();
    const expiresAt = now + (leaseData.leaseTtlMs || 5000);
    const existing = this.leases.get(key);

    this.leases.set(key, {
      ...leaseData,
      remainingUnits: leaseData.grantedUnits,
      expiresAt,
      updatedAt: now,
    });

    // Initialize bucket state if not present
    if (!this.bucketStates.has(key)) {
      this.bucketStates.set(key, {
        tokens: Math.min(leaseData.grantedUnits, leaseData.capacity || 10),
        lastRefillTime: now,
      });
    } else {
      // Top up available tokens with the new lease, bounded by capacity
      const state = this.bucketStates.get(key);
      state.tokens = Math.min(
        leaseData.capacity || 10,
        state.tokens + leaseData.grantedUnits
      );
      state.lastRefillTime = now;
    }
  }

  getBucketState(key) {
    return this.bucketStates.get(key);
  }

  setBucketState(key, state) {
    this.bucketStates.set(key, state);
  }

  // --- Metrics & Pending Batch ---
  recordAdmission(key, count = 1, agent = "chat", plan = "free") {
    if (!this.pendingCounts.has(key)) {
      this.pendingCounts.set(key, { admitted: 0, denied: 0, agent, plan });
    }
    const current = this.pendingCounts.get(key);
    current.admitted += count;
  }

  recordDenial(key, count = 1, agent = "chat", plan = "free") {
    if (!this.pendingCounts.has(key)) {
      this.pendingCounts.set(key, { admitted: 0, denied: 0, agent, plan });
    }
    const current = this.pendingCounts.get(key);
    current.denied += count;
  }

  // Atomically extracts pending metrics and lease requests for sync flush
  drainPendingBatch() {
    this.seq += 1;
    const records = [];
    const leaseRequests = [];

    for (const [key, val] of this.pendingCounts.entries()) {
      if (val.admitted > 0 || val.denied > 0) {
        records.push({
          key,
          admitted: val.admitted,
          denied: val.denied,
        });
      }

      // Request new lease slice if lease is low or missing
      const lease = this.getLease(key);
      if (!lease || lease.remainingUnits <= 2) {
        const rule = this.getRule(val.agent, val.plan);
        leaseRequests.push({
          key,
          agent: val.agent,
          plan: val.plan,
          requestedUnits: rule.maxLeaseUnits || 5,
        });
      }
    }

    // Clear drained counts
    this.pendingCounts.clear();

    return {
      epoch: this.lastSyncEpoch,
      seq: this.seq,
      records,
      leaseRequests,
    };
  }
}

export const localKV = new LocalKVStore();
