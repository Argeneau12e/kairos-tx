import * as fs from "fs";
import * as path from "path";

const PROTO_FILES = [
  {
    url: "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/geyser.proto",
    filename: "yellowstone.proto",
  },
  {
    url: "https://raw.githubusercontent.com/rpcpool/yellowstone-grpc/master/yellowstone-grpc-proto/proto/solana-storage.proto",
    filename: "solana-storage.proto",
  },
];

async function downloadProtos() {
  console.log("Downloading Yellowstone proto files...\n");

  for (const file of PROTO_FILES) {
    const destPath = path.join(process.cwd(), file.filename);
    console.log(`Fetching ${file.filename}...`);

    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${file.url}: ${response.status}`);
    }

    const content = await response.text();
    fs.writeFileSync(destPath, content);
    console.log(`✅ Saved ${file.filename} (${content.length} bytes)`);
  }

  console.log("\n✅ All proto files downloaded");
}

downloadProtos();