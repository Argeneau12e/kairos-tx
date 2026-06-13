import chalk from "chalk";
import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// KAIROS LIVE TERMINAL DASHBOARD — v2
// Unicode block characters for visual richness
// Fixed-width rendering (no chalk padEnd bugs)
// ============================================================

export interface DashboardState {
  currentSlot: number;
  streamMode: "real" | "mock";
  streamConnected: boolean;
  networkScore: number;
  networkGrade: string;
  pcDeltaMs: number;
  pcDeltaTrend: string;
  tipP25: number;
  tipP50: number;
  tipP75: number;
  tipP95: number;
  tipTrend: string;
  jitoCoverage: number;
  nextJitoSlot: number;
  slotsUntilJito: number;
  leaderSchedule: boolean[];   // 50 slots: true = Jito leader
  blockhashFetchedSlot: number;
  blockhashExpiresSlot: number;
  healthHistory: number[];     // last 10 health scores for sparkline
  lastAiDecision: {
    tip: number;
    assessment: string;
    confidence: string;
    reasoning: string;
    landingProbability: number;
  } | null;
  bundles: Array<{
    sequence: number;
    status: string;
    tip: number;
    submittedSlot: number;
    confirmedSlot?: number;
    latencyMs?: number;
    tipEfficiency?: number;
    preflight?: number;        // compute units from simulation
  }>;
  totalBundles: number;
  targetBundles: number;
  finalized: number;
  failed: number;
  held: number;
  sessionStartSlot: number;
  solSpent: number;            // total lamports spent / 1e9
  isHolding: boolean;
  holdReason: string;
}

// ============================================================
// UNICODE HELPERS
// ============================================================

const BLOCK_FULL  = "█";
const BLOCK_LIGHT = "░";
const DOT_FULL    = "●";
const DOT_EMPTY   = "○";
const DOT_HOLD    = "◌";

function progressBar(value: number, max: number, width: number, color: (s: string) => string): string {
  const filled = Math.round((value / max) * width);
  const empty = width - filled;
  return color(BLOCK_FULL.repeat(filled)) + chalk.gray(BLOCK_LIGHT.repeat(empty));
}

function sparkline(values: number[]): string {
  if (values.length === 0) return "─".repeat(10);
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map(v => {
    const idx = Math.floor(((v - min) / range) * 7);
    return chars[Math.min(idx, 7)];
  }).join("");
}

function scoreColor(score: number): (s: string) => string {
  if (score >= 80) return chalk.greenBright;
  if (score >= 60) return chalk.green;
  if (score >= 35) return chalk.yellow;
  return chalk.red;
}

function gradeStr(grade: string, score: number): string {
  const labels: Record<string, string> = {
    excellent: "EXCELLENT",
    healthy:   "HEALTHY  ",
    congested: "CONGESTED",
    degraded:  "DEGRADED ",
  };
  const label = labels[grade] ?? grade.padEnd(9).toUpperCase();
  return scoreColor(score)(label);
}

function tipTrendStr(trend: string): string {
  if (trend === "rising")  return chalk.red("↑ rising ");
  if (trend === "falling") return chalk.green("↓ falling");
  return chalk.white("→ stable ");
}

function deltaTrendStr(trend: string): string {
  if (trend === "worsening")  return chalk.red("↑ worse");
  if (trend === "improving")  return chalk.green("↓ better");
  return chalk.white("→ stable");
}

function bundleStatusDot(status: string): string {
  if (status === "finalized") return chalk.greenBright(DOT_FULL);
  if (status === "confirmed") return chalk.green(DOT_FULL);
  if (status === "submitted") return chalk.cyan(DOT_FULL);
  if (status === "held")      return chalk.yellow(DOT_HOLD);
  if (status === "failed")    return chalk.red("✗");
  return chalk.gray(DOT_EMPTY);
}

function bundlePipeline(status: string, width = 28): string {
  // submitted → processed → confirmed → finalized
  const stages = {
    "submitted":  4,
    "processed":  10,
    "confirmed":  22,
    "finalized":  28,
    "failed":     0,
    "held":       0,
  };
  const filled = stages[status] ?? 0;
  const empty = width - filled;

  let bar = "";
  if (status === "failed") {
    bar = chalk.red("✗" + "─".repeat(width - 1));
  } else if (status === "held") {
    bar = chalk.yellow("⏸ " + "─".repeat(width - 2));
  } else {
    const col = status === "finalized" ? chalk.greenBright
               : status === "confirmed" ? chalk.green
               : status === "processed"  ? chalk.cyan
               : chalk.blue;
    bar = col(BLOCK_FULL.repeat(filled)) + chalk.gray(BLOCK_LIGHT.repeat(empty));
  }
  return bar;
}

function leaderScheduleBar(schedule: boolean[], width = 50): string {
  return schedule.slice(0, width).map((isJito, i) => {
    if (i === 0) return chalk.cyan("▶");
    return isJito ? chalk.greenBright("█") : chalk.gray("░");
  }).join("");
}

function blockhashBar(fetched: number, current: number, expires: number): string {
  const total = 150;
  const elapsed = Math.max(0, current - fetched);
  const remaining = Math.max(0, expires - current);
  const pct = elapsed / total;

  const width = 24;
  const filled = Math.min(width, Math.round(pct * width));
  const empty = width - filled;

  const barColor = pct < 0.6 ? chalk.green : pct < 0.85 ? chalk.yellow : chalk.red;
  const bar = barColor(BLOCK_FULL.repeat(filled)) + chalk.gray(BLOCK_LIGHT.repeat(empty));
  return `${bar} ${remaining}/150`;
}

// ============================================================
// FIXED-WIDTH LINE BUILDER
// ============================================================

const W = 73; // total inner width

function pad(text: string, width: number): string {
  // strip ANSI codes for length calculation
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const diff = width - clean.length;
  if (diff <= 0) return text;
  return text + " ".repeat(diff);
}

function row(content: string): string {
  return chalk.cyan("║") + " " + pad(content, W - 2) + " " + chalk.cyan("║");
}

function divider(): string {
  return chalk.cyan("╠" + "═".repeat(W) + "╣");
}

function separator(): string {
  return chalk.cyan("║") + chalk.gray("─".repeat(W)) + chalk.cyan("║");
}

// ============================================================
// RENDER
// ============================================================

let lastRender = 0;
const RENDER_MS = 400;

export function renderDashboard(state: DashboardState): void {
  if (Date.now() - lastRender < RENDER_MS) return;
  lastRender = Date.now();

  const lines: string[] = [];

  // ── Header ───────────────────────────────────────────────
  lines.push(chalk.cyan("╔" + "═".repeat(W) + "╗"));

  const streamTag = state.streamConnected
    ? chalk.greenBright("● LIVE") + chalk.gray("  " + (state.streamMode === "real" ? "Yellowstone gRPC" : "MOCK"))
    : chalk.red("○ OFFLINE");

  const slotStr = chalk.white(state.currentSlot.toLocaleString());
  const holdTag = state.isHolding ? chalk.yellow("  ⏸ HOLDING") : "";

  lines.push(row(
    chalk.bold.cyan("K A I R O S") +
    chalk.gray("  ·  Smart Transaction Stack  ·  ") +
    streamTag +
    chalk.gray("  ·  SLOT ") + slotStr + holdTag
  ));

  if (state.isHolding) {
    lines.push(row(chalk.yellow(`  ⚠  HOLD: ${state.holdReason}`)));
  }

  lines.push(divider());

  // ── Three columns ─────────────────────────────────────────
  // Column widths (inner): 22 | 24 | 22
  const C1 = 22, C2 = 24, C3 = 22;

  const sc = scoreColor(state.networkScore);

  // Row 1: column headers
  lines.push(
    chalk.cyan("║") + "  " +
    chalk.bold(pad("NETWORK HEALTH", C1)) +
    chalk.gray("│") +
    " " + chalk.bold(pad("JITO TIP ORACLE", C2)) +
    chalk.gray("│") +
    " " + chalk.bold(pad("SESSION", C3)) +
    " " + chalk.cyan("║")
  );

  // Row 2: score | P25 bar | bundles
  const scoreBar = progressBar(state.networkScore, 100, 14, sc);
  const p25rel = Math.round((state.tipP25 / Math.max(state.tipP95, 1)) * 12);
  const p25bar = chalk.gray(BLOCK_FULL.repeat(p25rel) + BLOCK_LIGHT.repeat(12 - p25rel));

  lines.push(
    chalk.cyan("║") + "  " +
    pad(sc(`  ${state.networkScore}/100`), C1) +
    chalk.gray("│") +
    ` P25 ${pad(p25bar, 12)} ${pad(state.tipP25.toLocaleString(), 7)}` +
    chalk.gray("│") +
    " " + pad(chalk.white(`${state.totalBundles}/${state.targetBundles}`) + chalk.gray(" submitted"), C3) +
    " " + chalk.cyan("║")
  );

  // Row 3: grade bar | P50 | finalized
  const p50rel = Math.round((state.tipP50 / Math.max(state.tipP95, 1)) * 12);
  const p50bar = chalk.cyan(BLOCK_FULL.repeat(p50rel) + BLOCK_LIGHT.repeat(12 - p50rel));

  lines.push(
    chalk.cyan("║") + "  " +
    scoreBar + " " + gradeStr(state.networkGrade, state.networkScore) +
    chalk.gray("│") +
    ` P50 ${pad(p50bar, 12)} ${pad(state.tipP50.toLocaleString(), 7)}` +
    chalk.gray("│") +
    " " + pad(chalk.greenBright(`${state.finalized} finalized`) + " ✓", C3) +
    " " + chalk.cyan("║")
  );

  // Row 4: p→c | P75 | failed
  const p75rel = Math.round((state.tipP75 / Math.max(state.tipP95, 1)) * 12);
  const p75color = state.tipTrend === "rising" ? chalk.red : chalk.green;
  const p75bar = p75color(BLOCK_FULL.repeat(p75rel) + BLOCK_LIGHT.repeat(12 - p75rel));
  const pcColor = state.pcDeltaMs < 2000 ? chalk.green : state.pcDeltaMs < 4000 ? chalk.yellow : chalk.red;

  lines.push(
    chalk.cyan("║") + "  " +
    pad(chalk.gray("p→c ") + pcColor(`${state.pcDeltaMs}ms`) + " " + deltaTrendStr(state.pcDeltaTrend), C1) +
    chalk.gray("│") +
    ` P75 ${pad(p75bar, 12)} ${pad(state.tipP75.toLocaleString(), 7)}` +
    chalk.gray("│") +
    " " + pad(state.failed > 0 ? chalk.red(`${state.failed} failed`) : chalk.gray("0 failed"), C3) +
    " " + chalk.cyan("║")
  );

  // Row 5: coverage | P95 | SOL spent
  const p95bar = chalk.magenta(BLOCK_FULL.repeat(12) + BLOCK_LIGHT.repeat(0));
  const covColor = state.jitoCoverage > 50 ? chalk.greenBright : state.jitoCoverage > 25 ? chalk.yellow : chalk.red;

  lines.push(
    chalk.cyan("║") + "  " +
    pad(chalk.gray("Jito ") + covColor(`${state.jitoCoverage.toFixed(0)}%`) + chalk.gray(" coverage"), C1) +
    chalk.gray("│") +
    ` P95 ${pad(p95bar, 12)} ${pad(state.tipP95.toLocaleString(), 7)}` +
    chalk.gray("│") +
    " " + pad(chalk.gray(`${(state.solSpent / 1e9).toFixed(5)} SOL spent`), C3) +
    " " + chalk.cyan("║")
  );

  // Row 6: sparkline | tip trend | held
  const spark = state.healthHistory.length > 0
    ? sc(sparkline(state.healthHistory))
    : chalk.gray("─".repeat(10));

  lines.push(
    chalk.cyan("║") + "  " +
    pad(chalk.gray("Health: ") + spark, C1) +
    chalk.gray("│") +
    " " + chalk.gray("Trend: ") + tipTrendStr(state.tipTrend) + " ".repeat(14) +
    chalk.gray("│") +
    " " + pad(state.held > 0 ? chalk.yellow(`${state.held} held`) : chalk.gray("0 held"), C3) +
    " " + chalk.cyan("║")
  );

  lines.push(separator());

  // ── Leader Schedule ───────────────────────────────────────
  const jitoSlotStr = state.slotsUntilJito === 0
    ? chalk.greenBright("NOW")
    : chalk.white(`+${state.slotsUntilJito}`);

  lines.push(row(chalk.bold("JITO LEADER SCHEDULE") + chalk.gray("  (next 50 slots)  next window: ") + jitoSlotStr));

  if (state.leaderSchedule.length > 0) {
    lines.push(row("  " + leaderScheduleBar(state.leaderSchedule)));
    lines.push(row(chalk.gray("  ▶ now") + " ".repeat(15) + chalk.green("█ Jito") + "  " + chalk.gray("░ other")));
  } else {
    lines.push(row(chalk.gray("  Fetching leader schedule...")));
  }

  lines.push(separator());

  // ── Blockhash Health ─────────────────────────────────────
  const bhBar = state.blockhashFetchedSlot > 0
    ? blockhashBar(state.blockhashFetchedSlot, state.currentSlot, state.blockhashExpiresSlot)
    : chalk.gray("─".repeat(26) + " pending");

  lines.push(row(chalk.bold("BLOCKHASH") + chalk.gray("  validity remaining  ") + bhBar));

  lines.push(divider());

  // ── AI Agent ─────────────────────────────────────────────
  lines.push(row(chalk.bold.magenta("AI AGENT — LAST DECISION")));

  if (state.lastAiDecision) {
    const d = state.lastAiDecision;
    const probColor = d.landingProbability >= 80 ? chalk.greenBright
                    : d.landingProbability >= 60 ? chalk.green
                    : d.landingProbability >= 40 ? chalk.yellow : chalk.red;

    lines.push(row(
      chalk.gray("  Tip: ") + chalk.bold.white(`${d.tip.toLocaleString()} lam`) +
      chalk.gray("  ·  ") + gradeStr(d.assessment, d.assessment === "healthy" ? 75 : d.assessment === "congested" ? 45 : 20) +
      chalk.gray("  ·  ") + chalk.white(`Confidence: ${d.confidence}`) +
      chalk.gray("  ·  Landing: ") + probColor(`${d.landingProbability}%`)
    ));

    // Reasoning — truncate cleanly
    const reason = d.reasoning.replace(/\n/g, " ").replace(/\[PREFLIGHT OK:[^\]]+\]\s*/g, "");
    const maxLen = W - 6;
    const truncated = reason.length > maxLen ? reason.slice(0, maxLen - 3) + "..." : reason;
    lines.push(row(chalk.italic.gray(`  "${truncated}"`)));
  } else {
    lines.push(row(chalk.gray("  Waiting for first AI decision...")));
    lines.push(row(""));
  }

  lines.push(divider());

  // ── Bundle Pipeline ───────────────────────────────────────
  lines.push(row(chalk.bold("BUNDLE PIPELINE")));

  const recentBundles = state.bundles.slice(-5).reverse();

  if (recentBundles.length === 0) {
    lines.push(row(chalk.gray("  No bundles yet...")));
    for (let i = 0; i < 4; i++) lines.push(row(""));
  } else {
    recentBundles.forEach(b => {
      const seq   = chalk.gray(`#${String(b.sequence).padStart(2, "0")}`);
      const dot   = bundleStatusDot(b.status);
      const pipe  = bundlePipeline(b.status);
      const stage = b.status === "finalized"  ? chalk.greenBright("FINALIZED")
                  : b.status === "confirmed"   ? chalk.green("CONFIRMED")
                  : b.status === "processed"   ? chalk.cyan("PROCESSED")
                  : b.status === "failed"      ? chalk.red("FAILED   ")
                  : b.status === "held"        ? chalk.yellow("HELD     ")
                  : chalk.blue("SUBMITTED");

      const tip = chalk.cyan(`${b.tip.toLocaleString()} lam`);
      const lat = b.latencyMs ? chalk.gray(`${(b.latencyMs / 1000).toFixed(1)}s`) : chalk.gray("···");
      const eff = b.tipEfficiency ? chalk.gray(`${b.tipEfficiency}%eff`) : "";
      const cu  = b.preflight ? chalk.gray(`${b.preflight.toLocaleString()}cu`) : "";

      lines.push(row(
        `  ${seq} ${dot} ${pipe} ${stage}  ${tip}  ${lat}  ${eff}  ${cu}`
      ));
    });

    // Pad to 5 rows
    for (let i = recentBundles.length; i < 5; i++) lines.push(row(""));
  }

  // ── Footer ─────────────────────────────────────────────────
  lines.push(chalk.cyan("╚" + "═".repeat(W) + "╝"));
  lines.push(chalk.gray("  Ctrl+C to stop  ·  KAIROS Transaction Stack  ·  SolInfra Frankfurt"));

  // Render all at once
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(lines.join("\n"));
}

export function startDashboard(): void {
  process.stdout.write("\x1b[?25l"); // hide cursor
}

export function stopDashboard(): void {
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdout.write("\x1b[2J\x1b[H");
}