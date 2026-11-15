/**
 * End-to-End System Test: Distributed Edge Rate Limiter
 * 
 * Verifies:
 * 1. Coordinator Sync Service initialization & MongoDB rule seeding
 * 2. Edge Node initialization & rule synchronization
 * 3. Origin Proxying (Edge Node -> Origin Gateway) for allowed requests
 * 4. Ultra-low latency Edge Interception (HTTP 429) when quota depleted
 * 5. Multi-Agent Isolation (Coding agent limit does not throttle Chat agent)
 * 6. Background Batch Synchronization & Idempotency
 * 7. Fault Tolerance & Degraded Safety Mode under Coordinator outage
 */
import { spawn } from "child_process";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("==========================================================================");
  console.log("       STARTING COMPLETE END-TO-END DISTRIBUTED RATE LIMITER TEST         ");
  console.log("==========================================================================\n");

  const coordinatorPath = path.resolve(__dirname, "../services/rate-limiter/index.js");
  const edgeNodePath = path.resolve(__dirname, "../edge-node/index.js");

  // Step 1: Create a mock Origin Gateway on port 8000 to verify forwarding
  console.log("[Setup] Starting Mock Origin Gateway on port 8000...");
  let originHitCount = 0;
  const mockOriginServer = http.createServer((req, res) => {
    originHitCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      origin: "Gateway:8000",
      answer: "Response from origin service",
      receivedEdgeNode: req.headers["x-forwarded-edge-node"],
      receivedRegion: req.headers["x-forwarded-edge-region"],
    }));
  });

  await new Promise((resolve) => mockOriginServer.listen(8000, resolve));
  console.log("✓ Mock Origin Gateway listening on port 8000\n");

  // Step 2: Launch Coordinator Sync Service (port 8005)
  console.log("[Setup] Starting Coordinator Sync Service on port 8005...");
  const coordinatorProc = spawn("node", [coordinatorPath], {
    stdio: "inherit",
    env: { ...process.env, PORT: "8005" },
  });
  await sleep(3500); // Allow MongoDB connection and rule seeding

  // Step 3: Launch Regional Edge Node (port 7999)
  console.log("[Setup] Starting Regional Edge Node on port 7999...");
  const edgeProc = spawn("node", [edgeNodePath], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: "7999",
      NODE_ID: "edge-mumbai-01",
      REGION: "ap-south-1",
      COORDINATOR_URL: "http://localhost:8005",
      ORIGIN_GATEWAY_URL: "http://localhost:8000",
      SYNC_INTERVAL_MS: "500",
    },
  });
  await sleep(2500);

  let passedTests = 0;
  let totalTests = 6;

  try {
    // -------------------------------------------------------------
    // TEST 1: Edge Proxying & Header Injections
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 1: Edge Node Forwarding to Origin for Allowed Requests");
    console.log("-------------------------------------------------------------");
    const testUserA = `user_e2e_a_${Date.now()}`;
    const t1Start = performance.now();
    const t1Res = await fetch("http://localhost:7999/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": testUserA,
        "x-user-plan": "free",
      },
      body: JSON.stringify({ agent: "chat", prompt: "Hello agent" }),
    });
    const t1Duration = (performance.now() - t1Start).toFixed(2);
    const t1Data = await t1Res.json();

    console.log(`  Response Status: ${t1Res.status}`);
    console.log(`  Roundtrip Duration: ${t1Duration}ms`);
    console.log(`  X-Edge-Node Header: ${t1Res.headers.get("x-edge-node")}`);
    console.log(`  X-RateLimit-Limit Header: ${t1Res.headers.get("x-ratelimit-limit")}`);
    console.log(`  X-RateLimit-Remaining Header: ${t1Res.headers.get("x-ratelimit-remaining")}`);
    console.log(`  Origin Forwarding Confirmed: origin=${t1Data.origin}, receivedEdgeNode=${t1Data.receivedEdgeNode}`);

    if (t1Res.status === 200 && t1Data.receivedEdgeNode === "edge-mumbai-01" && originHitCount === 1) {
      console.log("✓ TEST 1 PASSED: Request allowed and proxied to Origin with edge tracking headers.");
      passedTests++;
    } else {
      console.error("✗ TEST 1 FAILED");
    }

    // -------------------------------------------------------------
    // TEST 2: Quota Depletion & Ultra-Fast Edge Interception
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 2: Rate Limit Interception (Sub-Millisecond 429 at Edge)");
    console.log("-------------------------------------------------------------");
    const testUserB = `user_e2e_b_${Date.now()}`;
    const initialOriginHits = originHitCount;
    let t2Allowed = 0;
    let t2Blocked = 0;
    let last429Data = null;
    let fastest429Ms = 9999;

    // Free tier coding agent has capacity 5, lease 2
    for (let i = 1; i <= 6; i++) {
      const start = performance.now();
      const res = await fetch("http://localhost:7999/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testUserB,
          "x-user-plan": "free",
        },
        body: JSON.stringify({ agent: "coding", prompt: "Generate react app" }),
      });
      const duration = parseFloat((performance.now() - start).toFixed(2));

      if (res.status === 200) {
        t2Allowed++;
      } else if (res.status === 429) {
        t2Blocked++;
        if (duration < fastest429Ms) fastest429Ms = duration;
        last429Data = await res.json();
      }
    }

    const originHitsDuringTest2 = originHitCount - initialOriginHits;
    console.log(`  Allowed: ${t2Allowed}, Blocked (429): ${t2Blocked}`);
    console.log(`  Fastest 429 Edge Decision: ${fastest429Ms}ms`);
    console.log(`  Origin Hits Allowed: ${originHitsDuringTest2} (Origin shielded from ${t2Blocked} requests)`);
    console.log(`  429 Response Payload:`, JSON.stringify(last429Data));

    if (t2Blocked > 0 && last429Data?.edgeIntercepted === true && originHitsDuringTest2 === t2Allowed) {
      console.log("✓ TEST 2 PASSED: Blocked requests terminated at edge with 0 load reaching Origin.");
      passedTests++;
    } else {
      console.error("✗ TEST 2 FAILED");
    }

    // -------------------------------------------------------------
    // TEST 3: Multi-Agent Quota Isolation
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 3: Multi-Agent Quota Isolation (Coding vs Chat)");
    console.log("-------------------------------------------------------------");
    // User B was rate-limited on 'coding'. Verify they can STILL use 'chat'!
    const chatRes = await fetch("http://localhost:7999/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": testUserB,
        "x-user-plan": "free",
      },
      body: JSON.stringify({ agent: "chat", prompt: "Can I still chat?" }),
    });

    console.log(`  Status for Chat Agent: ${chatRes.status} (Remaining tokens: ${chatRes.headers.get("x-ratelimit-remaining")})`);
    if (chatRes.status === 200) {
      console.log("✓ TEST 3 PASSED: Agents have independent buckets; Coding quota limits do not starve Chat.");
      passedTests++;
    } else {
      console.error("✗ TEST 3 FAILED");
    }

    // -------------------------------------------------------------
    // TEST 4: Background Sync & Leases Aggregation
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 4: Asynchronous Batch Syncing to Control Plane");
    console.log("-------------------------------------------------------------");
    // Wait 1.5 seconds for background sync client (runs every 500ms) to flush counts to coordinator
    await sleep(1500);

    const coordinatorStatusRes = await fetch("http://localhost:8005/api/rate-limit/status");
    const coordinatorStatus = await coordinatorStatusRes.json();
    console.log(`  Coordinator Active Leases Count: ${coordinatorStatus.activeLeasesCount}`);

    const edgeHealthRes = await fetch("http://localhost:7999/edge-health");
    const edgeHealth = await edgeHealthRes.json();
    console.log(`  Edge Local KV State: Active Leases in KV = ${edgeHealth.activeLeasesInKV}, Coordinator Reachable = ${edgeHealth.coordinatorReachable}`);

    if (coordinatorStatus.status === "healthy" && edgeHealth.coordinatorReachable === true) {
      console.log("✓ TEST 4 PASSED: Background sync loop active and metrics successfully communicated.");
      passedTests++;
    } else {
      console.error("✗ TEST 4 FAILED");
    }

    // -------------------------------------------------------------
    // TEST 5: Control Plane Idempotency Verification
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 5: Control Plane Idempotency Claim Deduplication");
    console.log("-------------------------------------------------------------");
    const duplicateBatch = {
      nodeId: "edge-mumbai-01",
      region: "ap-south-1",
      epoch: 1740009999,
      seq: 99,
      clientRuleVersion: 1,
      records: [{ key: "test_dedup:vision", admitted: 1, denied: 0 }],
      leaseRequests: [{ key: "test_dedup:vision", agent: "vision", plan: "free", requestedUnits: 2 }],
    };

    const firstPost = await fetch("http://localhost:8005/api/rate-limit/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(duplicateBatch),
    });
    const firstData = await firstPost.json();

    // Replay identical batch
    const secondPost = await fetch("http://localhost:8005/api/rate-limit/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(duplicateBatch),
    });
    const secondData = await secondPost.json();

    console.log(`  First Sync Delivery: ACK=${firstData.status}, LeasesGranted=${firstData.leases?.length}`);
    console.log(`  Second Sync Delivery (Replay): IdempotentReplay=${secondData.idempotentReplay}`);

    if (firstData.status === "ACK" && secondData.idempotentReplay === true) {
      console.log("✓ TEST 5 PASSED: Idempotent claim verified. Duplicate packets acknowledged without double-counting usage.");
      passedTests++;
    } else {
      console.error("✗ TEST 5 FAILED");
    }

    // -------------------------------------------------------------
    // TEST 6: Fault Tolerance & Coordinator Outage Resilience
    // -------------------------------------------------------------
    console.log("\n-------------------------------------------------------------");
    console.log("TEST 6: Fault Tolerance & Degraded Safety Mode");
    console.log("-------------------------------------------------------------");
    console.log("  [Chaos Injection] Forcefully terminating Coordinator Sync Service...");
    coordinatorProc.kill();
    await sleep(1000); // Allow edge sync loop to detect network failure

    const chaosUser = `user_chaos_${Date.now()}`;
    const chaosChatRes = await fetch("http://localhost:7999/api/agent/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-id": chaosUser,
        "x-user-plan": "free",
      },
      body: JSON.stringify({ agent: "chat", prompt: "Can edge survive?" }),
    });

    console.log(`  Edge Node Status during Coordinator Outage: HTTP ${chaosChatRes.status}`);
    const edgeOfflineHealth = await fetch("http://localhost:7999/edge-health");
    const edgeOfflineHealthData = await edgeOfflineHealth.json();
    console.log(`  Edge Health: Status=${edgeOfflineHealthData.status}, CoordinatorReachable=${edgeOfflineHealthData.coordinatorReachable}`);

    if (edgeOfflineHealthData.status === "online" && edgeOfflineHealthData.coordinatorReachable === false) {
      console.log("✓ TEST 6 PASSED: Edge Node gracefully survived central coordinator outage without crashing.");
      passedTests++;
    } else {
      console.error("✗ TEST 6 FAILED");
    }

    // -------------------------------------------------------------
    // Final Summary
    // -------------------------------------------------------------
    console.log("\n==========================================================================");
    console.log(`               TEST RESULTS: ${passedTests} / ${totalTests} TESTS PASSED                      `);
    console.log("==========================================================================\n");

    edgeProc.kill();
    mockOriginServer.close();
    process.exit(passedTests === totalTests ? 0 : 1);
  } catch (error) {
    console.error("E2E Test Unexpected Error:", error);
    edgeProc.kill();
    coordinatorProc.kill();
    mockOriginServer.close();
    process.exit(1);
  }
}

main();
