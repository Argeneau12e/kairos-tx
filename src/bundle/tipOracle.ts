import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// TYPES
// ============================================================

export interface TipPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  timestamp: string;
  source: "live" | "cached" | "fallback";
}

// ============================================================
// CACHE
// We don't hammer the API — cache for 30 seconds
// ============================================================

let cachedTips: TipPercentiles | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

// ============================================================
// FALLBACK VALUES
// Used when API is unreachable
// Based on typical mainnet values — devnet will be lower
// ============================================================

const FALLBACK_TIPS: TipPercentiles = {
  p25: 1000,
  p50: 2000,
  p75: 5000,
  p95: 10000,
  timestamp: new Date().toISOString(),
  source: "fallback",
};

// ============================================================
// FETCH LIVE TIP DATA
// ============================================================

export async function fetchTipPercentiles(): Promise<TipPercentiles> {
  const now = Date.now();

  // Return cache if fresh
  if (cachedTips && now - cacheTimestamp < CACHE_TTL_MS) {
    console.log(`[TIP ORACLE] Using cached tips (${Math.round((now - cacheTimestamp) / 1000)}s old)`);
    return { ...cachedTips, source: "cached" };
  }

  try {
    console.log("[TIP ORACLE] Fetching live tip data from Jito...");

    const response = await fetch(
      "https://bundles.jito.wtf/api/v1/bundles/tip_floor",
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as any[];

    if (!data || data.length === 0) {
      throw new Error("Empty response from tip API");
    }

    // Jito returns an array — we want the first (most recent) entry
    const entry = data[0];

    // The API returns values in SOL — convert to lamports (1 SOL = 1,000,000,000 lamports)
    // But sometimes returns in lamports already — check magnitude
    const tolamports = (val: number): number => {
      // If value is less than 1, it's in SOL — convert
      if (val < 1) return Math.round(val * 1_000_000_000);
      // If value is already large, it's in lamports
      return Math.round(val);
    };

    const tips: TipPercentiles = {
      p25: tolamports(entry.landed_tips_25th_percentile ?? entry.p25 ?? 0.000001),
      p50: tolamports(entry.landed_tips_50th_percentile ?? entry.p50 ?? 0.000002),
      p75: tolamports(entry.landed_tips_75th_percentile ?? entry.p75 ?? 0.000005),
      p95: tolamports(entry.landed_tips_95th_percentile ?? entry.p95 ?? 0.00001),
      timestamp: new Date().toISOString(),
      source: "live",
    };

    // Sanity check — tips should be at least 1000 lamports
    // If they're suspiciously low, use fallback
    if (tips.p75 < 100) {
      console.warn("[TIP ORACLE] Tip values suspiciously low — using fallback");
      return FALLBACK_TIPS;
    }

    // Update cache
    cachedTips = tips;
    cacheTimestamp = now;

    console.log(
      `[TIP ORACLE] Live tips — P25: ${tips.p25} | P50: ${tips.p50} | P75: ${tips.p75} | P95: ${tips.p95} lam`
    );

    return tips;

  } catch (err: any) {
    console.warn("[TIP ORACLE] Failed to fetch live tips:", err.message);
    console.warn("[TIP ORACLE] Using fallback values");

    // If we have a stale cache, prefer that over hardcoded fallback
    if (cachedTips) {
      console.log("[TIP ORACLE] Using stale cache as fallback");
      return { ...cachedTips, source: "cached" };
    }

    return FALLBACK_TIPS;
  }
}

// ============================================================
// TREND DETECTION
// Call twice, compare — tells AI agent if market is moving
// ============================================================

let previousP75 = 0;

export function detectTipTrend(current: TipPercentiles): "rising" | "falling" | "stable" {
  if (previousP75 === 0) {
    previousP75 = current.p75;
    return "stable";
  }

  const changePct = ((current.p75 - previousP75) / previousP75) * 100;
  previousP75 = current.p75;

  if (changePct > 10) return "rising";
  if (changePct < -10) return "falling";
  return "stable";
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Tip Oracle Test");
  console.log("========================================\n");

  // Test 1: Live fetch
  console.log("--- Test 1: Fetching live tip data ---");
  const tips1 = await fetchTipPercentiles();
  console.log("Result:", JSON.stringify(tips1, null, 2));

  // Test 2: Cache hit (should not refetch)
  console.log("\n--- Test 2: Cache hit (should be instant) ---");
  const tips2 = await fetchTipPercentiles();
  console.log("Source:", tips2.source); // Should say "cached"

  // Test 3: Trend detection
  console.log("\n--- Test 3: Trend detection ---");
  const trend = detectTipTrend(tips1);
  console.log("Trend:", trend);

  // Test 4: What the AI agent will receive
  console.log("\n--- Test 4: Full context for AI agent ---");
  const agentContext = {
    tips: {
      p25: tips1.p25,
      p50: tips1.p50,
      p75: tips1.p75,
      p95: tips1.p95,
    },
    tipTrend: trend,
    source: tips1.source,
  };
  console.log("Agent will receive:", JSON.stringify(agentContext, null, 2));

  console.log("\n✅ Tip Oracle tests complete");
}

if (require.main === module) { test(); }