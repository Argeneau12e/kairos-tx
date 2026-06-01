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
      await this.startRealStream();
    }

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

  private async startRealStream(): Promise<void> {
    const endpoint = process.env.YELLOWSTONE_ENDPOINT!;
    const token = process.env.YELLOWSTONE_TOKEN!;

    console.log(`[STREAM] Connecting via @grpc/grpc-js to ${endpoint}`);

    try {
      const grpc = await import("@grpc/grpc-js");
      const protoLoader = await import("@grpc/proto-loader");
      const path = await import("path");
      const fs = await import("fs");

      // Download and cache the Yellowstone proto file
      const protoPath = path.join(process.cwd(), "yellowstone.proto");

      if (!fs.existsSync(protoPath)) {
        console.log("[STREAM] Downloading Yellowstone proto definition...");
        const protoContent = await fetch(
          "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto"
        ).then(r => r.text());
        fs.writeFileSync(protoPath, protoContent);
        console.log("[STREAM] Proto file saved");
      }

      const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const proto = grpc.loadPackageDefinition(packageDef) as any;

      // Create SSL credentials with token metadata
      const sslCreds = grpc.credentials.createSsl();
      const metaCallback = (
        _params: any,
        callback: (err: null, metadata: any) => void
      ) => {
        const meta = new grpc.Metadata();
        meta.add("x-token", token);
        callback(null, meta);
      };
      const callCreds = grpc.credentials.createFromMetadataGenerator(metaCallback);
      const combinedCreds = grpc.credentials.combineChannelCredentials(
        sslCreds,
        callCreds
      );

      // Connect to the Geyser service
      const GeyserService = proto.geyser?.Geyser;
      if (!GeyserService) {
        throw new Error("Geyser service not found in proto. Proto may not have loaded correctly.");
      }

      const client = new GeyserService(endpoint, combinedCreds);

      // Open the Subscribe stream
      const stream = client.Subscribe();

      // Send subscription — slots use named filter map
      stream.write({
        slots: {
          "kairos-slots": {}   // named filter key required by Yellowstone proto
        },
        accounts: {},
        transactions: {},
        blocks: {},
        blocks_meta: {},
        entry: {},
        commitment: 1,
        accounts_data_slice: [],
        ping: undefined,
      });

      console.log("[STREAM] Subscription sent — waiting for slot events...");

      let retryDelay = 1000;
      const maxDelay = 30000;

      stream.on("data", (data: any) => {
        if (!this.running) return;

        if (data.slot) {
          const slotNum = parseInt(data.slot.slot);
          if (isNaN(slotNum)) return;

          // Map status string to our type
          const statusStr = (data.slot.status || "").toLowerCase();
          let stage: "processed" | "confirmed" | "finalized" = "processed";

          if (statusStr.includes("processed") || statusStr === "0" || statusStr === "1") {
            stage = "processed";
          } else if (statusStr.includes("confirmed") || statusStr === "2") {
            stage = "confirmed";
          } else if (statusStr.includes("finalized") || statusStr === "3") {
            stage = "finalized";
          }

          if (stage === "processed") {
            this.currentSlot = slotNum;
          }

          const event: SlotEvent = {
            slot: slotNum,
            status: stage,
            timestamp: new Date().toISOString(),
            parent: data.slot.parent ? parseInt(data.slot.parent) : undefined,
          };

          this.emit("slot", event);

          if (stage === "confirmed" || stage === "finalized") {
            this.checkWatchedSignatures(slotNum, stage);
          }
        }

        // Ping/pong keepalive
        if (data.ping) {
          stream.write({ pong: { id: data.ping.id } });
        }
      });

      stream.on("error", async (err: any) => {
        if (!this.running) return;
        console.error(`[STREAM] gRPC error: ${err.message}`);
        this.emit("disconnected");
        console.log(`[STREAM] Reconnecting in ${retryDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, maxDelay);
        this.startRealStream();
      });

      stream.on("end", async () => {
        if (!this.running) return;
        console.log("[STREAM] Stream ended — reconnecting...");
        this.emit("disconnected");
        await new Promise(r => setTimeout(r, retryDelay));
        retryDelay = Math.min(retryDelay * 2, maxDelay);
        this.startRealStream();
      });

      // Emit connected immediately after subscription sent
      console.log("[STREAM] Subscription sent — waiting for slot events...");
      this.emit("connected", { slot: this.currentSlot, mode: "real" });

      stream.on("status", (status: any) => {
        if (status.code === 0) {
          retryDelay = 1000;
        } else {
          console.log(`[STREAM] gRPC status code: ${status.code} — ${status.details}`);
        }
      });

    } catch (err: any) {
      console.error("[STREAM] Real stream error:", err.message);
      console.log("[STREAM] Falling back to mock mode");
      this.isMock = true;
      this.startMockStream();
    }
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