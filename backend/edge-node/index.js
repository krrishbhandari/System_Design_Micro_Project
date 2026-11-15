import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import proxy from "express-http-proxy";
import { edgeRateLimitMiddleware } from "./middleware/rateLimitProxy.js";
import { SyncClient } from "./client/syncClient.js";
import { localKV } from "./kv/localStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const port = process.env.PORT || 7999;
const gatewayUrl = process.env.ORIGIN_GATEWAY_URL || "http://localhost:8000";
const coordinatorUrl = process.env.COORDINATOR_URL || "http://localhost:8005";
const nodeId = process.env.NODE_ID || "edge-mumbai-01";
const region = process.env.REGION || "ap-south-1";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Edge Health & Status Check
app.get("/edge-health", (req, res) => {
  res.json({
    nodeId,
    region,
    status: "online",
    coordinatorReachable: localKV.isCoordinatorReachable,
    activeLeasesInKV: localKV.leases.size,
    bucketStatesInKV: localKV.bucketStates.size,
    ruleVersion: localKV.ruleVersion,
  });
});

// Edge Rate Limiting Filter
app.use(edgeRateLimitMiddleware);

// Proxy allowed traffic to Origin Gateway
app.use(
  "/",
  proxy(gatewayUrl, {
    limit: "25mb",
    proxyReqOptDecorator: (proxyReqOpts, srcReq) => {
      proxyReqOpts.headers["x-forwarded-edge-node"] = nodeId;
      proxyReqOpts.headers["x-forwarded-edge-region"] = region;
      return proxyReqOpts;
    },
  })
);

const syncClient = new SyncClient({
  coordinatorUrl,
  nodeId,
  region,
  syncIntervalMs: parseInt(process.env.SYNC_INTERVAL_MS || "500", 10),
});

app.listen(port, async () => {
  console.log(`[DATA PLANE] Regional Edge Node (${nodeId} - ${region}) listening on port ${port}`);
  console.log(`Forwarding allowed requests to Origin Gateway: ${gatewayUrl}`);
  await syncClient.start();
});
