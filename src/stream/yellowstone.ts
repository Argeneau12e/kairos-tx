import { EventEmitter } from "events";
import { Connection } from "@solana/web3.js";
import * as dotenv from "dotenv";
dotenv.config();

// ============================================================
// TYPES — same interface whether mock or real Yellowstone
// ============================================================

export interface SlotEvent {
  slot: number;
  status: "processed" | "confirmed" | "finalized";
  timestamp: string;
  parent?: number;
}

export interface TransactionEvent {
  signature: string;
  slot: number;
  status: "processed" | "confirmed" | "finalized";
  err: string | null;
  timestamp: string;
}

// ============================================================
// SLOT STREAM — EventEmitter based
// Emits: "slot", "transaction", "error", "connected", "disconnected"
// ============================================================

export class SlotStream extends EventEmitter {
  private running = false;
  private mockInterval: NodeJS.Timeout | null = null;
  private currentSlot = 0;
  private connection: Connection;
  private isMock: boolean;

  // Tracks which signatures we are watching for confirmations
  private watchedSignatures = new Map<string, {
    submittedSlot: number;
    processedSlot?: number;
    confirmedSlot?: number;
  }>();

  constructor(rpcUrl: string) {
    super();
    this.connection = new Connection(rpcUrl, "confirmed");
    // Mock mode when no Yellowstone endpoint is configured
    this.isMock = !process.env.YELLOWSTONE_ENDPOINT ||
                   process.env.YELLOWSTONE_ENDPOINT.trim() === "";
    console.log(`[STREAM] Mode: ${this.isMock ? "MOCK (simulated slots)" : "REAL (Yellowstone gRPC)"}`);
  }

  // ============================================================
  // START THE STREAM
  // ============================================================

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Get current slot from RPC to start from the right place
    try {
      this.currentSlot = await this.connection.getSlot("processed");
      console.log(`[STREAM] Starting from slot ${this.currentSlot}`);
    } catch {
      this.currentSlot = 466000000; // fallback if RPC fails
    }

    if (this.isMock) {
      this.startMockStream();
    } else {
      this.startRealStream();
    }

    this.emit("connected", { slot: this.currentSlot, mode: this.isMock ? "mock" : "real" });
  }

  // ============================================================
  // MOCK STREAM — fires every 400ms like real Solana
  // ============================================================

  private startMockStream(): void {
    console.log("[STREAM] Mock stream started — firing every 400ms");

    this.mockInterval = setInterval(async () => {
      if (!this.running) return;

      this.currentSlot++;
      const now = new Date().toISOString();

      // Every slot fires as "processed" immediately
      const processedEvent: SlotEvent = {
        slot: this.currentSlot,
        status: "processed",
        timestamp: now,
        parent: this.currentSlot - 1,
      };
      this.emit("slot", processedEvent);

      // 2 slots later → "confirmed" (simulate vote propagation ~800ms)
      const confirmedSlot = this.currentSlot;
      setTimeout(() => {
        if (!this.running) return;
        this.emit("slot", {
          slot: confirmedSlot,
          status: "confirmed",
          timestamp: new Date().toISOString(),
        } as SlotEvent);

        // Check if any watched signatures should be confirmed now
        this.checkWatchedSignatures(confirmedSlot, "confirmed");

      }, 800);

      // 32 slots later → "finalized" (~12.8 seconds)
      const finalizedSlot = this.currentSlot;
      setTimeout(() => {
        if (!this.running) return;
        this.emit("slot", {
          slot: finalizedSlot,
          status: "finalized",
          timestamp: new Date().toISOString(),
        } as SlotEvent);

        // Check if any watched signatures should be finalized now
        this.checkWatchedSignatures(finalizedSlot, "finalized");

      }, 12_800);

    }, 400); // 400ms = Solana slot time
  }

  // ============================================================
  // REAL STREAM — Yellowstone gRPC (activated when SolInfra arrives)
  // ============================================================

  private startRealStream(): void {
    // This will be implemented when SolInfra provides the endpoint
    // The interface (EventEmitter events) stays identical
    console.log("[STREAM] Real Yellowstone gRPC stream — coming when SolInfra activates");
    console.log("[STREAM] Endpoint:", process.env.YELLOWSTONE_ENDPOINT);

    // For now fall back to mock even if endpoint is set
    // We will replace this block with real gRPC code
    this.isMock = true;
    this.startMockStream();
  }

  // ============================================================
  // WATCH A SIGNATURE FOR CONFIRMATIONS
  // After submitting a bundle, call this to track it
  // ============================================================

  watchSignature(signature: string, submittedSlot: number): void {
    this.watchedSignatures.set(signature, { submittedSlot });
    console.log(`[STREAM] Watching signature ${signature.slice(0, 12)}... from slot ${submittedSlot}`);
  }

  private checkWatchedSignatures(
    currentSlot: number,
    stage: "confirmed" | "finalized"
  ): void {
    this.watchedSignatures.forEach((data, signature) => {
      // In mock mode — simulate confirmation 3-5 slots after submission
      if (stage === "confirmed" && !data.confirmedSlot) {
        const slotsElapsed = currentSlot - data.submittedSlot;
        if (slotsElapsed >= 4) {
          data.confirmedSlot = currentSlot;
          this.watchedSignatures.set(signature, data);
          this.emit("transaction", {
            signature,
            slot: currentSlot,
            status: "confirmed",
            err: null,
            timestamp: new Date().toISOString(),
          } as TransactionEvent);
        }
      }

      if (stage === "finalized" && data.confirmedSlot && !data.processedSlot) {
        const slotsAfterConfirm = currentSlot - data.confirmedSlot;
        if (slotsAfterConfirm >= 32) {
          this.emit("transaction", {
            signature,
            slot: currentSlot,
            status: "finalized",
            err: null,
            timestamp: new Date().toISOString(),
          } as TransactionEvent);
          // Stop watching once finalized
          this.watchedSignatures.delete(signature);
        }
      }
    });
  }

  // ============================================================
  // STOP
  // ============================================================

  stop(): void {
    this.running = false;
    if (this.mockInterval) {
      clearInterval(this.mockInterval);
      this.mockInterval = null;
    }
    this.emit("disconnected");
    console.log("[STREAM] Stream stopped");
  }

  // ============================================================
  // GETTERS
  // ============================================================

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  isConnected(): boolean {
    return this.running;
  }
}

// ============================================================
// TEST
// ============================================================

async function test() {
  console.log("\n========================================");
  console.log("  KAIROS — Slot Stream Test");
  console.log("========================================\n");

  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const stream = new SlotStream(rpcUrl);

  // Count events for the test
  let processedCount = 0;
  let confirmedCount = 0;
  let finalizedCount = 0;

  // Listen to slot events
  stream.on("connected", (info) => {
    console.log(`[TEST] Connected — starting slot: ${info.slot}, mode: ${info.mode}`);
  });

  stream.on("slot", (event: SlotEvent) => {
    if (event.status === "processed") {
      processedCount++;
      if (processedCount <= 3) {
        // Only print first 3 to avoid spam
        console.log(`[TEST] Slot ${event.slot} → PROCESSED`);
      }
    } else if (event.status === "confirmed") {
      confirmedCount++;
      if (confirmedCount === 1) {
        console.log(`[TEST] Slot ${event.slot} → CONFIRMED ✅`);
      }
    } else if (event.status === "finalized") {
      finalizedCount++;
      if (finalizedCount === 1) {
        console.log(`[TEST] Slot ${event.slot} → FINALIZED 🏁`);
      }
    }
  });

  stream.on("transaction", (event: TransactionEvent) => {
    console.log(`[TEST] Transaction ${event.signature.slice(0, 12)}... → ${event.status}`);
  });

  // Start the stream
  await stream.start();

  // Simulate watching a signature after 1 second
  setTimeout(() => {
    const fakeSignature = "FakeSig" + Math.random().toString(36).slice(2, 10);
    const currentSlot = stream.getCurrentSlot();
    console.log(`\n[TEST] Watching fake signature from slot ${currentSlot}`);
    stream.watchSignature(fakeSignature, currentSlot);
  }, 1000);

  // Let it run for 6 seconds then stop
  console.log("[TEST] Running for 6 seconds...\n");
  await new Promise(r => setTimeout(r, 6000));

  stream.stop();

  console.log(`\n--- Results after 6 seconds ---`);
  console.log(`Processed events:  ${processedCount}`);
  console.log(`Confirmed events:  ${confirmedCount}`);
  console.log(`Finalized events:  ${finalizedCount}`);
  console.log(`Expected ~15 processed (6000ms / 400ms)`);

  console.log("\n✅ Slot Stream test complete");
  process.exit(0);
}

if (require.main === module) { test(); }