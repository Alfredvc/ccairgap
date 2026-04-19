import { existsSync, readFileSync } from "node:fs";

/**
 * Read a Claude Code transcript jsonl and return the latest `agentName` from an
 * `agent-name`-typed entry, or `undefined` if the file is missing, has no such
 * entry, or every candidate line fails to parse. Reverse-scans so rename-heavy
 * sessions short-circuit without reading the whole file.
 *
 * Fail-open: any JSON.parse error on a line is swallowed; scan continues.
 */
export function extractLatestAgentName(jsonlPath: string): string | undefined {
  if (!existsSync(jsonlPath)) return undefined;
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      obj !== null &&
      typeof obj === "object" &&
      (obj as { type?: unknown }).type === "agent-name" &&
      typeof (obj as { agentName?: unknown }).agentName === "string"
    ) {
      return (obj as { agentName: string }).agentName;
    }
  }
  return undefined;
}
