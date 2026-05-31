import { Keypair } from "@solana/web3.js";
import * as fs from "fs";

const keypair = Keypair.generate();
const secretKey = Array.from(keypair.secretKey);

fs.writeFileSync("./keypair.json", JSON.stringify(secretKey));

console.log("✅ Wallet generated!");
console.log("Public key (your address):", keypair.publicKey.toBase58());
console.log("keypair.json saved — this is your private key, NEVER share it");
console.log("\nNext: request devnet SOL airdrop at:");
console.log("https://faucet.solana.com → paste your address above");