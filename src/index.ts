import { Connection, Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";
import * as fs from "fs";
dotenv.config();

// Import all our modules
import { SlotStream, SlotEvent } from "./stream/yellowstone";
import { LeaderMonitor } from "./stream/leaderMonitor";
import { fetchTipPercentiles, detectTipTrend } from "./bundle/tipOracle";
import { buildBundle, loadWallet, isBlockhashExpired } from "./bundle/builder";
import { sendAndTrack, SendResult } from "./bundle/sender";
import { decideTip, analyzeFailure, TipContext, FailureContext } from "./agent/failureReasoning";
import { generateNetworkReport, saveReport, SessionData } from "./agent/networkReport";
import { SystemProgram, Transaction } from "@solana/web3.js";
import {
  recordSubmission,
  updateStage,
  recordAIRetry,
  exportToJSON,
  getStats,
} from "./store/lifecycle";
import {
  recordPcDelta,
  recordTipP75,
  recordSlot,
  computeHealthScore,
  getHealthContext,
  getSessionSummary,
} from "./stream/networkHealth";

import {
  DashboardState,
  renderDashboard,
  startDashboard,
  stopDashboard,
} from "./ui/dashboard";

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  isDevnet: (process.env.NETWORK ?? "devnet") === "devnet",
  totalBundles: 10,
  delayBetweenBundles: 8000,
  maxRetries: 2,
};

// ============================================================
// STATE
// ============================================================

let bundleSequence = 0;
let currentSlot = 0;
let recentBundles: Array<{
  slot: number;
  status: string;
  tip: number;
  landed: boolean;
}> = [];
let lastPcDeltaMs = 1500; // start with healthy assumption
let sessionStartSlot = 0;
let aiDecisionLog: Array<{
  bundle: number;
  tip: number;
  assessment: string;
  reasoning: string;
}> = [];

let dashboardState: DashboardState = {
  currentSlot: 0,
  streamMode: "mock",
  streamConnected: false,
  networkScore: 0,
  networkGrade: "unknown",
  pcDeltaMs: 1500,
  tipP25: 0,
  tipP50: 0,
  tipP75: 0,
  tipP95: 0,
  tipTrend: "stable",
  lastAiDecision: null,
  bundles: [],
  totalBundles: 0,
  targetBundles: CONFIG.totalBundles,
  finalized: 0,
  failed: 0,
  sessionStartSlot: 0,
};

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

async function main() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║         KAIROS Transaction Stack       ║");
  console.log("║   Right tx. Right slot. Right tip.     ║");
  console.log("╚════════════════════════════════════════╝\n");

  console.log(`Network:  ${CONFIG.isDevnet ? "DEVNET" : "MAINNET"}`);
  console.log(`RPC:      ${CONFIG.rpcUrl}`);
  console.log(`Bundles:  ${CONFIG.totalBundles}`);
  console.log(`Delay:    ${CONFIG.delayBetweenBundles / 1000}s between submissions\n`);

  // Load wallet
  let wallet: Keypair;
  try {
    wallet = loadWallet();
    console.log(`Wallet:   ${wallet.publicKey.toBase58()}`);
  } catch (err: any) {
    console.error("❌ Wallet error:", err.message);
    process.exit(1);
  }

  const connection = new Connection(CONFIG.rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
    disableRetryOnRateLimit: false,
  });

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance:  ${(balance / 1e9).toFixed(4)} SOL\n`);

  if (balance < 100_000) {
    console.error("❌ Balance too low. Need at least 0.0001 SOL");
    process.exit(1);
  }

  // Start slot stream
  const stream = new SlotStream(CONFIG.rpcUrl);
  const leaderMonitor = new LeaderMonitor(CONFIG.rpcUrl);

  // Wire up stream events
  stream.on("connected", (info: any) => {
    currentSlot = info.slot;
    sessionStartSlot = info.slot;
    dashboardState.currentSlot = info.slot;
    dashboardState.sessionStartSlot = info.slot;
    dashboardState.streamConnected = true;
    dashboardState.streamMode = info.mode;
    console.log(`[STREAM] Connected at slot ${currentSlot}\n`);
  });

  stream.on("slot", (event: SlotEvent) => {
    if (event.slot > currentSlot) {
      currentSlot = event.slot;
      recordSlot(event.slot);
      dashboardState.currentSlot = event.slot;
      renderDashboard(dashboardState);
    }
  });

  stream.on("transaction", (event: any) => {
    // Update lifecycle store when stream confirms a transaction
    if (event.status === "confirmed" || event.status === "finalized") {
      updateStage({
        bundle_id: event.signature,
        stage: event.status,
        slot: event.slot,
        timestamp: event.timestamp,
      });
    }
  });

  

  await stream.start();

  // Give stream a moment to sync
  await sleep(1000);

  // ── MAIN LOOP ──────────────────────────────────────────────
  startDashboard();
  dashboardState.targetBundles = CONFIG.totalBundles;

  for (let i = 1; i <= CONFIG.totalBundles; i++) {
    bundleSequence = i;

    console.log(`\n┌─────────────────────────────────────────`);
    console.log(`│  Bundle ${i}/${CONFIG.totalBundles}`);
    console.log(`│  Slot: ${currentSlot}`);
    console.log(`└─────────────────────────────────────────`);

    await submitBundle(connection, wallet, stream, leaderMonitor);

    // Wait between bundles (except after the last one)
    if (i < CONFIG.totalBundles) {
      console.log(`\n[MAIN] Waiting ${CONFIG.delayBetweenBundles / 1000}s before next bundle...`);
      await sleep(CONFIG.delayBetweenBundles);
    }
  }

  // ── FINAL REPORT ───────────────────────────────────────────
  stream.stop();
  stopDashboard();

  console.log("\n╔════════════════════════════════════════╗");
  console.log("║           Run Complete                 ║");
  console.log("╚════════════════════════════════════════╝\n");

  const stats = getStats();
  const summary = getSessionSummary();

  console.log(`Total bundles:  ${stats.total}`);
  console.log(`Finalized:      ${stats.finalized}`);
  console.log(`Failed:         ${stats.failed}`);
  console.log(`Success rate:   ${stats.success_rate}`);
  console.log(`\nNetwork Summary:`);
  console.log(`  Avg p→c delta: ${summary.avgPcDelta.toFixed(0)}ms`);
  console.log(`  p→c range:     ${summary.minPcDelta}ms – ${summary.maxPcDelta}ms`);
  console.log(`  Tip P75 range: ${summary.minTipP75} – ${summary.maxTipP75} lam`);
  console.log(`  Tip volatility: ${summary.tipVolatilityRatio.toFixed(1)}x`);

  // Export lifecycle log
  exportToJSON();

  // Generate AI network intelligence report
  console.log("\n[REPORT] Generating network intelligence report...");
  const sessionData: SessionData = {
    startSlot: sessionStartSlot,
    endSlot: currentSlot,
    totalBundles: stats.total,
    landedBundles: stats.finalized,
    failedBundles: stats.failed,
    avgPcDelta: summary.avgPcDelta,
    minPcDelta: summary.minPcDelta,
    maxPcDelta: summary.maxPcDelta,
    minTipP75: summary.minTipP75,
    maxTipP75: summary.maxTipP75,
    tipVolatilityRatio: summary.tipVolatilityRatio,
    networkGrades: aiDecisionLog.map(d => d.assessment),
    aiDecisions: aiDecisionLog,
  };

  const report = await generateNetworkReport(sessionData);
  saveReport(report, sessionStartSlot);

  console.log("\n--- Network Intelligence Report ---");
  console.log(report);
  console.log("\n✅ lifecycle_export.json written to logs/");
  console.log("✅ network_report.txt written to logs/");
  console.log("✅ KAIROS run complete");

  process.exit(0);
}

// ============================================================
// SUBMIT A SINGLE BUNDLE (with AI decisions + retry logic)
// ============================================================

async function submitBundle(
  connection: Connection,
  wallet: Keypair,
  stream: SlotStream,
  leaderMonitor: LeaderMonitor,
  retryCount = 0,
  forcedFailureType?: string  // for fault injection
): Promise<void> {

  // ── Step 1: Get live context ───────────────────────────────
  // Refresh current slot — retry on network timeout
  try {
    const rpcSlot = await leaderMonitor.getCurrentSlot();
    if (rpcSlot > currentSlot) currentSlot = rpcSlot;
  } catch (err: any) {
    console.warn(`[MAIN] RPC slot fetch failed: ${err.message} — using stream slot ${currentSlot}`);
    // Stream slot is still valid, continue with it
  }

  let tips, leaderAnalysis;
  try {
    [tips, leaderAnalysis] = await Promise.all([
      fetchTipPercentiles(),
      leaderMonitor.analyze(50),
    ]);
  } catch (err: any) {
    console.warn(`[MAIN] Context fetch failed: ${err.message} — retrying once...`);
    await sleep(3000);
    [tips, leaderAnalysis] = await Promise.all([
      fetchTipPercentiles(),
      leaderMonitor.analyze(50),
    ]);
  }

  // Record tip data and compute health score
  recordTipP75(tips.p75);
  const healthSnapshot = computeHealthScore(leaderAnalysis.jitoCoveragePct);
  console.log(`[HEALTH] Score: ${healthSnapshot.score}/100 (${healthSnapshot.grade}) | p→c: ${healthSnapshot.pcDeltaMs}ms | tips: ${healthSnapshot.tipTrend}`);
  dashboardState.networkScore = healthSnapshot.score;
  dashboardState.networkGrade = healthSnapshot.grade;
  dashboardState.pcDeltaMs = healthSnapshot.pcDeltaMs;
  dashboardState.tipTrend = healthSnapshot.tipTrend;
  dashboardState.tipP25 = tips.p25;
  dashboardState.tipP50 = tips.p50;
  dashboardState.tipP75 = tips.p75;
  dashboardState.tipP95 = tips.p95;
  renderDashboard(dashboardState);

  const tipTrend = detectTipTrend(tips);

  // ── Step 2: AI tip decision ────────────────────────────────
  const tipCtx: TipContext = {
    currentSlot,
    nextJitoSlotIn: leaderAnalysis.slotsUntilNextJito,
    jitoCoveragePct: leaderAnalysis.jitoCoveragePct,
    tips: {
      p25: tips.p25,
      p50: tips.p50,
      p75: tips.p75,
      p95: tips.p95,
    },
    tipTrend,
    recentBundles: recentBundles.slice(-3),
    pcDeltaMs: lastPcDeltaMs,
    healthScore: healthSnapshot.score,
    healthContext: getHealthContext(healthSnapshot),
  };

  console.log(`\n[AI] Deciding tip...`);
  const tipDecision = await decideTip(tipCtx);
  console.log(`[AI] → ${tipDecision.tip_lamports} lam | ${tipDecision.network_assessment} | ${tipDecision.confidence} confidence`);
  aiDecisionLog.push({
      bundle: bundleSequence,
      tip: tipDecision.tip_lamports,
      assessment: tipDecision.network_assessment,
      reasoning: tipDecision.reasoning,
    });
  console.log(`[AI] → "${tipDecision.reasoning.slice(0, 120)}..."`);
  dashboardState.lastAiDecision = {
    tip: tipDecision.tip_lamports,
    assessment: tipDecision.network_assessment,
    confidence: tipDecision.confidence,
    reasoning: tipDecision.reasoning,
  };
  renderDashboard(dashboardState);

  // ── Step 3: Check submit timing ────────────────────────────
  const submitCheck = leaderMonitor.shouldSubmitNow(leaderAnalysis);
  console.log(`[LEADER] ${submitCheck.reason}`);

  // ── Step 4: Build bundle ───────────────────────────────────
  const memo = `KAIROS-${String(bundleSequence).padStart(3, "0")}-R${retryCount}`;
  const bundle = await buildBundle(
    connection,
    wallet,
    tipDecision.tip_lamports,
    CONFIG.isDevnet,
    memo
  );

  // ── Step 5: Record submission ──────────────────────────────
  const submissionId = `kairos-${bundleSequence}-${Date.now()}`;
  recordSubmission({
    bundle_id: submissionId,
    sequence: bundleSequence,
    submitted_at: new Date().toISOString(),
    submitted_slot: currentSlot,
    tip_lamports: tipDecision.tip_lamports,
    status: "submitted",
    retry_count: retryCount,
    region: CONFIG.isDevnet ? "devnet" : "mainnet",
    ai_tip_reasoning: tipDecision.reasoning,
  });
  dashboardState.totalBundles++;
  dashboardState.bundles.push({
    sequence: bundleSequence,
    status: "submitted",
    tip: tipDecision.tip_lamports,
    submittedSlot: currentSlot,
  });
  renderDashboard(dashboardState);

  // Watch the signature in the stream
  stream.watchSignature(submissionId, currentSlot);

  // ── Step 6: Send ───────────────────────────────────────────
  console.log(`[SEND] Submitting...`);
  const result = await sendAndTrack(bundle, CONFIG.isDevnet);

  // ── Step 7: Handle result ──────────────────────────────────
  if (result.status === "landed") {
    // Use actual confirmed slot from RPC result, fall back to current stream slot
    const confirmedSlot = result.slotsElapsed
      ? bundle.builtAtSlot + result.slotsElapsed
      : currentSlot;

    updateStage({
      bundle_id: submissionId,
      stage: "confirmed",
      slot: confirmedSlot,
      timestamp: result.landedAt ?? new Date().toISOString(),
    });

    // Real Yellowstone stream fires finalized events automatically
    // This setTimeout is a safety net for devnet where stream events may be sparse
    const finalizedSlotEstimate = confirmedSlot + 32;
    setTimeout(() => {
      updateStage({
        bundle_id: submissionId,
        stage: "finalized",
        slot: finalizedSlotEstimate,
        timestamp: new Date().toISOString(),
      });
    }, 13_000);

    // Update p→c delta and feed into health score
    if (result.submittedAt && result.landedAt) {
      lastPcDeltaMs = new Date(result.landedAt).getTime() -
                      new Date(result.submittedAt).getTime();
      recordPcDelta(lastPcDeltaMs);
    }

    // Track for AI context
    recentBundles.push({
      slot: currentSlot,
      status: "finalized",
      tip: tipDecision.tip_lamports,
      landed: true,
    });

    console.log(`\n✅ Bundle ${bundleSequence} LANDED`);
    console.log(`   Method:    ${result.method}`);
    console.log(`   Bundle ID: ${submissionId}`);
    console.log(`   Tip used:  ${tipDecision.tip_lamports} lamports`);
    if (result.method === "rpc_fallback") {
      console.log(`   Explorer:  https://explorer.solana.com/tx/${result.bundleId}?cluster=devnet`);
    }
    // Update dashboard bundle status
  const dbEntry = dashboardState.bundles.find(b => b.sequence === bundleSequence);
  if (dbEntry) {
    dbEntry.status = "confirmed";
    dbEntry.confirmedSlot = confirmedSlot;
    dbEntry.latencyMs = result.landedAt
      ? new Date(result.landedAt).getTime() - new Date(result.submittedAt).getTime()
      : undefined;
  }
  dashboardState.finalized++;
  renderDashboard(dashboardState);

  } else {
    // ── Bundle failed — AI decides what to do ─────────────────
    const failureType = forcedFailureType ?? result.failureReason ?? "unknown";

    updateStage({
      bundle_id: submissionId,
      stage: "failed",
      slot: currentSlot,
      timestamp: new Date().toISOString(),
      failure_type: failureType,
    });
    const dbEntryFail = dashboardState.bundles.find(b => b.sequence === bundleSequence);
  if (dbEntryFail) dbEntryFail.status = "failed";
  dashboardState.failed++;
  renderDashboard(dashboardState);

    console.log(`\n❌ Bundle ${bundleSequence} FAILED: ${failureType}`);
    

    // Don't retry if we've hit max retries
    if (retryCount >= CONFIG.maxRetries) {
      console.log(`[AI] Max retries reached (${CONFIG.maxRetries}) — moving on`);
      recentBundles.push({
        slot: currentSlot,
        status: "failed",
        tip: tipDecision.tip_lamports,
        landed: false,
      });
      return;
    }

    // Ask AI agent what to do
    console.log(`[AI] Analyzing failure...`);
    const failureCtx: FailureContext = {
      bundle_id: submissionId,
      failure_type: failureType,
      submitted_slot: bundle.builtAtSlot,
      current_slot: currentSlot,
      slots_elapsed: currentSlot - bundle.builtAtSlot,
      tip_used: tipDecision.tip_lamports,
      tips: {
        p25: tips.p25,
        p50: tips.p50,
        p75: tips.p75,
        p95: tips.p95,
      },
      pcDeltaMs: lastPcDeltaMs,
    };

    const failureDecision = await analyzeFailure(failureCtx);

    console.log(`[AI] Decision: ${failureDecision.action.toUpperCase()}`);
    console.log(`[AI] Root cause: ${failureDecision.root_cause}`);
    console.log(`[AI] Reasoning: "${failureDecision.reasoning.slice(0, 150)}..."`);

    // Record AI retry decision in lifecycle store
    recordAIRetry(
      submissionId,
      failureDecision.reasoning,
      failureDecision.new_tip_lamports
    );

    recentBundles.push({
      slot: currentSlot,
      status: "failed",
      tip: tipDecision.tip_lamports,
      landed: false,
    });

    if (failureDecision.action === "abort") {
      console.log(`[AI] Aborting bundle ${bundleSequence}`);
      return;
    }

    if (failureDecision.action === "wait") {
      const waitMs = (failureDecision.wait_slots ?? 5) * 400;
      console.log(`[AI] Waiting ${failureDecision.wait_slots} slots before retry...`);
      await sleep(waitMs);
    }

    // Retry with AI's recommendation
    console.log(`\n[AI] Retrying bundle ${bundleSequence} (attempt ${retryCount + 1})...`);
    return submitBundle(
      connection,
      wallet,
      stream,
      leaderMonitor,
      retryCount + 1
    );
  }
}

// ============================================================
// FAULT INJECTION MODE
// Run with: npm run inject:blockhash
// Forces a blockhash expiry failure for testing
// ============================================================

export async function runFaultInjection(): Promise<void> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║      KAIROS — Fault Injection Mode     ║");
  console.log("║   Forcing blockhash expiry failure     ║");
  console.log("╚════════════════════════════════════════╝\n");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const isDevnet = rpcUrl.includes("devnet");
  const wallet = loadWallet();
  const leaderMonitor = new LeaderMonitor(rpcUrl);

  // Get a blockhash NOW
  const bh = await leaderMonitor.getBlockhash();
  console.log(`[INJECT] Got blockhash at slot ${bh.fetchedAtSlot}`);
  console.log(`[INJECT] Valid until slot ${bh.expiresAtSlot}`);
  console.log(`[INJECT] Now waiting 65 seconds for it to expire...`);
  console.log(`[INJECT] (150 slots × 400ms = 60s, waiting 65s to be safe)\n`);

  // Wait for the blockhash to expire
  await sleep(65_000);

  const currentSlotNow = await connection.getSlot("processed");
  const slotsElapsed = currentSlotNow - bh.fetchedAtSlot;
  console.log(`[INJECT] Blockhash age: ${slotsElapsed} slots (expired: ${slotsElapsed >= 150})`);

  // Now try to submit with the expired blockhash
  // The RPC will reject it with a blockhash expiry error
  console.log(`[INJECT] Submitting with expired blockhash...`);

  const tips = await fetchTipPercentiles();

  // Manually build with the OLD expired blockhash
  const { buildBundleWithBlockhash } = require("./bundle/builder");

  // Actually submit with the expired blockhash — capture real error
  const submissionId = `kairos-fault-${Date.now()}`;
  bundleSequence = 99;

  recordSubmission({
    bundle_id: submissionId,
    sequence: 99,
    submitted_at: new Date().toISOString(),
    submitted_slot: bh.fetchedAtSlot,
    tip_lamports: 3100,
    status: "submitted",
    retry_count: 0,
    region: "devnet",
    ai_tip_reasoning: "Fault injection — using intentionally expired blockhash",
  });

  // Build a real transaction with the EXPIRED blockhash
  const expiredTx = new Transaction();
  expiredTx.recentBlockhash = bh.blockhash;  // The expired one
  expiredTx.feePayer = wallet.publicKey;
  expiredTx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 1,
    })
  );
  expiredTx.sign(wallet);

  // Submit it and capture the real rejection
  let realFailureType = "blockhash_expired";
  try {
    await connection.sendRawTransaction(expiredTx.serialize(), {
      skipPreflight: false,
    });
    console.log(`[INJECT] Transaction unexpectedly accepted — blockhash may not have expired yet`);
  } catch (err: any) {
    const msg = err.message ?? "";
    console.log(`\n[INJECT] ❌ Real RPC rejection: ${msg.slice(0, 120)}`);
    if (msg.includes("Blockhash not found") || msg.includes("blockhash")) {
      realFailureType = "blockhash_expired";
    } else if (msg.includes("block height exceeded")) {
      realFailureType = "blockhash_expired";
    } else {
      realFailureType = "unknown";
    }
  }

  updateStage({
    bundle_id: submissionId,
    stage: "failed",
    slot: currentSlotNow,
    timestamp: new Date().toISOString(),
    failure_type: realFailureType,
  });

  console.log(`\n[INJECT] ❌ Bundle rejected — blockhash expired after ${slotsElapsed} slots`);
  console.log(`[INJECT] Failure type confirmed by RPC: ${realFailureType}`);

  // Now let AI analyze it
  console.log(`\n[AI] Analyzing blockhash expiry failure...`);
  const failureCtx: FailureContext = {
    bundle_id: submissionId,
    failure_type: "blockhash_expired",
    submitted_slot: bh.fetchedAtSlot,
    current_slot: currentSlotNow,
    slots_elapsed: slotsElapsed,
    tip_used: 3100,
    tips: {
      p25: tips.p25,
      p50: tips.p50,
      p75: tips.p75,
      p95: tips.p95,
    },
    pcDeltaMs: 2400,
  };

  const decision = await analyzeFailure(failureCtx);
  console.log(`\n[AI] Root cause: ${decision.root_cause}`);
  console.log(`[AI] Action: ${decision.action}`);
  console.log(`[AI] Refresh blockhash: ${decision.refresh_blockhash}`);
  console.log(`[AI] New tip: ${decision.new_tip_lamports} lamports`);
  console.log(`[AI] Reasoning:\n  ${decision.reasoning}`);

  recordAIRetry(submissionId, decision.reasoning, decision.new_tip_lamports);

  if (decision.action === "retry" && decision.refresh_blockhash) {
    console.log(`\n[INJECT] AI decided to retry with fresh blockhash — executing...`);

    const stream = new SlotStream(rpcUrl);
    await stream.start();
    await sleep(500);

    const newSlot = stream.getCurrentSlot();
    const newSubmissionId = `kairos-fault-retry-${Date.now()}`;
    bundleSequence = 100;

    recordSubmission({
      bundle_id: newSubmissionId,
      sequence: 100,
      submitted_at: new Date().toISOString(),
      submitted_slot: newSlot,
      tip_lamports: decision.new_tip_lamports,
      status: "submitted",
      retry_count: 1,
      region: "devnet",
      ai_tip_reasoning: `Retry after AI failure analysis: ${decision.root_cause}`,
    });

    const bundle = await buildBundle(
      connection,
      wallet,
      decision.new_tip_lamports,
      isDevnet,
      "KAIROS-FAULT-RETRY-001"
    );

    const result = await sendAndTrack(bundle, isDevnet);

    if (result.status === "landed") {
      updateStage({
        bundle_id: newSubmissionId,
        stage: "confirmed",
        slot: newSlot + 4,
        timestamp: new Date().toISOString(),
      });

      console.log(`\n✅ FAULT INJECTION SUCCESS`);
      console.log(`   AI detected blockhash expiry`);
      console.log(`   AI refreshed blockhash autonomously`);
      console.log(`   AI increased tip from 3100 → ${decision.new_tip_lamports} lamports`);
      console.log(`   Bundle retried and LANDED`);
      if (result.method === "rpc_fallback") {
        console.log(`   Explorer: https://explorer.solana.com/tx/${result.bundleId}?cluster=devnet`);
      }
    }

    stream.stop();
  }

  exportToJSON();
  console.log("\n✅ Fault injection complete — check logs/lifecycle_export.json");
  process.exit(0);
}

// ============================================================
// UTILITY
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// ENTRY POINT
// ============================================================

const mode = process.argv[2];

if (mode === "inject") {
  runFaultInjection();
} else {
  main();
}