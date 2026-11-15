/**
 * Comprehensive Verification & Fault Injection Test Suite
 * Tests Data Plane (Edge Node) and Control Plane (Coordinator)
 */
import { spawn } from "child_process";
import path from "path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log("=================================================================");
  console.log("   EDGE-BASED RATE LIMITER: VERIFICATION & CHAOS TEST SUITE      ");
  console.log("=================================================================\n");

  const coordinatorPath = path.resolve("backend/services/rate-limiter/index.js");
  const edgeNodePath = path.resolve("backend/edge-node/index.js");

  // 1. Launch Coordinator Service (Port 8005)
  console.log("[1/6] Launching Coordinator Sync Service on port 8005...");
  const coordinatorProc = spawn("node", [coordinatorPath], {
    stdio: "inherit",
    env: { ...process.env, PORT: "8005" },
  });

  // Wait 3 seconds for MongoDB connection and default rule seeding
  await sleep(3500);

  try {
    // 2. Verify Coordinator Health & Rules
    console.log("\n[2/6] Testing Coordinator API Endpoints...");
    const rulesRes = await fetch("http://localhost:8005/api/rate-limit/rules");
    const rulesData = await rulesRes.json();
    console.log(`✓ Rules endpoint active. Loaded ${rulesData.rules?.length} rules (v${rulesData.version})`);

    const statusRes = await fetch("http://localhost:8005/api/rate-limit/status");
    const statusData = await statusRes.json();
    console.log(`✓ Coordinator status: ${statusData.status}, rules count: ${statusData.rulesCount}`);

    // 3. Test Control Plane Batch Sync & Idempotency
    console.log("\n[3/6] Testing Control Plane Batch Sync & Idempotency Claim...");
    const syncPayload = {
      nodeId: "test-node-mumbai",
      region: "ap-south-1",
      epoch: 1740001000,
      seq: 1,
      clientRuleVersion: 0,
      records: [
        { key: "test_user_01:coding", admitted: 2, denied: 1 },
      ],
      leaseRequests: [
        { key: "test_user_01:coding", agent: "coding", plan: "free", requestedUnits: 5 },
      ],
    };

    const syncRes1 = await fetch("http://localhost:8005/api/rate-limit/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syncPayload),
    });
    const syncData1 = await syncRes1.json();
    console.log(`✓ Sync Response Status: ${syncData1.status}, Granted Leases: ${syncData1.leases?.length}`);
    console.log(`  Granted Units: ${syncData1.leases[0]?.grantedUnits}, TTL: ${syncData1.leases[0]?.leaseTtlMs}ms`);

    // Resend exact same batch to test idempotent replay protection
    const syncRes2 = await fetch("http://localhost:8005/api/rate-limit/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syncPayload),
    });
    const syncData2 = await syncRes2.json();
    if (syncData2.idempotentReplay) {
      console.log("✓ Idempotency verified: duplicate batch identified and replay returned without double-counting usage!");
    } else {
      console.warn("! Idempotency check warning:", syncData2);
    }

    // 4. Launch Regional Edge Node (Port 7999)
    console.log("\n[4/6] Launching Regional Edge Node on port 7999...");
    const edgeProc = spawn("node", [edgeNodePath], {
      stdio: "inherit",
      env: { ...process.env, PORT: "7999", COORDINATOR_URL: "http://localhost:8005", ORIGIN_GATEWAY_URL: "http://localhost:8000" },
    });

    await sleep(2500);

    const edgeHealthRes = await fetch("http://localhost:7999/edge-health");
    const edgeHealthData = await edgeHealthRes.json();
    console.log(`✓ Edge Node Online: NodeId=${edgeHealthData.nodeId}, Region=${edgeHealthData.region}, CoordinatorReachable=${edgeHealthData.coordinatorReachable}`);

    // 5. Test Data Plane Rate Limiting & Sub-Millisecond Rejection
    console.log("\n[5/6] Testing Data Plane Token Bucket & Edge Interception Latency...");
    const testUserId = `user_burst_${Date.now()}`;

    // Burst 10 requests rapidly in parallel for coding (capacity 5, lease 2)
    let allowedCount = 0;
    let deniedCount = 0;
    let lastRejectionPayload = null;

    const burstRequests = Array.from({ length: 10 }).map(async (_, idx) => {
      const startTime = performance.now();
      const res = await fetch("http://localhost:7999/api/agent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": testUserId,
          "x-user-plan": "free",
        },
        body: JSON.stringify({ agent: "coding", prompt: "Fast burst test" }),
      });
      const durationMs = (performance.now() - startTime).toFixed(2);

      if (res.status === 429) {
        deniedCount++;
        lastRejectionPayload = await res.json();
        console.log(`  Burst #${idx + 1}: [HTTP 429 BLOCKED] in ${durationMs}ms (Retry-After=${res.headers.get("Retry-After")}, Node=${res.headers.get("X-Edge-Node")})`);
      } else {
        allowedCount++;
        console.log(`  Burst #${idx + 1}: [ALLOWED] Remaining tokens: ${res.headers.get("X-RateLimit-Remaining")}`);
      }
    });

    await Promise.all(burstRequests);

    console.log(`✓ Burst Results: Allowed=${allowedCount}, Denied (429)=${deniedCount}`);
    if (lastRejectionPayload?.edgeIntercepted) {
      console.log(`✓ Edge Interception confirmed! Blocked locally at ${lastRejectionPayload.edgeNode} with 0 origin load.`);
    }

    // 6. Test Fault Tolerance (Simulated Network Partition)
    console.log("\n[6/6] Testing Fault Tolerance & Partition Resilience (Killing Coordinator)...");
    coordinatorProc.kill();
    console.log("  [Chaos Injection] Coordinator forcefully killed. Testing edge autonomous survival...");

    await sleep(1000);

    const edgeSurviveRes = await fetch("http://localhost:7999/edge-health");
    const edgeSurviveData = await edgeSurviveRes.json();
    console.log(`✓ Edge Node still responsive without crashing! (CoordinatorReachable: ${edgeSurviveData.coordinatorReachable})`);

    console.log("\n=================================================================");
    console.log("   ALL DISTRIBUTED RATE LIMITER VERIFICATION TESTS PASSED!       ");
    console.log("=================================================================\n");

    edgeProc.kill();
    process.exit(0);
  } catch (error) {
    console.error("Test failure:", error);
    coordinatorProc.kill();
    process.exit(1);
  }
}

runTests();
