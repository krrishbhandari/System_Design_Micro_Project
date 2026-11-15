import { localKV } from "../kv/localStore.js";

export class SyncClient {
  constructor({ coordinatorUrl, nodeId, region, syncIntervalMs = 500 }) {
    this.coordinatorUrl = coordinatorUrl || "http://localhost:8005";
    this.nodeId = nodeId || "edge-node-01";
    this.region = region || "default";
    this.syncIntervalMs = syncIntervalMs;
    this.timer = null;
    this.isRunning = false;
  }

  async start() {
    console.log(`Starting Edge Sync Client [Node: ${this.nodeId}, Region: ${this.region}]`);
    // 1. Initial bootstrap: fetch current rules from Coordinator
    await this.fetchInitialRules();

    // 2. Start recurring async background sync
    this.isRunning = true;
    this.timer = setInterval(() => {
      this.syncBatch().catch((err) => {
        // Coordinator network partition or timeout
        localKV.isCoordinatorReachable = false;
      });
    }, this.syncIntervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async fetchInitialRules() {
    try {
      const res = await fetch(`${this.coordinatorUrl}/api/rate-limit/rules`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = await res.json();
        localKV.setRules(data.rules || [], data.version || 1);
        localKV.isCoordinatorReachable = true;
        console.log(`Edge Node loaded ${data.rules?.length || 0} rate-limit rules (v${data.version})`);
      }
    } catch (error) {
      console.warn("Initial Coordinator contact failed. Starting edge node with default rules.");
      localKV.isCoordinatorReachable = false;
    }
  }

  async syncBatch() {
    const batch = localKV.drainPendingBatch();

    // Don't issue empty sync pulses if nothing to report and no lease requests
    if (batch.records.length === 0 && batch.leaseRequests.length === 0) {
      return;
    }

    const payload = {
      nodeId: this.nodeId,
      region: this.region,
      epoch: batch.epoch,
      seq: batch.seq,
      clientRuleVersion: localKV.ruleVersion,
      records: batch.records,
      leaseRequests: batch.leaseRequests,
    };

    try {
      const res = await fetch(`${this.coordinatorUrl}/api/rate-limit/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000), // Short timeout for edge responsiveness
      });

      if (!res.ok) {
        throw new Error(`Sync HTTP ${res.status}`);
      }

      const data = await res.json();
      localKV.isCoordinatorReachable = true;

      // Update leases
      if (data.leases && Array.isArray(data.leases)) {
        for (const l of data.leases) {
          localKV.setLease(l.key, l);
        }
      }

      // Update rules if edge is stale
      if (data.rulesUpdated && data.rules) {
        localKV.setRules(data.rules, data.rules[0]?.version || localKV.ruleVersion + 1);
      }
    } catch (error) {
      localKV.isCoordinatorReachable = false;
      // Re-queue un-synced metrics if needed
      for (const r of batch.records) {
        localKV.recordAdmission(r.key, r.admitted);
        localKV.recordDenial(r.key, r.denied);
      }
    }
  }
}
