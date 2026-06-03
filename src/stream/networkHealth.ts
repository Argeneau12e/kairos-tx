import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// NETWORK HEALTH SCORE
// Computes a 0-100 score from multiple real signals:
// - p→c delta trend (most important)
// - Tip floor trend
// - Jito leader coverage
// - Slot skip rate from stream
//
// This score feeds the AI agent on every bundle decision
// and is logged in every lifecycle entry
// ============================================================

export interface HealthSnapshot {
  score: number;                          // 0-100
  grade: "excellent" | "healthy" | "congested" | "degraded";
  pcDeltaMs: number;                      // latest p→c delta
  pcDeltaTrend: "improving" | "stable" | "worsening";
  tipTrend: "rising" | "stable" | "falling";
  jitoCoveragePct: number;
  slotSkipRate: number;                   // 0.0 to 1.0
  timestamp: string;
  signals: {
    pcDeltaScore: number;                 // 0-40 points
    tipTrendScore: number;               // 0-20 points
    jitoCoverageScore: number;           // 0-25 points
    slotSkipScore: number;               // 0-15 points
  };
}

export interface HealthInput {
  recentPcDeltas: number[];              // last N p→c deltas in ms
  tipP75History: number[];               // last N P75 tip values
  jitoCoveragePct: number;               // 0-100
  recentSlots: number[];                 // recent slot numbers for skip detection
}

// ============================================================
// INTERNAL STATE
// ============================================================

const pcDeltaHistory: number[] = [];
const tipP75History: number[] = [];
const slotHistory: number[] = [];
const MAX_HISTORY = 10;

// ============================================================
// UPDATE FUNCTIONS — call these as data arrives
// ============================================================

export function recordPcDelta(deltaMs: number): void {
  pcDeltaHistory.push(deltaMs);
  if (pcDeltaHistory.length > MAX_HISTORY) {
    pcDeltaHistory.shift();
  }
}

export function recordTipP75(p75: number): void {
  tipP75History.push(p75);
  if (tipP75History.length > MAX_HISTORY) {
    tipP75History.shift();
  }
}

export function recordSlot(slot: number): void {
  slotHistory.push(slot);
  if (slotHistory.length > MAX_HISTORY * 5) {
    slotHistory.shift();
  }
}

// ============================================================
// COMPUTE HEALTH SCORE
// ============================================================

export function computeHealthScore(jitoCoveragePct: number): HealthSnapshot {
  const now = new Date().toISOString();

  // ── Signal 1: p→c delta (0-40 points) ─────────────────────
  // Based on most recent delta + trend
  const latestDelta = pcDeltaHistory.length > 0
    ? pcDeltaHistory[pcDeltaHistory.length - 1]
    : 1500;

  let pcDeltaScore: number;
  if (latestDelta < 1000)      pcDeltaScore = 40;
  else if (latestDelta < 1500) pcDeltaScore = 35;
  else if (latestDelta < 2000) pcDeltaScore = 28;
  else if (latestDelta < 3000) pcDeltaScore = 15;
  else if (latestDelta < 5000) pcDeltaScore = 5;
  else                         pcDeltaScore = 0;

  // Trend: compare last 3 vs previous 3
  let pcDeltaTrend: "improving" | "stable" | "worsening" = "stable";
  if (pcDeltaHistory.length >= 6) {
    const recent = avg(pcDeltaHistory.slice(-3));
    const previous = avg(pcDeltaHistory.slice(-6, -3));
    const changePct = ((recent - previous) / previous) * 100;
    if (changePct < -10) pcDeltaTrend = "improving";
    else if (changePct > 10) pcDeltaTrend = "worsening";
    // Worsening trend penalizes score
    if (pcDeltaTrend === "worsening") pcDeltaScore = Math.max(0, pcDeltaScore - 8);
    if (pcDeltaTrend === "improving") pcDeltaScore = Math.min(40, pcDeltaScore + 5);
  }

  // ── Signal 2: Tip trend (0-20 points) ─────────────────────
  // Rising tips = congestion = lower score
  let tipTrendScore = 15; // default neutral
  let tipTrend: "rising" | "stable" | "falling" = "stable";

  if (tipP75History.length >= 4) {
    const recentTip = avg(tipP75History.slice(-2));
    const previousTip = avg(tipP75History.slice(-4, -2));
    const changePct = ((recentTip - previousTip) / previousTip) * 100;

    if (changePct > 50) {
      tipTrend = "rising";
      tipTrendScore = 5;   // big penalty for rising tips
    } else if (changePct > 20) {
      tipTrend = "rising";
      tipTrendScore = 10;
    } else if (changePct < -20) {
      tipTrend = "falling";
      tipTrendScore = 20;  // bonus for falling tips = less congestion
    } else {
      tipTrend = "stable";
      tipTrendScore = 15;
    }
  }

  // ── Signal 3: Jito leader coverage (0-25 points) ──────────
  // Higher coverage = more opportunities = healthier for bundles
  let jitoCoverageScore: number;
  if (jitoCoveragePct >= 60)      jitoCoverageScore = 25;
  else if (jitoCoveragePct >= 45) jitoCoverageScore = 20;
  else if (jitoCoveragePct >= 30) jitoCoverageScore = 14;
  else if (jitoCoveragePct >= 20) jitoCoverageScore = 8;
  else                            jitoCoverageScore = 3;

  // ── Signal 4: Slot skip rate (0-15 points) ────────────────
  // Detect skipped slots from stream history
  let slotSkipScore = 15; // default healthy
  let slotSkipRate = 0;

  if (slotHistory.length >= 5) {
    let skips = 0;
    for (let i = 1; i < slotHistory.length; i++) {
      const gap = slotHistory[i] - slotHistory[i - 1];
      if (gap > 2) skips++; // gap > 2 slots = likely skip
    }
    slotSkipRate = skips / (slotHistory.length - 1);

    if (slotSkipRate > 0.3)      slotSkipScore = 0;
    else if (slotSkipRate > 0.15) slotSkipScore = 5;
    else if (slotSkipRate > 0.05) slotSkipScore = 10;
    else                          slotSkipScore = 15;
  }

  // ── Final score ────────────────────────────────────────────
  const score = Math.min(100, Math.max(0,
    pcDeltaScore + tipTrendScore + jitoCoverageScore + slotSkipScore
  ));

  // ── Grade ──────────────────────────────────────────────────
  let grade: HealthSnapshot["grade"];
  if (score >= 80)      grade = "excellent";
  else if (score >= 60) grade = "healthy";
  else if (score >= 35) grade = "congested";
  else                  grade = "degraded";

  return {
    score,
    grade,
    pcDeltaMs: latestDelta,
    pcDeltaTrend,
    tipTrend,
    jitoCoveragePct,
    slotSkipRate,
    timestamp: now,
    signals: {
      pcDeltaScore,
      tipTrendScore,
      jitoCoverageScore,
      slotSkipScore,
    },
  };
}

// ============================================================
// GENERATE AI CONTEXT STRING
// Passed directly into the AI agent prompt
// ============================================================

export function getHealthContext(health: HealthSnapshot): string {
  return `NETWORK HEALTH SCORE: ${health.score}/100 (${health.grade.toUpperCase()})
- p→c delta: ${health.pcDeltaMs}ms (trend: ${health.pcDeltaTrend})
- Tip floor trend: ${health.tipTrend}
- Jito leader coverage: ${health.jitoCoveragePct.toFixed(1)}%
- Slot skip rate: ${(health.slotSkipRate * 100).toFixed(1)}%
- Signal breakdown: p→c(${health.signals.pcDeltaScore}/40) tips(${health.signals.tipTrendScore}/20) coverage(${health.signals.jitoCoverageScore}/25) skips(${health.signals.slotSkipScore}/15)`;
}

// ============================================================
// SESSION SUMMARY — for AI intelligence report
// ============================================================

export function getSessionSummary(): {
  avgPcDelta: number;
  minPcDelta: number;
  maxPcDelta: number;
  avgTipP75: number;
  minTipP75: number;
  maxTipP75: number;
  tipVolatilityRatio: number;
} {
  const avgPcDelta = avg(pcDeltaHistory) || 0;
  const avgTipP75 = avg(tipP75History) || 0;

  return {
    avgPcDelta,
    minPcDelta: Math.min(...pcDeltaHistory) || 0,
    maxPcDelta: Math.max(...pcDeltaHistory) || 0,
    avgTipP75,
    minTipP75: Math.min(...tipP75History) || 0,
    maxTipP75: Math.max(...tipP75History) || 0,
    tipVolatilityRatio: avgTipP75 > 0
      ? (Math.max(...tipP75History) / Math.min(...tipP75History)) || 1
      : 1,
  };
}

// ============================================================
// UTILITY
// ============================================================

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Network Health Score Test");
  console.log("========================================\n");

  // Simulate a session of data arriving
  console.log("--- Simulating healthy network ---");
  [1200, 1400, 1350, 1500, 1300].forEach(d => recordPcDelta(d));
  [4500, 4800, 4200, 5000, 4600].forEach(t => recordTipP75(t));
  [100, 101, 102, 103, 104, 106, 107, 108, 109, 110].forEach(s => recordSlot(s));

  const healthyScore = computeHealthScore(40);
  console.log(`Score: ${healthyScore.score}/100 (${healthyScore.grade})`);
  console.log(`p→c delta: ${healthyScore.pcDeltaMs}ms (${healthyScore.pcDeltaTrend})`);
  console.log(`Tip trend: ${healthyScore.tipTrend}`);
  console.log("Signals:", healthyScore.signals);
  console.log("\nAI context:\n" + getHealthContext(healthyScore));

  // Simulate congested network
  console.log("\n--- Simulating congested network ---");
  [2500, 3000, 2800, 3500, 4000].forEach(d => recordPcDelta(d));
  [8000, 15000, 25000, 40000, 80000].forEach(t => recordTipP75(t));

  const congestedScore = computeHealthScore(20);
  console.log(`Score: ${congestedScore.score}/100 (${congestedScore.grade})`);
  console.log(`p→c delta: ${congestedScore.pcDeltaMs}ms (${congestedScore.pcDeltaTrend})`);
  console.log(`Tip trend: ${congestedScore.tipTrend}`);

  // Session summary
  console.log("\n--- Session Summary ---");
  const summary = getSessionSummary();
  console.log(`Avg p→c delta:   ${summary.avgPcDelta.toFixed(0)}ms`);
  console.log(`Tip P75 range:   ${summary.minTipP75} → ${summary.maxTipP75} lam`);
  console.log(`Tip volatility:  ${summary.tipVolatilityRatio.toFixed(1)}x`);

  console.log("\n✅ Network Health Score tests complete");
}

if (require.main === module) { test(); }