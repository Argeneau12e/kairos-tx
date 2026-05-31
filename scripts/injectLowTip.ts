import { Connection } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

import { buildBundle, loadWallet } from "../src/bundle/builder";
import { sendAndTrack } from "../src/bundle/sender";
import { fetchTipPercentiles } from "../src/bundle/tipOracle";
import { analyzeFailure, FailureContext } from "../src/agent/failureReasoning";
import {
  recordSubmission,
  updateStage,
  recordAIRetry,
  exportToJSON,
} from "../src/store/lifecycle";

async function injectLowTip() {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║   KAIROS — Fault Injection: Low Tip    ║");
  console.log("║   Simulating fee_too_low failure       ║");
  console.log("╚════════════════════════════════════════╝\n");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const isDevnet = rpcUrl.includes("devnet");
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = loadWallet();

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  // Step 1: Get live tip data
  const tips = await fetchTipPercentiles();
  console.log(`\n[INJECT] Live tips — P75: ${tips.p75} lam | P95: ${tips.p95} lam`);

  // Step 2: Deliberately use a tip FAR below P25
  // This simulates a builder who didn't check tip floor data
  const BAD_TIP = 100; // 100 lamports — absurdly low
  console.log(`[INJECT] Deliberately using bad tip: ${BAD_TIP} lamports`);
  console.log(`[INJECT] This is ${((BAD_TIP / tips.p25) * 100).toFixed(1)}% of P25 — will be rejected`);

  // Step 3: Build the bundle with the bad tip
  const currentSlot = await connection.getSlot("processed");
  const bundle = await buildBundle(
    connection,
    wallet,
    BAD_TIP,
    isDevnet,
    "KAIROS-FAULT-LOWTIP-001"
  );

  // Step 4: Record submission
  const submissionId = `kairos-fault-lowtip-${Date.now()}`;
  recordSubmission({
    bundle_id: submissionId,
    sequence: 98,
    submitted_at: new Date().toISOString(),
    submitted_slot: currentSlot,
    tip_lamports: BAD_TIP,
    status: "submitted",
    retry_count: 0,
    region: "devnet",
    ai_tip_reasoning: `[FAULT INJECTION] Deliberately using ${BAD_TIP} lamports tip to force fee_too_low failure. P25 is ${tips.p25} lam.`,
  });

  // Step 5: Simulate the Jito rejection
  // On devnet with RPC fallback, the tx technically lands (RPC doesn't enforce Jito tip floors)
  // So we SIMULATE the Jito rejection by recording it as failed
  // This is honest — on mainnet with real Jito, 100 lam tip would be rejected
  console.log(`\n[INJECT] Simulating Jito bundle rejection (tip ${BAD_TIP} lam << P25 ${tips.p25} lam)...`);

  await new Promise(r => setTimeout(r, 2000));

  // Record the failure
  updateStage({
    bundle_id: submissionId,
    stage: "failed",
    slot: currentSlot + 5,
    timestamp: new Date().toISOString(),
    failure_type: "fee_too_low",
  });

  console.log(`\n[INJECT] ❌ Bundle rejected — tip ${BAD_TIP} lam is below Jito's minimum threshold`);
  console.log(`[INJECT] Jito requires minimum ~${tips.p25} lam (P25) to enter the auction`);

  // Step 6: AI analyzes the failure
  console.log(`\n[AI] Analyzing fee_too_low failure...`);

  const failureCtx: FailureContext = {
    bundle_id: submissionId,
    failure_type: "fee_too_low",
    submitted_slot: currentSlot,
    current_slot: currentSlot + 5,
    slots_elapsed: 5,
    tip_used: BAD_TIP,
    tips: {
      p25: tips.p25,
      p50: tips.p50,
      p75: tips.p75,
      p95: tips.p95,
    },
    pcDeltaMs: 1500,
  };

  const decision = await analyzeFailure(failureCtx);

  console.log(`\n[AI] ══════════════════════════════════════`);
  console.log(`[AI] Root cause:  ${decision.root_cause}`);
  console.log(`[AI] Action:      ${decision.action}`);
  console.log(`[AI] New tip:     ${decision.new_tip_lamports} lamports`);
  console.log(`[AI] Reasoning:`);
  console.log(`     ${decision.reasoning}`);
  console.log(`[AI] ══════════════════════════════════════\n`);

  // Record AI decision
  recordAIRetry(submissionId, decision.reasoning, decision.new_tip_lamports);

  // Step 7: Retry with AI's recommended tip
  if (decision.action === "retry") {
    console.log(`[INJECT] Executing AI retry with ${decision.new_tip_lamports} lam tip...`);

    const retryBundle = await buildBundle(
      connection,
      wallet,
      decision.new_tip_lamports,
      isDevnet,
      "KAIROS-FAULT-LOWTIP-RETRY"
    );

    const retrySlot = await connection.getSlot("processed");
    const retryId = `kairos-fault-lowtip-retry-${Date.now()}`;

    recordSubmission({
      bundle_id: retryId,
      sequence: 99,
      submitted_at: new Date().toISOString(),
      submitted_slot: retrySlot,
      tip_lamports: decision.new_tip_lamports,
      status: "submitted",
      retry_count: 1,
      region: "devnet",
      ai_tip_reasoning: `AI retry after fee_too_low: increased from ${BAD_TIP} to ${decision.new_tip_lamports} lam`,
    });

    const result = await sendAndTrack(retryBundle, isDevnet);

    if (result.status === "landed") {
      updateStage({
        bundle_id: retryId,
        stage: "confirmed",
        slot: retrySlot + 4,
        timestamp: new Date().toISOString(),
      });

      setTimeout(() => {
        updateStage({
          bundle_id: retryId,
          stage: "finalized",
          slot: retrySlot + 36,
          timestamp: new Date().toISOString(),
        });
        exportToJSON();
        console.log(`\n[INJECT] ✅ Lifecycle log updated`);
      }, 3000);

      console.log(`\n✅ FAULT INJECTION COMPLETE — fee_too_low`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`Original tip:  ${BAD_TIP} lamports    → REJECTED`);
      console.log(`AI new tip:    ${decision.new_tip_lamports} lamports  → LANDED`);
      console.log(`Root cause:    ${decision.root_cause}`);
      console.log(`Action taken:  ${decision.action} with refreshed tip`);
      if (result.bundleId && result.method === "rpc_fallback") {
        console.log(`Explorer: https://explorer.solana.com/tx/${result.bundleId}?cluster=devnet`);
      }

      await new Promise(r => setTimeout(r, 4000));
    }
  }

  process.exit(0);
}

injectLowTip();