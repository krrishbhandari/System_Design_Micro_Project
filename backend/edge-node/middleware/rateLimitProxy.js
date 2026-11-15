import { checkEdgeRateLimit } from "../limiter/tokenBucket.js";

/**
 * Middleware that enforces Edge-local rate limiting before proxying to Origin Gateway.
 */
export const edgeRateLimitMiddleware = (req, res, next) => {
  // Only enforce agent-level rate limiting on agent endpoints
  const isAgentRoute = req.originalUrl?.startsWith("/api/agent") || req.path?.startsWith("/api/agent");

  if (!isAgentRoute || req.method !== "POST") {
    return next();
  }

  // 1. Resolve agent identity
  // Supports JSON body or multipart form fields passed in headers or body
  let agent = (req.body?.agent || req.headers["x-agent"] || "chat").toLowerCase();
  if (agent === "auto") agent = "chat";

  // 2. Resolve client key (User ID, Session Cookie, or IP)
  const userId = req.headers["x-user-id"] || req.cookies?.session || req.ip || "anonymous";
  const plan = req.headers["x-user-plan"] || "free";
  const key = `${userId}:${agent}`;

  // 3. Local In-Memory Evaluation (< 1ms)
  const result = checkEdgeRateLimit(key, agent, plan);

  // Set standard RateLimit headers
  res.setHeader("X-RateLimit-Limit", result.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader("X-RateLimit-Reset", result.resetMs);
  res.setHeader("X-Edge-Node", process.env.NODE_ID || "edge-node-01");

  if (!result.allowed) {
    res.setHeader("Retry-After", result.retryAfterSeconds);
    return res.status(429).json({
      success: false,
      agent,
      limit: result.limit,
      remainingTime: result.retryAfterSeconds,
      retryAfter: `${result.retryAfterSeconds}s`,
      message: result.message,
      edgeIntercepted: true,
      edgeNode: process.env.NODE_ID || "edge-node-01",
      degraded: result.degraded || false,
    });
  }

  next();
};
