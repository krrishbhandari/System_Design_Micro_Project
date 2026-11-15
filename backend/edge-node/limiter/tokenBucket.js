import { localKV } from "../kv/localStore.js";

/**
 * Token Bucket Algorithm with Leased Quota enforcement.
 * Operates purely in-memory at sub-millisecond execution speeds.
 */
export const checkEdgeRateLimit = (key, agent = "chat", plan = "free", requestedCost = 1) => {
  const rule = localKV.getRule(agent, plan);
  const cost = requestedCost || rule.cost || 1;
  const now = Date.now();
  const capacity = rule.capacity || 10;
  const refillRate = rule.refillRatePerSec || 0.2;

  const lease = localKV.getLease(key);
  let bucketState = localKV.getBucketState(key);

  // 1. Initialize bucket state ONCE upon first contact for this key
  if (!bucketState) {
    const initialTokens = lease ? Math.min(lease.grantedUnits, capacity) : (rule.maxLeaseUnits || 2);
    bucketState = {
      tokens: initialTokens,
      lastRefillTime: now,
    };
    localKV.setBucketState(key, bucketState);

    // Enqueue an initial lease request in the next background sync batch
    localKV.recordAdmission(key, 0, agent, plan);
  }

  // 2. Refill tokens smoothly based on elapsed time
  const elapsedSec = (now - bucketState.lastRefillTime) / 1000;
  bucketState.tokens = Math.min(capacity, bucketState.tokens + elapsedSec * refillRate);
  bucketState.lastRefillTime = now;

  // 3. Check Fault-Tolerant Degraded Mode
  if (!localKV.isCoordinatorReachable && (!lease || lease.remainingUnits <= 0)) {
    if (agent === "chat" && bucketState.tokens >= cost) {
      bucketState.tokens -= cost;
      localKV.setBucketState(key, bucketState);
      localKV.recordAdmission(key, 1, agent, plan);
      return {
        allowed: true,
        remaining: Math.max(0, Math.floor(bucketState.tokens)),
        limit: capacity,
        resetMs: 5000,
        degraded: true,
      };
    } else {
      localKV.recordDenial(key, 1, agent, plan);
      return {
        allowed: false,
        remaining: 0,
        limit: capacity,
        retryAfterSeconds: 10,
        resetMs: 10000,
        message: `Network partition: ${agent} throttled in edge safety mode.`,
        degraded: true,
      };
    }
  }

  // 4. Token Check & Consumption
  if (bucketState.tokens >= cost) {
    bucketState.tokens -= cost;
    localKV.setBucketState(key, bucketState);

    if (lease) {
      lease.remainingUnits = Math.max(0, lease.remainingUnits - cost);
    }

    localKV.recordAdmission(key, 1, agent, plan);

    const remaining = Math.max(0, Math.floor(bucketState.tokens));
    const resetMs = Math.ceil(((capacity - bucketState.tokens) / refillRate) * 1000);

    return {
      allowed: true,
      remaining,
      limit: capacity,
      resetMs,
    };
  }

  // 5. Rate limit exceeded -> Block locally at Edge
  localKV.recordDenial(key, 1, agent, plan);

  const tokensNeeded = cost - bucketState.tokens;
  const retryAfterSeconds = Math.max(1, Math.ceil(tokensNeeded / refillRate));
  const resetMs = retryAfterSeconds * 1000;

  return {
    allowed: false,
    remaining: 0,
    limit: capacity,
    resetMs,
    retryAfterSeconds,
    message: `Rate limit exceeded for ${agent}. Limit is ${capacity} requests/min. Try again in ${retryAfterSeconds}s.`,
  };
};
