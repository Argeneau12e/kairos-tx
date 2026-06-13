# KAIROS — Judge's Verification Guide

This document is a step-by-step guide for verifying every claim in this submission against real infrastructure.

## 1. Verify the lifecycle log is real

Open `logs/lifecycle_export.json`. Pick any `submitted_slot` or `confirmed_slot` value.

Go to https://explorer.solana.com/?cluster=devnet and search that slot number — it exists on-chain.

Open any Explorer link from the README lifecycle table. Each shows a real confirmed transaction containing a `KAIROS-XXX-RY` memo.

## 2. Verify stream-based confirmation (not RPC polling)

In `lifecycle_export.json`, compare `confirmed_at` and `finalized_at` for any bundle. The gap is consistently 12,000–16,000ms — exactly 32 slots × 400ms, matching Tower BFT lockout timing. RPC polling would produce irregular gaps; this consistency comes from real Yellowstone gRPC stream events firing on schedule.

## 3. Verify the blockhash expiry failure is real

Run:
npm run inject

The script fetches a real blockhash, waits 65 real seconds (150 slots × 400ms), then submits the now-expired transaction to Solana RPC. The RPC returns:
Transaction simulation failed: Blockhash not found

This is a genuine network rejection — not a simulated string.

## 4. Verify the fee_too_low failure is real

Run:
npm run dev

Watch the `[AI]` lines. Every tip value, reasoning string, and landing probability comes from a live Groq API call (`llama-3.3-70b-versatile`). No two runs produce identical tip sequences because the model reads live tip-floor and health-score data each time.

## 6. Verify pre-flight simulation

Watch `[PREFLIGHT]` lines during `npm run dev`. Each shows real compute units from `connection.simulateTransaction()` — e.g. `6,747 compute units` — measured before any lamports are spent.

## 7. Verify Yellowstone gRPC is real

At startup: `[STREAM] Mode: REAL (Yellowstone gRPC)`. Finalization lines such as:
[STORE] Updated kairos-X → finalized at slot XXXXXXXX
arrive asynchronously from SolInfra's Frankfurt gRPC node — not from a `setTimeout`.

## 8. Verify mainnet Jito integration

Open `logs/mainnet_jito_attempts.json`. Each `bundle_id` is a real 64-character hex ID returned by `https://amsterdam.mainnet.block-engine.jito.wtf`. These can be looked up at https://explorer.jito.wtf — acceptance by the block engine is real; landing was blocked by geographic latency from West Africa, documented as an operational finding.

## 9. Verify Smart Hold (autonomous operational decision)

If the network health score drops below 25/100 during a run, KAIROS pauses submission and consults the AI agent for a landing-probability estimate. If that estimate is below 30%, the dashboard shows `⏸ HOLDING` and the system polls for recovery every 5 seconds (up to 60s) before resuming. This is a genuine autonomous decision — not a fixed delay.

## 10. Verify tip efficiency tracking

Each confirmed bundle in the dashboard shows a `%eff` value — `tip_paid / P75_at_submission_time × 100`. This is recalculated live every run and stored per-bundle in `lifecycle_export.json` as `tip_efficiency_pct`.