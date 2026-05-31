import * as fs from "fs";
import * as path from "path";

const dbPath = path.join(process.cwd(), "logs", "kairos.db");
const exportPath = path.join(process.cwd(), "logs", "lifecycle_export.json");

if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log("✅ Database reset — kairos.db deleted");
} else {
  console.log("ℹ️  No database found — nothing to reset");
}

if (fs.existsSync(exportPath)) {
  fs.unlinkSync(exportPath);
  console.log("✅ Export reset — lifecycle_export.json deleted");
}

console.log("Ready for a clean run.");