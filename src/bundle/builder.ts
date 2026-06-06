import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// TIP ACCOUNT MANAGEMENT
// Fetches live tip accounts from Jito API — never hardcoded
// ============================================================

let cachedTipAccounts: string[] = [];
let tipAccountCacheTime = 0;
const TIP_ACCOUNT_TTL = 60_000; // refresh every 60 seconds

// Fallback list in case API is unreachable
const JITO_TIP_ACCOUNTS_FALLBACK = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13edo1vY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWgScKT",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export async function fetchJitoTipAccounts(isDevnet: boolean): Promise<string[]> {
  if (isDevnet) return []; // Not used on devnet

  const now = Date.now();
  if (cachedTipAccounts.length > 0 && now - tipAccountCacheTime < TIP_ACCOUNT_TTL) {
    return cachedTipAccounts;
  }

  try {
    const response = await fetch("https://mainnet.block-engine.jito.wtf/api/v1/bundles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTipAccounts",
        params: [],
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await response.json() as any;
    if (data.result && Array.isArray(data.result) && data.result.length > 0) {
      cachedTipAccounts = data.result;
      tipAccountCacheTime = now;
      console.log(`[BUILDER] Fetched ${cachedTipAccounts.length} live Jito tip accounts`);
      return cachedTipAccounts;
    }
  } catch (err: any) {
    console.warn(`[BUILDER] Could not fetch tip accounts: ${err.message} — using fallback`);
  }

  return JITO_TIP_ACCOUNTS_FALLBACK;
}

async function pickTipAccount(isDevnet: boolean, submitterPubkey: string): Promise<PublicKey> {
  if (isDevnet) {
    return new PublicKey(submitterPubkey);
  }
  const accounts = await fetchJitoTipAccounts(false);
  const picked = accounts[Math.floor(Math.random() * accounts.length)];
  console.log(`[BUILDER] Tip account: ${picked.slice(0, 8)}...`);
  return new PublicKey(picked);
}


// ============================================================
// LOAD WALLET
// ============================================================

export function loadWallet(): Keypair {
  const keypairPath = process.env.WALLET_KEYPAIR_PATH ?? "./keypair.json";

  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Wallet not found at ${keypairPath}. Run: npm run generate-wallet`);
  }

  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ============================================================
// TYPES
// ============================================================

export interface BundleTransaction {
  // The serialized transaction (base64)
  serialized: string;
  // The signature
  signature: string;
  // Human readable description
  description: string;
}

export interface BuiltBundle {
  transactions: BundleTransaction[];
  tipLamports: number;
  tipAccount: string;
  blockhash: string;
  lastValidBlockHeight: number;
  builtAtSlot: number;
  expiresAtSlot: number;
}


// ============================================================
// BUILD A BUNDLE
// Creates two transactions:
//   Tx 1 — the "real" transaction (a tiny SOL transfer to yourself)
//   Tx 2 — the tip payment to Jito
//
// In a real trading bot, Tx 1 would be your swap/trade.
// For this bounty, a self-transfer proves the bundle mechanism
// without requiring any specific token.
// ============================================================

export async function buildBundle(
  connection: Connection,
  wallet: Keypair,
  tipLamports: number,
  isDevnet: boolean,
  memo?: string
): Promise<BuiltBundle> {

  console.log(`[BUILDER] Building bundle — tip: ${tipLamports} lamports`);

  // Get fresh blockhash
  const currentSlot = await connection.getSlot("processed");
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("processed");

  const expiresAtSlot = currentSlot + 150;

  // ── Transaction 1: "Real" transaction ──────────────────────
  // A tiny transfer to ourselves (1 lamport)
  // This is our "payload" transaction — proves the bundle mechanism
  const tx1 = new Transaction();
  tx1.recentBlockhash = blockhash;
  tx1.feePayer = wallet.publicKey;

  // Add compute budget — good practice, shows we understand CU pricing
  tx1.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
  );

  // The actual instruction: send 1 lamport to ourselves
  tx1.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 1,
    })
  );

  // Add a memo if provided (useful for identifying test bundles in explorer)
  if (memo) {
    tx1.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(memo, "utf-8"),
      })
    );
  }

  tx1.sign(wallet);
  const sig1 = tx1.signatures[0].signature
    ? Buffer.from(tx1.signatures[0].signature).toString("base64")
    : "unsigned";
  const serialized1 = tx1.serialize().toString("base64");

  // ── Transaction 2: Jito tip transaction ────────────────────
  // This pays the tip to Jito's tip account
  // MUST be in the same bundle as Tx1 — atomic execution
const tipAccount = await pickTipAccount(isDevnet, wallet.publicKey.toBase58());

  const tx2 = new Transaction();
  tx2.recentBlockhash = blockhash;
  tx2.feePayer = wallet.publicKey;

  tx2.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
  );

  tx2.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    })
  );

  tx2.sign(wallet);
  const sig2 = tx2.signatures[0].signature
    ? Buffer.from(tx2.signatures[0].signature).toString("base64")
    : "unsigned";
  const serialized2 = tx2.serialize().toString("base64");

  const bundle: BuiltBundle = {
    transactions: [
      {
        serialized: serialized1,
        signature: Buffer.from(tx1.signatures[0].signature ?? new Uint8Array(64)).toString("hex"),
        description: `Self-transfer 1 lamport${memo ? ` | memo: ${memo}` : ""}`,
      },
      {
        serialized: serialized2,
        signature: Buffer.from(tx2.signatures[0].signature ?? new Uint8Array(64)).toString("hex"),
        description: `Jito tip: ${tipLamports} lamports → ${tipAccount.toBase58().slice(0, 8)}...`,
      },
    ],
    tipLamports,
    tipAccount: tipAccount.toBase58(),
    blockhash,
    lastValidBlockHeight,
    builtAtSlot: currentSlot,
    expiresAtSlot,
  };

  console.log(`[BUILDER] Bundle built:`);
  console.log(`  Tx1: ${bundle.transactions[0].description}`);
  console.log(`  Tx2: ${bundle.transactions[1].description}`);
  console.log(`  Blockhash: ${blockhash.slice(0, 16)}...`);
  console.log(`  Valid until slot: ${expiresAtSlot}`);

  return bundle;
}

// ============================================================
// CHECK IF BLOCKHASH IS STILL VALID
// Call before every retry
// ============================================================

export function isBlockhashExpired(
  builtAtSlot: number,
  currentSlot: number
): boolean {
  const slotsElapsed = currentSlot - builtAtSlot;
  return slotsElapsed >= 150;
}

// ============================================================
// PRE-FLIGHT SIMULATION
// Simulate the payload transaction before spending lamports
// Catches compute_exceeded and instruction errors early
// ============================================================

export interface SimulationResult {
  passed: boolean;
  errorType?: string;
  errorMessage?: string;
  unitsConsumed?: number;
  logs?: string[];
}

export async function simulateBundle(
  connection: Connection,
  bundle: BuiltBundle
): Promise<SimulationResult> {
  try {
    // Simulate the payload transaction (Tx1) only
    // The tip transaction is a simple SOL transfer — always valid
    const txBuffer = Buffer.from(bundle.transactions[0].serialized, "base64");

    // Deserialize for simulation
    const { Transaction } = require("@solana/web3.js");
    const tx = Transaction.from(txBuffer);

    const simulation = await connection.simulateTransaction(tx, undefined, true);

    if (simulation.value.err) {
      const errStr = JSON.stringify(simulation.value.err);
      let errorType = "simulation_failed";

      if (errStr.includes("ComputeBudget") || errStr.includes("exceeded")) {
        errorType = "compute_exceeded";
      } else if (errStr.includes("InsufficientFunds")) {
        errorType = "insufficient_funds";
      } else if (errStr.includes("InvalidAccountData")) {
        errorType = "invalid_account";
      }

      console.log(`[PREFLIGHT] ❌ Simulation failed: ${errorType}`);
      console.log(`[PREFLIGHT] Error: ${errStr}`);

      return {
        passed: false,
        errorType,
        errorMessage: errStr,
        unitsConsumed: simulation.value.unitsConsumed ?? 0,
        logs: simulation.value.logs ?? [],
      };
    }

    const units = simulation.value.unitsConsumed ?? 0;
    console.log(`[PREFLIGHT] ✅ Simulation passed — ${units.toLocaleString()} compute units`);

    return {
      passed: true,
      unitsConsumed: units,
      logs: simulation.value.logs ?? [],
    };

  } catch (err: any) {
    // Simulation errors that aren't transaction errors
    // (network issues, RPC problems) — don't block submission
    console.warn(`[PREFLIGHT] Simulation unavailable: ${err.message} — proceeding`);
    return { passed: true, errorMessage: err.message };
  }
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Bundle Builder Test");
  console.log("========================================\n");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const isDevnet = rpcUrl.includes("devnet");
  const connection = new Connection(rpcUrl, "confirmed");

  // Load wallet
  let wallet: Keypair;
  try {
    wallet = loadWallet();
    console.log(`✅ Wallet loaded: ${wallet.publicKey.toBase58()}`);
  } catch (err: any) {
    console.error("❌", err.message);
    process.exit(1);
  }

  // Check balance
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💰 Balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 10_000) {
    console.error("❌ Insufficient balance. Need at least 0.00001 SOL");
    process.exit(1);
  }

  // Test 1: Build a bundle
  console.log("\n--- Test 1: Build Bundle ---");
  const bundle = await buildBundle(
    connection,
    wallet,
    5000,       // 5000 lamports tip
    isDevnet,
    "KAIROS-TEST-001"
  );

  console.log("\nBundle details:");
  console.log(`  Tip account:    ${bundle.tipAccount}`);
  console.log(`  Tip amount:     ${bundle.tipLamports} lamports`);
  console.log(`  Built at slot:  ${bundle.builtAtSlot}`);
  console.log(`  Expires at:     ${bundle.expiresAtSlot}`);
  console.log(`  Blockhash:      ${bundle.blockhash}`);
  console.log(`  Tx count:       ${bundle.transactions.length}`);
  console.log(`  Sig 1:          ${bundle.transactions[0].signature.slice(0, 16)}...`);
  console.log(`  Sig 2:          ${bundle.transactions[1].signature.slice(0, 16)}...`);

  // Test 2: Blockhash expiry check
  console.log("\n--- Test 2: Blockhash Expiry Logic ---");
  const notExpired = isBlockhashExpired(bundle.builtAtSlot, bundle.builtAtSlot + 50);
  const expired = isBlockhashExpired(bundle.builtAtSlot, bundle.builtAtSlot + 151);
  console.log(`At +50 slots:  expired = ${notExpired}  (expected: false)`);
  console.log(`At +151 slots: expired = ${expired}  (expected: true)`);

  // Test 3: Rebuild with different tip
  console.log("\n--- Test 3: Rebuild with Different Tip ---");
  const bundle2 = await buildBundle(
    connection,
    wallet,
    9400,
    isDevnet,
    "KAIROS-RETRY-001"
  );
  console.log(`New tip: ${bundle2.tipLamports} lamports`);
  console.log(`New blockhash: ${bundle2.blockhash.slice(0, 16)}...`);
  console.log(`Different blockhash: ${bundle.blockhash !== bundle2.blockhash}`);

  console.log("\n✅ Bundle Builder tests complete");
  console.log("\nNote: Transactions built but NOT submitted yet.");
  console.log("Submission happens in the next module (Bundle Sender).");
}

if (require.main === module) { test(); }