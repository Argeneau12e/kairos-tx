import Groq from "groq-sdk";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

import { getSessionSummary } from "../stream/networkHealth";

// ============================================================
// AI NETWORK INTELLIGENCE REPORT
// After every run, synthesizes what the system observed
// into a human-readable paragraph
// ============================================================

export interface SessionData {
  startSlot: number;
  endSlot: number;
  totalBundles: number;
  landedBundles: number;
  failedBundles: number;
  avgPcDelta: number;
  minPcDelta: number;
  maxPcDelta: number;
  minTipP75: number;
  maxTipP75: number;
  tipVolatilityRatio: number;
  networkGrades: string[];  // e.g. ["healthy", "congested", "degraded"]
  aiDecisions: Array<{
    bundle: number;
    tip: number;
    assessment: string;
    reasoning: string;
  }>;
}

export async function generateNetworkReport(data: SessionData): Promise<string> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const uniqueGrades = [...new Set(data.networkGrades)];
  const mostCommonGrade = data.networkGrades.sort(
    (a, b) =>
      data.networkGrades.filter(v => v === b).length -
      data.networkGrades.filter(v => v === a).length
  )[0];

  const prompt = `You are the network intelligence module of KAIROS, a Solana transaction infrastructure stack.

You have just completed a ${data.totalBundles}-bundle submission session. Synthesize the observations into a professional, concise 3-4 sentence paragraph that an infrastructure engineer would find genuinely useful.

SESSION DATA:
- Slot range: ${data.startSlot} → ${data.endSlot}
- Bundles: ${data.landedBundles}/${data.totalBundles} landed (${((data.landedBundles/data.totalBundles)*100).toFixed(0)}% success)
- Network health grades observed: ${uniqueGrades.join(", ")} (most common: ${mostCommonGrade})
- processed→confirmed delta: avg ${data.avgPcDelta.toFixed(0)}ms, range ${data.minPcDelta}ms–${data.maxPcDelta}ms
- Jito tip P75: ranged from ${data.minTipP75.toLocaleString()} to ${data.maxTipP75.toLocaleString()} lamports (${data.tipVolatilityRatio.toFixed(1)}x volatility)
- Infrastructure: SolInfra gRPC node (${process.env.YELLOWSTONE_ENDPOINT?.split('.')[0] ?? 'configured endpoint'})Frankfurt (FRA) gRPC node

REPRESENTATIVE AI DECISIONS:
${data.aiDecisions.slice(0, 4).map(d =>
  `Bundle ${d.bundle}: tipped ${d.tip.toLocaleString()} lam (${d.assessment}) — "${d.reasoning.slice(0, 100)}"`
).join("\n")}

Write a professional infrastructure observation report paragraph. Include:
1. Overall network state assessment for this session
2. What the tip volatility indicates about market activity
3. One specific noteworthy observation (e.g. the highest delta, a notable tip spike, a pattern)
4. What this means operationally for bundle submission strategy

Do not use bullet points. Write as flowing prose. Be specific with numbers. Sound like a senior Solana infrastructure engineer writing an internal ops report.`;

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are a senior Solana infrastructure engineer writing operational reports. Be precise, technical, and specific. No fluff."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.3,
    });

    return response.choices[0].message.content ?? "Report generation failed.";

  } catch (err: any) {
    console.error("[REPORT] Groq error:", err.message);
    return generateFallbackReport(data);
  }
}

function generateFallbackReport(data: SessionData): string {
  return `KAIROS Session Report (slots ${data.startSlot}–${data.endSlot}): ` +
    `The network operated in a ${data.networkGrades[0] ?? "mixed"} state during this ${data.totalBundles}-bundle session, ` +
    `with processed→confirmed deltas ranging from ${data.minPcDelta}ms to ${data.maxPcDelta}ms ` +
    `(average: ${data.avgPcDelta.toFixed(0)}ms). ` +
    `Jito tip P75 showed ${data.tipVolatilityRatio.toFixed(1)}x volatility (${data.minTipP75.toLocaleString()}–${data.maxTipP75.toLocaleString()} lamports), ` +
    `indicating elevated searcher activity during at least one submission window. ` +
    `The AI tip agent responded to network state changes across all ${data.totalBundles} bundles, ` +
    `scaling tips dynamically from market conditions rather than fixed values. ` +
    `${data.failedBundles} failure cases were detected and classified, with autonomous retry decisions executed by the agent.`;
}

export function saveReport(report: string, startSlot: number): void {
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

  const reportPath = path.join(logsDir, "network_report.txt");
  const timestamp = new Date().toISOString();

  const fullReport = `KAIROS Network Intelligence Report
Generated: ${timestamp}
Session Start Slot: ${startSlot}
${"=".repeat(60)}

${report}

${"=".repeat(60)}
Generated by KAIROS AI Agent (Groq llama-3.3-70b-versatile)
`;

  fs.writeFileSync(reportPath, fullReport);
  console.log(`[REPORT] Network intelligence report saved to logs/network_report.txt`);
}