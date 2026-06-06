import chalk from "chalk";
import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// KAIROS LIVE TERMINAL DASHBOARD
// Updates in-place as the system runs
// ============================================================

export interface DashboardState {
  currentSlot: number;
  streamMode: "real" | "mock";
  streamConnected: boolean;
  networkScore: number;
  networkGrade: string;
  pcDeltaMs: number;
  tipP25: number;
  tipP50: number;
  tipP75: number;
  tipP95: number;
  tipTrend: string;
  lastAiDecision: {
    tip: number;
    assessment: string;
    confidence: string;
    reasoning: string;
  } | null;
  bundles: Array<{
    sequence: number;
    status: string;
    tip: number;
    submittedSlot: number;
    confirmedSlot?: number;
    latencyMs?: number;
  }>;
  totalBundles: number;
  targetBundles: number;
  finalized: number;
  failed: number;
  sessionStartSlot: number;
}

let dashboardActive = false;
let lastRenderTime = 0;
const RENDER_INTERVAL_MS = 500;

// ============================================================
// SCORE COLOR
// ============================================================

function scoreColor(score: number): string {
  if (score >= 80) return chalk.greenBright(`${score}/100`);
  if (score >= 60) return chalk.green(`${score}/100`);
  if (score >= 35) return chalk.yellow(`${score}/100`);
  return chalk.red(`${score}/100`);
}

function gradeColor(grade: string): string {
  if (grade === "excellent") return chalk.greenBright(grade.toUpperCase());
  if (grade === "healthy") return chalk.green(grade.toUpperCase());
  if (grade === "congested") return chalk.yellow(grade.toUpperCase());
  return chalk.red(grade.toUpperCase());
}

function statusColor(status: string): string {
  if (status === "finalized") return chalk.greenBright("✅ FINALIZED");
  if (status === "confirmed") return chalk.green("✓  CONFIRMED");
  if (status === "submitted") return chalk.cyan("⟳  SUBMITTED");
  if (status === "failed") return chalk.red("✗  FAILED");
  return chalk.gray(status.toUpperCase());
}

function trendColor(trend: string): string {
  if (trend === "rising") return chalk.red("↑ rising");
  if (trend === "falling") return chalk.green("↓ falling");
  return chalk.white("→ stable");
}

// ============================================================
// RENDER
// ============================================================

export function renderDashboard(state: DashboardState): void {
  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL_MS) return;
  lastRenderTime = now;

  // Clear screen and move cursor to top
  process.stdout.write("\x1b[2J\x1b[H");

  const width = 70;
  const line = "─".repeat(width);
  const doubleLine = "═".repeat(width);

  // ── Header ──────────────────────────────────────────────
  console.log(chalk.cyan(`╔${doubleLine}╗`));
  console.log(chalk.cyan("║") +
    chalk.bold.white("         KAIROS Transaction Stack") +
    chalk.gray("                          ") +
    chalk.cyan("║"));
  console.log(chalk.cyan("║") +
    chalk.gray("    Right tx. Right slot. Right tip.") +
    chalk.gray("                         ") +
    chalk.cyan("║"));
  console.log(chalk.cyan(`╠${doubleLine}╣`));

  // ── Stream Status ────────────────────────────────────────
  const streamStatus = state.streamConnected
    ? chalk.greenBright("● LIVE")
    : chalk.red("○ DISCONNECTED");

  const modeTag = state.streamMode === "real"
    ? chalk.greenBright("REAL gRPC")
    : chalk.yellow("MOCK");

  console.log(chalk.cyan("║") +
    chalk.gray("  STREAM  ") +
    streamStatus +
    chalk.gray("  Mode: ") + modeTag +
    chalk.gray("  Slot: ") +
    chalk.white(state.currentSlot.toLocaleString()) +
    chalk.gray("".padEnd(Math.max(0, width - 50))) +
    chalk.cyan(" ║"));

  console.log(chalk.cyan(`║${line}║`));

  // ── Three columns: Health | Tips | Progress ──────────────
  const healthLine1 = `  HEALTH SCORE: ${scoreColor(state.networkScore)}`;
  const tipsLine1 = `  TIP ORACLE (LIVE)`;
  const progLine1 = `  RUN PROGRESS`;

  console.log(
    chalk.cyan("║") +
    chalk.bold(healthLine1).padEnd(26) +
    chalk.gray("│") +
    chalk.bold(tipsLine1).padEnd(22) +
    chalk.gray("│") +
    chalk.bold(progLine1).padEnd(22) +
    chalk.cyan("║")
  );

  const healthLine2 = `  ${gradeColor(state.networkGrade)}`;
  const tipsLine2 = `  P25: ${state.tipP25.toLocaleString()} lam`;
  const progLine2 = `  ${state.totalBundles}/${state.targetBundles} submitted`;

  console.log(
    chalk.cyan("║") +
    healthLine2.padEnd(26) +
    chalk.gray("│") +
    chalk.gray(tipsLine2).padEnd(22) +
    chalk.gray("│") +
    chalk.white(progLine2).padEnd(22) +
    chalk.cyan("║")
  );

  const healthLine3 = `  p→c: ${state.pcDeltaMs}ms`;
  const tipsLine3 = `  P50: ${state.tipP50.toLocaleString()} lam`;
  const progLine3 = `  ${state.finalized} finalized`;

  console.log(
    chalk.cyan("║") +
    chalk.gray(healthLine3).padEnd(26) +
    chalk.gray("│") +
    chalk.gray(tipsLine3).padEnd(22) +
    chalk.gray("│") +
    chalk.greenBright(progLine3).padEnd(22) +
    chalk.cyan("║")
  );

  const healthLine4 = `  Slots: ${(state.currentSlot - state.sessionStartSlot).toLocaleString()}`;
  const tipsLine4 = `  P75: ${state.tipP75.toLocaleString()} lam`;
  const progLine4 = `  ${state.failed} failed`;

  console.log(
    chalk.cyan("║") +
    chalk.gray(healthLine4).padEnd(26) +
    chalk.gray("│") +
    chalk.cyan(tipsLine4).padEnd(22) +
    chalk.gray("│") +
    (state.failed > 0 ? chalk.red(progLine4) : chalk.gray(progLine4)).padEnd(22) +
    chalk.cyan("║")
  );

  const tipsLine5 = `  P95: ${state.tipP95.toLocaleString()} lam`;
  const tipsLine6 = `  Trend: ${trendColor(state.tipTrend)}`;

  console.log(
    chalk.cyan("║") +
    "".padEnd(26) +
    chalk.gray("│") +
    chalk.gray(tipsLine5).padEnd(22) +
    chalk.gray("│") +
    "".padEnd(22) +
    chalk.cyan("║")
  );

  console.log(
    chalk.cyan("║") +
    "".padEnd(26) +
    chalk.gray("│") +
    chalk.gray(tipsLine6).padEnd(30) +
    chalk.gray("│") +
    "".padEnd(14) +
    chalk.cyan("║")
  );

  console.log(chalk.cyan(`║${line}║`));

  // ── AI Agent Last Decision ───────────────────────────────
  console.log(chalk.cyan("║") +
    chalk.bold.magenta("  AI AGENT — LAST DECISION") +
    "".padEnd(width - 26) +
    chalk.cyan("║"));

  if (state.lastAiDecision) {
    const d = state.lastAiDecision;
    const tipStr = `  Tip: ${chalk.bold.white(d.tip.toLocaleString() + " lam")}`;
    const assessStr = `  ${gradeColor(d.assessment)}`;
    const confStr = `  Confidence: ${chalk.white(d.confidence)}`;

    console.log(chalk.cyan("║") +
      tipStr.padEnd(24) +
      assessStr.padEnd(24) +
      confStr.padEnd(24) +
      chalk.cyan("║"));

    // Reasoning — truncate to fit
    const maxReasonLen = width - 4;
    const reasoning = d.reasoning.replace(/\n/g, " ").slice(0, maxReasonLen);
    console.log(chalk.cyan("║") +
      chalk.italic.gray(`  "${reasoning}..."`).slice(0, width + 20) +
      chalk.cyan("║"));
  } else {
    console.log(chalk.cyan("║") +
      chalk.gray("  Waiting for first AI decision...").padEnd(width) +
      chalk.cyan("║"));
  }

  console.log(chalk.cyan(`║${line}║`));

  // ── Bundle History ───────────────────────────────────────
  console.log(chalk.cyan("║") +
    chalk.bold("  BUNDLE HISTORY") +
    "".padEnd(width - 16) +
    chalk.cyan("║"));

  const recentBundles = state.bundles.slice(-5).reverse();

  if (recentBundles.length === 0) {
    console.log(chalk.cyan("║") +
      chalk.gray("  No bundles submitted yet...").padEnd(width) +
      chalk.cyan("║"));
  } else {
    recentBundles.forEach(b => {
      const seq = `  #${String(b.sequence).padStart(2, "0")}`;
      const status = statusColor(b.status);
      const slot = chalk.gray(`slot ${b.submittedSlot.toLocaleString()}`);
      const tip = chalk.cyan(`${b.tip.toLocaleString()} lam`);
      const latency = b.latencyMs
        ? chalk.gray(`${(b.latencyMs / 1000).toFixed(1)}s`)
        : chalk.gray("pending");

      const row = `${seq}  ${status}  ${slot}  ${tip}  ${latency}`;
      console.log(chalk.cyan("║") + row.padEnd(width + 30) + chalk.cyan("║"));
    });
  }

  // Pad to 5 rows if fewer bundles
  for (let i = recentBundles.length; i < 5; i++) {
    console.log(chalk.cyan("║") + "".padEnd(width) + chalk.cyan("║"));
  }

  // ── Footer ──────────────────────────────────────────────
  console.log(chalk.cyan(`╚${doubleLine}╝`));
  console.log(chalk.gray("  Press Ctrl+C to stop"));
}

export function startDashboard(): void {
  dashboardActive = true;
  // Hide cursor
  process.stdout.write("\x1b[?25l");
}

export function stopDashboard(): void {
  dashboardActive = false;
  // Show cursor again
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[2J\x1b[H");
}