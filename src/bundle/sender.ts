import { Connection, Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";
import { BuiltBundle } from "./builder";
import bs58 from "bs58";
dotenv.config();

// ============================================================
// TYPES
// ============================================================

export interface SendResult {
  bundleId: string;
  status: "submitted" | "landed" | "failed" | "timeout";
  submittedAt: string;
  landedAt?: string;
  failureReason?: string;
  slotsElapsed?: number;
  method: "jito_bundle" | "rpc_fallback";
}

// ============================================================
// JITO ENDPOINTS
// ============================================================

const JITO_ENDPOINTS = {
  devnet:  "https://devnet.block-engine.jito.wtf",
  mainnet: [
    "https://mainnet.block-engine.jito.wtf",
    "https://amsterdam.mainnet.block-engine.jito.wtf",
    "https://frankfurt.mainnet.block-engine.jito.wtf",
    "https://ny.mainnet.block-engine.jito.wtf",
    "https://tokyo.mainnet.block-engine.jito.wtf",
  ],
};



// ============================================================
// CHECK IF JITO ENDPOINT IS REACHABLE
// ============================================================

async function isJitoReachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTipAccounts",
        params: [],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || response.status === 400; // 400 = reached but bad request = reachable
  } catch {
    return false;
  }
}

// ============================================================
// SEND BUNDLE TO JITO
// ============================================================

export async function sendBundle(
  bundle: BuiltBundle,
  isDevnet: boolean
): Promise<SendResult> {
  const endpoint = isDevnet
    ? JITO_ENDPOINTS.devnet
    : JITO_ENDPOINTS.mainnet[0];

  const submittedAt = new Date().toISOString();

  // Check if Jito is reachable first
  console.log(`[SENDER] Checking Jito endpoint: ${endpoint}`);
  const reachable = await isJitoReachable(endpoint);

  if (!reachable) {
    console.warn(`[SENDER] ⚠️  Jito block engine unreachable at ${endpoint}`);
    console.warn(`[SENDER] This is common on devnet — falling back to RPC submission`);

    // Fall back to regular RPC submission
    return sendViaRpc(bundle, isDevnet, submittedAt);
  }

  console.log(`[SENDER] ✅ Jito reachable — submitting bundle`);
  console.log(`[SENDER] Transactions: ${bundle.transactions.length}`);
  console.log(`[SENDER] Tip: ${bundle.tipLamports} lamports`);

  try {
    const txBase58 = bundle.transactions.map(tx =>
      bs58.encode(Buffer.from(tx.serialized, "base64"))
    );

    const response = await fetch(`${endpoint}/api/v1/bundles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [txBase58],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json() as any;

    if (data.error) {
      console.error(`[SENDER] Jito rejected bundle: ${data.error.message}`);

      // Classify the failure type for the AI agent
      const failureType = classifyJitoError(data.error.message);
      return {
        bundleId: "jito_error",
        status: "failed",
        submittedAt,
        failureReason: failureType,
        method: "jito_bundle",
      };
    }

    const bundleId = data.result as string;
    console.log(`[SENDER] ✅ Bundle accepted! ID: ${bundleId}`);

    return {
      bundleId,
      status: "submitted",
      submittedAt,
      method: "jito_bundle",
    };

  } catch (err: any) {
    console.error(`[SENDER] Submit error: ${err.message}`);
    return {
      bundleId: "network_error",
      status: "failed",
      submittedAt,
      failureReason: err.message,
      method: "jito_bundle",
    };
  }
}

// ============================================================
// RPC FALLBACK
// When Jito devnet is down, send via regular Solana RPC
// The transaction still goes on-chain — just not as a bundle
// For devnet testing purposes this proves the tx mechanism works
// ============================================================

async function sendViaRpc(
  bundle: BuiltBundle,
  isDevnet: boolean,
  submittedAt: string
): Promise<SendResult> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`[SENDER] RPC fallback — sending both transactions`);

  try {
    // Send BOTH transactions — payload first, then tip
    const results: string[] = [];

    for (const tx of bundle.transactions) {
      const txBuffer = Buffer.from(tx.serialized, "base64");
      try {
        const signature = await connection.sendRawTransaction(txBuffer, {
          skipPreflight: false,
          preflightCommitment: "processed",
        });
        results.push(signature);
        console.log(`[SENDER] ✅ Tx accepted: ${signature.slice(0, 16)}...`);
      } catch (txErr: any) {
        // Tip tx to self on devnet may fail — that's fine
        console.log(`[SENDER] Tx ${results.length + 1} note: ${txErr.message.slice(0, 60)}`);
      }
    }

    if (results.length === 0) {
      return {
        bundleId: "send_failed",
        status: "failed",
        submittedAt,
        failureReason: "All transactions failed to send",
        method: "rpc_fallback",
      };
    }

    // Confirm the first (payload) transaction
    const signature = results[0];
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: bundle.blockhash,
      lastValidBlockHeight: bundle.lastValidBlockHeight,
    }, "confirmed");

    if (confirmation.value.err) {
      return {
        bundleId: signature,
        status: "failed",
        submittedAt,
        failureReason: JSON.stringify(confirmation.value.err),
        method: "rpc_fallback",
      };
    }

    const slot = await connection.getSlot("confirmed");
    console.log(`[SENDER] ✅ Confirmed at slot ${slot}`);

    return {
      bundleId: signature,
      status: "landed",
      submittedAt,
      landedAt: new Date().toISOString(),
      slotsElapsed: slot - bundle.builtAtSlot,
      method: "rpc_fallback",
    };

  } catch (err: any) {
    console.error(`[SENDER] RPC fallback failed: ${err.message}`);
    return {
      bundleId: "rpc_error",
      status: "failed",
      submittedAt,
      failureReason: err.message,
      method: "rpc_fallback",
    };
  }
}

// ============================================================
// POLL FOR BUNDLE STATUS (Jito bundles only)
// ============================================================

export async function pollBundleStatus(
  bundleId: string,
  isDevnet: boolean,
  maxAttempts = 45,
  intervalMs = 3000
): Promise<{
  status: "landed" | "failed" | "timeout";
  slot?: number;
  failureReason?: string;
}> {
  const endpoint = isDevnet
    ? JITO_ENDPOINTS.devnet
    : JITO_ENDPOINTS.mainnet[0];

  console.log(`[SENDER] Polling: ${bundleId.slice(0, 16)}...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));

    try {
      const response = await fetch(`${endpoint}/api/v1/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
        signal: AbortSignal.timeout(5_000),
      });

      const data = await response.json() as any;
      if (data.error) continue;

      const value = data.result?.value;
      if (!value || value.length === 0) {
        if (attempt % 5 === 0) {
          console.log(`[SENDER] Poll ${attempt}/${maxAttempts}: pending (no status yet)...`);
        }
        continue;
      }

      const bundleStatus = value[0];
      // Log full status on first non-empty response
      if (attempt <= 3 || bundleStatus?.confirmation_status) {
        console.log(`[SENDER] Poll ${attempt}/${maxAttempts}: raw =`, JSON.stringify(bundleStatus));
      }
      const status = bundleStatus?.confirmation_status ?? bundleStatus?.status;
      console.log(`[SENDER] Poll ${attempt}/${maxAttempts}: ${status}`);

      if (status === "confirmed" || status === "finalized") {
        return { status: "landed", slot: bundleStatus.slot };
      }

      if (status === "Failed" || status === "failed") {
        return {
          status: "failed",
          failureReason: JSON.stringify(bundleStatus.err ?? "unknown"),
        };
      }

    } catch {
      console.log(`[SENDER] Poll ${attempt}/${maxAttempts}: error, retrying...`);
    }
  }

  return { status: "timeout" };
}

// ============================================================
// SEND AND TRACK — main entry point
// ============================================================

export async function sendAndTrack(
  bundle: BuiltBundle,
  isDevnet: boolean
): Promise<SendResult> {
  const sendResult = await sendBundle(bundle, isDevnet);

  // RPC fallback already confirmed — return immediately
  if (sendResult.method === "rpc_fallback") {
    return sendResult;
  }

  if (sendResult.status === "failed") {
    return sendResult;
  }

  // Poll for Jito bundle confirmation
  console.log(`[SENDER] Waiting for bundle to land...`);
  const pollResult = await pollBundleStatus(sendResult.bundleId, isDevnet);

  if (pollResult.status === "landed") {
    console.log(`[SENDER] ✅ Bundle landed at slot ${pollResult.slot}`);
    return {
      ...sendResult,
      status: "landed",
      landedAt: new Date().toISOString(),
      slotsElapsed: pollResult.slot
        ? pollResult.slot - bundle.builtAtSlot
        : undefined,
    };
  }

  if (pollResult.status === "failed") {
    console.log(`[SENDER] ❌ Bundle failed: ${pollResult.failureReason}`);
    return {
      ...sendResult,
      status: "failed",
      failureReason: pollResult.failureReason,
    };
  }

  return {
    ...sendResult,
    status: "timeout",
    failureReason: "No confirmation within polling window",
  };
}

// ============================================================
// FAILURE CLASSIFIER
// Turns Jito error messages into clean types for the AI agent
// ============================================================

function classifyJitoError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("blockhash") || m.includes("block hash")) return "blockhash_expired";
  if (m.includes("fee") || m.includes("tip") || m.includes("lamport")) return "fee_too_low";
  if (m.includes("compute") || m.includes("budget")) return "compute_exceeded";
  if (m.includes("already processed")) return "already_processed";
  if (m.includes("bundle")) return "bundle_failed";
  return "unknown_jito_error";
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Bundle Sender Test");
  console.log("========================================\n");

  const { buildBundle, loadWallet } = require("./builder");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const isDevnet = rpcUrl.includes("devnet");
  const connection = new Connection(rpcUrl, "confirmed");

  const wallet = loadWallet();
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Network: ${isDevnet ? "DEVNET" : "MAINNET"}\n`);

  // Check Jito availability upfront
  const endpoint = isDevnet ? JITO_ENDPOINTS.devnet : JITO_ENDPOINTS.mainnet[0];
  const jitoUp = await isJitoReachable(endpoint);
  console.log(`Jito block engine: ${jitoUp ? "✅ REACHABLE" : "❌ UNREACHABLE (will use RPC fallback)"}\n`);

  // Build and send
  console.log("--- Building + Sending Bundle ---");
  const bundle = await buildBundle(
    connection,
    wallet,
    5000,
    isDevnet,
    "KAIROS-SEND-TEST-001"
  );

  const result = await sendAndTrack(bundle, isDevnet);

  console.log("\n--- Final Result ---");
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "landed") {
    console.log(`\n✅ Transaction confirmed!`);
    console.log(`Method: ${result.method}`);
    if (result.method === "rpc_fallback") {
      console.log(`Explorer: https://explorer.solana.com/tx/${result.bundleId}?cluster=devnet`);
    }
  } else {
    console.log(`\nStatus: ${result.status} — ${result.failureReason}`);
  }

  process.exit(0);
}

if (require.main === module) { test(); }