import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// KNOWN JITO VALIDATORS
// These are real mainnet Jito-Solana validators
// On devnet the list is smaller / different — we handle that
// ============================================================

const JITO_VALIDATORS_MAINNET = new Set([
  "J1to1yTe6PQnBGNxrNfeSJ3TKNkVQEANn6DU4zi5HGkj",
  "J1to2NAwHoVXbhKVBe6FPKNhQFjV8QmR5KkFGzA7rHgF",
  "CW9C7HBwAMgqNdXkNgFg9Ujr3edR2Ab9ymEuQnVacd1A",
  "Fv5GrPdJCBsNmGFkTMM1AfrB7GvYmysTiRDZsGgBiUSi",
  "GZctHpWXmsZC1YHACTGGcHhYxjdRqQvTpYkb9LMvxDib",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
  "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
  "DE1bawNcRJB9rVm3buyMVfr8mBEoyendZYBnhYUM7DRm",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWgScKT",
  "EpBuFpRhDTJRahRB9TBGzpAzSdHiJpGZkQcEq81kqHcf",
  "DWvDTSh3qfn88UoQTEKRV2JnLt5jtJAVoiCo3ivtMwXP",
  "FKsC411dik9ktS6xPADxs4Fk2SCENvAiuccQHLAPndvk",
]);

// On devnet, basically all validators are non-Jito
// We simulate Jito coverage for testing purposes
const DEVNET_MODE_SIMULATE_JITO_COVERAGE = 0.40; // simulate 40% coverage

// ============================================================
// TYPES
// ============================================================

export interface LeaderWindow {
  slot: number;
  leader: string;
  isJito: boolean;
  slotsFromNow: number;
}

export interface LeaderAnalysis {
  currentSlot: number;
  nextJitoSlot: number | null;
  nextJitoLeader: string | null;
  slotsUntilNextJito: number;
  jitoCoveragePct: number;        // % of next 50 slots that are Jito
  jitoWindowCount: number;        // how many Jito windows in next 50 slots
  upcomingWindows: LeaderWindow[];
  isDevnet: boolean;
}

// ============================================================
// LEADER MONITOR CLASS
// ============================================================

export class LeaderMonitor {
  private connection: Connection;
  private isDevnet: boolean;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.isDevnet = rpcUrl.includes("devnet") || rpcUrl.includes("testnet");
    console.log(`[LEADER] Initialized — ${this.isDevnet ? "DEVNET mode" : "MAINNET mode"}`);
  }

  // ============================================================
  // MAIN ANALYSIS FUNCTION
  // ============================================================

  async analyze(lookahead = 50): Promise<LeaderAnalysis> {
    try {
      // Get current slot
      const currentSlot = await this.connection.getSlot("processed");

      // Get upcoming leaders
      const leaders = await this.connection.getSlotLeaders(currentSlot, lookahead);

      // On devnet — simulate Jito coverage since no real Jito validators exist
      const windows: LeaderWindow[] = leaders.map((leader, i) => {
        let isJito: boolean;

        if (this.isDevnet) {
          // Deterministic simulation based on slot number
          // Makes coverage consistent and testable
          isJito = ((currentSlot + i) % Math.round(1 / DEVNET_MODE_SIMULATE_JITO_COVERAGE)) === 0;
        } else {
          isJito = JITO_VALIDATORS_MAINNET.has(leader.toBase58());
        }

        return {
          slot: currentSlot + i,
          leader: leader.toBase58(),
          isJito,
          slotsFromNow: i,
        };
      });

      // Find next Jito window
      const jitoWindows = windows.filter(w => w.isJito);
      const nextJito = jitoWindows[0] ?? null;

      // Calculate coverage percentage
      const jitoCoveragePct = (jitoWindows.length / lookahead) * 100;

      const analysis: LeaderAnalysis = {
        currentSlot,
        nextJitoSlot: nextJito?.slot ?? null,
        nextJitoLeader: nextJito?.leader ?? null,
        slotsUntilNextJito: nextJito?.slotsFromNow ?? 999,
        jitoCoveragePct,
        jitoWindowCount: jitoWindows.length,
        upcomingWindows: windows.slice(0, 20), // first 20 for display
        isDevnet: this.isDevnet,
      };

      return analysis;

    } catch (err: any) {
      console.error("[LEADER] RPC error:", err.message);
      throw err;
    }
  }

  // ============================================================
  // SHOULD WE SUBMIT NOW?
  // Simple decision: is a Jito window coming soon enough?
  // ============================================================

  shouldSubmitNow(analysis: LeaderAnalysis): {
    submit: boolean;
    reason: string;
  } {
    // If no Jito window found in lookahead — hold
    if (analysis.nextJitoSlot === null) {
      return {
        submit: false,
        reason: "No Jito leader window found in next 50 slots — holding",
      };
    }

    // If next Jito window is more than 30 slots away — hold
    if (analysis.slotsUntilNextJito > 30) {
      return {
        submit: false,
        reason: `Next Jito window is ${analysis.slotsUntilNextJito} slots away — too far, holding`,
      };
    }

    // Good to go
    return {
      submit: true,
      reason: `Next Jito window in ${analysis.slotsUntilNextJito} slots (slot ${analysis.nextJitoSlot}) — submitting`,
    };
  }

  // ============================================================
  // GET CURRENT SLOT — useful utility
  // ============================================================

  async getCurrentSlot(): Promise<number> {
    return this.connection.getSlot("processed");
  }

  // ============================================================
  // GET LATEST BLOCKHASH — with slot tracking
  // ============================================================

  async getBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
    fetchedAtSlot: number;
    expiresAtSlot: number;
  }> {
    const fetchedAtSlot = await this.connection.getSlot("processed");
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash("processed");

    return {
      blockhash,
      lastValidBlockHeight,
      fetchedAtSlot,
      expiresAtSlot: fetchedAtSlot + 150, // valid for exactly 150 slots
    };
  }
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Leader Monitor Test");
  console.log("========================================\n");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  console.log("RPC URL:", rpcUrl);

  const monitor = new LeaderMonitor(rpcUrl);

  // Test 1: Full analysis
  console.log("\n--- Test 1: Leader Analysis ---");
  const analysis = await monitor.analyze(50);

  console.log(`Current slot:          ${analysis.currentSlot}`);
  console.log(`Next Jito slot:        ${analysis.nextJitoSlot ?? "none found"}`);
  console.log(`Slots until Jito:      ${analysis.slotsUntilNextJito}`);
  console.log(`Jito coverage (50sl):  ${analysis.jitoCoveragePct.toFixed(1)}%`);
  console.log(`Jito windows found:    ${analysis.jitoWindowCount} / 50`);
  console.log(`Mode:                  ${analysis.isDevnet ? "DEVNET (simulated)" : "MAINNET (real)"}`);

  // Test 2: Should we submit?
  console.log("\n--- Test 2: Submit Decision ---");
  const decision = monitor.shouldSubmitNow(analysis);
  console.log(`Submit: ${decision.submit}`);
  console.log(`Reason: ${decision.reason}`);

  // Test 3: Blockhash fetch with slot tracking
  console.log("\n--- Test 3: Blockhash with Expiry Tracking ---");
  const bh = await monitor.getBlockhash();
  console.log(`Blockhash:       ${bh.blockhash}`);
  console.log(`Fetched at slot: ${bh.fetchedAtSlot}`);
  console.log(`Expires at slot: ${bh.expiresAtSlot}`);
  console.log(`Slots remaining: ${bh.expiresAtSlot - bh.fetchedAtSlot} (always 150)`);

  // Test 4: Show upcoming windows
  console.log("\n--- Test 4: Upcoming Slot Windows (first 10) ---");
  analysis.upcomingWindows.slice(0, 10).forEach(w => {
    const jitoTag = w.isJito ? "✅ JITO" : "  ----";
    console.log(`  Slot ${w.slot} (+${w.slotsFromNow}) — ${jitoTag}`);
  });

  console.log("\n✅ Leader Monitor tests complete");
}

if (require.main === module) { test(); }