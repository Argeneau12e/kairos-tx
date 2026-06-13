# KAIROS — Judge's Verification Guide

This document guides you through verifying every claim in the submission.

## Step 1 — Verify lifecycle logs are real

Open logs/lifecycle_export.json. Take any submitted_slot value.
Go to: https://explorer.solana.com/?cluster=devnet
Paste the slot number. You will see the block was produced at that time.

Take any Explorer link from the lifecycle table in README.
Open it. You will see a real confirmed transaction with the KAIROS memo.

## Step 2 — Verify stream-based confirmations (not RPC polling)

Look at the finalized_at timestamps in lifecycle_export.json.
Compare to confirmed_at. The gap is 12,000–16,000ms — exactly 32 slots × 400ms.
This timing matches Tower BFT lockout, not an RPC poll interval.
RPC polling would show irregular timing. Stream events are consistent.

## Step 3 — Verify the blockhash expiry failure is real

Run: npm run inject
Wait 65 seconds. The system submits an expired transaction to Solana RPC.
Real error returned: "Transaction simulation failed: Blockhash not found"
This is a real Solana network rejection, not a simulated error.

## Step 4 — Verify the fee_too_low failure is real

Run: npm run inject:lowtip
The system submits a 100 lamport bundle to mainnet Jito block engine.
Real rejection from Jito: "transaction #0 could not be decoded"
This is a real Jito network rejection from mainnet infrastructure.

## Step 5 — Verify the AI agent makes real decisions

Run: npm run dev
Watch the [AI] lines. Each tip amount comes from a Groq API call.
The reasoning field explains the decision in natural language.
No two runs produce identical tip sequences — the AI reads live data.

## Step 6 — Verify pre-flight simulation

Watch [PREFLIGHT] lines during npm run dev.
Each shows compute units consumed by simulation.
This is a real simulateTransaction() call before any lamports are spent.

## Step 7 — Verify Yellowstone gRPC is real

Watch startup: [STREAM] Mode: REAL (Yellowstone gRPC)
Watch finalization events: [STORE] Updated kairos-X → finalized at slot XXXXXX
These events come from SolInfra Frankfurt gRPC node, not from a timer.