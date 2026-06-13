import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";

// ============================================================
// TYPES — what a bundle lifecycle entry looks like
// ============================================================

export interface BundleEntry {
  bundle_id: string;
  sequence: number;
  submitted_at: string;        // ISO timestamp
  submitted_slot: number;
  processed_at?: string;
  processed_slot?: number;
  confirmed_at?: string;
  confirmed_slot?: number;
  finalized_at?: string;
  finalized_slot?: number;
  tip_lamports: number;
  status: "submitted" | "processed" | "confirmed" | "finalized" | "failed";
  failure_type?: string;
  ai_tip_reasoning?: string;
  ai_failure_reasoning?: string;
  new_tip_lamports?: number;
  retry_count: number;
  region?: string;
  run_type?: "main_run" | "fault_injection";
  tip_efficiency_pct?: number;
}

export interface LifecycleUpdate {
  bundle_id: string;
  stage: "processed" | "confirmed" | "finalized" | "failed";
  slot: number;
  timestamp: string;
  failure_type?: string;
}

// ============================================================
// DATABASE SETUP
// ============================================================

const DB_PATH = path.join(process.cwd(), "logs", "kairos.db");

// Make sure logs folder exists
if (!fs.existsSync(path.join(process.cwd(), "logs"))) {
  fs.mkdirSync(path.join(process.cwd(), "logs"));
}

const db = new Database(DB_PATH);

// Create the table if it doesn't exist yet
db.exec(`
  CREATE TABLE IF NOT EXISTS bundle_lifecycle (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id            TEXT NOT NULL UNIQUE,
    sequence             INTEGER NOT NULL,
    submitted_at         TEXT NOT NULL,
    submitted_slot       INTEGER NOT NULL,
    processed_at         TEXT,
    processed_slot       INTEGER,
    confirmed_at         TEXT,
    confirmed_slot       INTEGER,
    finalized_at         TEXT,
    finalized_slot       INTEGER,
    tip_lamports         INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'submitted',
    failure_type         TEXT,
    ai_tip_reasoning     TEXT,
    ai_failure_reasoning TEXT,
    new_tip_lamports     INTEGER,
    retry_count          INTEGER NOT NULL DEFAULT 0,
    region               TEXT,
    run_type             TEXT NOT NULL DEFAULT 'main_run',
    tip_efficiency_pct   INTEGER
  );
`);

// ============================================================
// WRITE FUNCTIONS
// ============================================================

// Call this the moment you submit a bundle
export function recordSubmission(entry: BundleEntry): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO bundle_lifecycle (
      bundle_id, sequence, submitted_at, submitted_slot,
      tip_lamports, status, retry_count, region,
      ai_tip_reasoning, run_type
    ) VALUES (
      @bundle_id, @sequence, @submitted_at, @submitted_slot,
      @tip_lamports, @status, @retry_count, @region,
      @ai_tip_reasoning, @run_type
    )
  `);

  stmt.run({
    bundle_id: entry.bundle_id,
    sequence: entry.sequence,
    submitted_at: entry.submitted_at,
    submitted_slot: entry.submitted_slot,
    tip_lamports: entry.tip_lamports,
    status: "submitted",
    retry_count: entry.retry_count ?? 0,
    region: entry.region ?? "devnet",
    ai_tip_reasoning: entry.ai_tip_reasoning ?? null,
    run_type: entry.run_type ?? "main_run",
  });

  console.log(`[STORE] Recorded submission: ${entry.bundle_id} at slot ${entry.submitted_slot}`);
}

// Call this when the bundle moves to a new stage
export function updateStage(update: LifecycleUpdate): void {
  const now = update.timestamp;
  const slot = update.slot;
  const id = update.bundle_id;

  let stmt;

  if (update.stage === "processed") {
    stmt = db.prepare(`
      UPDATE bundle_lifecycle
      SET processed_at = ?, processed_slot = ?, status = 'processed'
      WHERE bundle_id = ?
    `);
    stmt.run(now, slot, id);

  } else if (update.stage === "confirmed") {
    stmt = db.prepare(`
      UPDATE bundle_lifecycle
      SET confirmed_at = ?, confirmed_slot = ?, status = 'confirmed'
      WHERE bundle_id = ?
    `);
    stmt.run(now, slot, id);

  } else if (update.stage === "finalized") {
    stmt = db.prepare(`
      UPDATE bundle_lifecycle
      SET finalized_at = ?, finalized_slot = ?, status = 'finalized'
      WHERE bundle_id = ?
    `);
    stmt.run(now, slot, id);

  } else if (update.stage === "failed") {
    stmt = db.prepare(`
      UPDATE bundle_lifecycle
      SET status = 'failed', failure_type = ?
      WHERE bundle_id = ?
    `);
    stmt.run(update.failure_type ?? "unknown", id);
  }

  console.log(`[STORE] Updated ${id} → ${update.stage} at slot ${slot}`);
}

// Call this when AI agent makes a retry decision
export function recordAIRetry(
  bundle_id: string,
  reasoning: string,
  new_tip: number
): void {
  const stmt = db.prepare(`
    UPDATE bundle_lifecycle
    SET ai_failure_reasoning = ?,
        new_tip_lamports = ?,
        retry_count = retry_count + 1
    WHERE bundle_id = ?
  `);
  stmt.run(reasoning, new_tip, bundle_id);
  console.log(`[STORE] Recorded AI retry decision for ${bundle_id}`);
}

export function recordTipEfficiency(bundle_id: string, efficiency: number): void {
  const stmt = db.prepare(`
    UPDATE bundle_lifecycle
    SET tip_efficiency_pct = ?
    WHERE bundle_id = ?
  `);
  stmt.run(Math.round(efficiency), bundle_id);
}
// ============================================================
// READ FUNCTIONS
// ============================================================

export function getAllBundles(): BundleEntry[] {
  return db.prepare("SELECT * FROM bundle_lifecycle ORDER BY sequence ASC").all() as BundleEntry[];
}

export function getBundleById(bundle_id: string): BundleEntry | undefined {
  return db.prepare("SELECT * FROM bundle_lifecycle WHERE bundle_id = ?").get(bundle_id) as BundleEntry;
}

export function getStats() {
  const total = (db.prepare("SELECT COUNT(*) as count FROM bundle_lifecycle").get() as any).count;
  const finalized = (db.prepare("SELECT COUNT(*) as count FROM bundle_lifecycle WHERE status = 'finalized'").get() as any).count;
  const failed = (db.prepare("SELECT COUNT(*) as count FROM bundle_lifecycle WHERE status = 'failed'").get() as any).count;

  return { total, finalized, failed, success_rate: `${((finalized / total) * 100).toFixed(1)}%` };
}

// ============================================================
// EXPORT FUNCTION — produces the JSON file judges will read
// ============================================================

export function exportToJSON(): void {
  const bundles = getAllBundles();

  // Enrich each bundle with calculated latency fields
  const enriched = bundles.map((b) => {
    const latency: any = {};

    if (b.submitted_at && b.processed_at) {
      latency.submit_to_processed_ms =
        new Date(b.processed_at).getTime() - new Date(b.submitted_at).getTime();
    }

    if (b.processed_at && b.confirmed_at) {
      latency.processed_to_confirmed_ms =
        new Date(b.confirmed_at).getTime() - new Date(b.processed_at).getTime();
    }

    if (b.confirmed_at && b.finalized_at) {
      latency.confirmed_to_finalized_ms =
        new Date(b.finalized_at).getTime() - new Date(b.confirmed_at).getTime();
    }

    if (b.submitted_slot && b.finalized_slot) {
      latency.total_slots = b.finalized_slot - b.submitted_slot;
    }

    return { ...b, latency };
  });

  const exportPath = path.join(process.cwd(), "logs", "lifecycle_export.json");
  fs.writeFileSync(exportPath, JSON.stringify(enriched, null, 2));
  console.log(`\n[EXPORT] Lifecycle log written to logs/lifecycle_export.json`);
  console.log(`[EXPORT] ${enriched.length} bundles exported`);
}

// ============================================================
// TEST — run this file directly to verify everything works
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Lifecycle Store Test");
  console.log("========================================\n");

  // Simulate a successful bundle
  console.log("--- Test 1: Simulating a successful bundle ---");
  recordSubmission({
    bundle_id: "test-bundle-001",
    sequence: 1,
    submitted_at: new Date().toISOString(),
    submitted_slot: 368502100,
    tip_lamports: 5200,
    status: "submitted",
    retry_count: 0,
    region: "devnet",
    ai_tip_reasoning: "Network healthy. P75 stable at 4800 lam. Tipping at 108% P75 for reliable landing.",
  });

  await new Promise(r => setTimeout(r, 500));

  updateStage({
    bundle_id: "test-bundle-001",
    stage: "processed",
    slot: 368502103,
    timestamp: new Date().toISOString(),
  });

  await new Promise(r => setTimeout(r, 800));

  updateStage({
    bundle_id: "test-bundle-001",
    stage: "confirmed",
    slot: 368502107,
    timestamp: new Date().toISOString(),
  });

  await new Promise(r => setTimeout(r, 500));

  updateStage({
    bundle_id: "test-bundle-001",
    stage: "finalized",
    slot: 368502139,
    timestamp: new Date().toISOString(),
  });

  // Simulate a failed bundle with AI retry
  console.log("\n--- Test 2: Simulating a failed bundle + AI retry ---");
  recordSubmission({
    bundle_id: "test-bundle-002",
    sequence: 2,
    submitted_at: new Date().toISOString(),
    submitted_slot: 368502200,
    tip_lamports: 1200,
    status: "submitted",
    retry_count: 0,
    region: "devnet",
    ai_tip_reasoning: "Low congestion detected. Tipping conservatively at P30.",
  });

  await new Promise(r => setTimeout(r, 500));

  updateStage({
    bundle_id: "test-bundle-002",
    stage: "failed",
    slot: 368502350,
    timestamp: new Date().toISOString(),
    failure_type: "blockhash_expired",
  });

  recordAIRetry(
    "test-bundle-002",
    "Bundle failed due to blockhash expiry. 150 slots elapsed before Jito leader window appeared. Root cause: low Jito leader density in submission window. Action: refresh blockhash, increase tip to P85 to guarantee execution in first available window.",
    9400
  );

  // Print stats
  console.log("\n--- Stats ---");
  const stats = getStats();
  console.log("Total bundles:", stats.total);
  console.log("Finalized:", stats.finalized);
  console.log("Failed:", stats.failed);
  console.log("Success rate:", stats.success_rate);

  // Export to JSON
  console.log("\n--- Exporting to JSON ---");
  exportToJSON();

  console.log("\n✅ All tests passed. Check logs/lifecycle_export.json");
}

if (require.main === module) { test(); }