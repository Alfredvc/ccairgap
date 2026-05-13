import type { HookRecord } from "./hooks.js";
import type { McpRecord } from "./mcp.js";
import type { EnvRecord, MarketplaceRecord } from "./settings.js";

/**
 * Human-readable tables for `ccairgap inspect --pretty`. JSON is the source of
 * truth; this is a lossy projection tuned for scanning a terminal. Each record
 * type gets one section, one row per entry. Long values wrap inside cells so
 * the table stays intact regardless of terminal width.
 *
 * Column widths are computed from content with a per-column cap (commands,
 * env values, MCP details, marketplace paths) so one runaway string can't push
 * the table off-screen. Wrapping is word-aware, with hard-wrap fallback for
 * tokens longer than the cap.
 */

const COL_CAP = {
  command: 80,
  envValue: 60,
  mcpDetail: 60,
  mcpName: 40,
  hostPath: 60,
} as const;

function wrapCell(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= maxWidth) {
      lines.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > maxWidth) {
      let cut = remaining.lastIndexOf(" ", maxWidth);
      if (cut <= 0) cut = maxWidth;
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.length > 0) lines.push(remaining);
  }
  return lines.length > 0 ? lines : [""];
}

interface ColumnSpec {
  header: string;
  cap?: number;
}

function renderTable(cols: ColumnSpec[], rows: string[][]): string {
  const wrapped: string[][][] = rows.map((row) =>
    row.map((cell, i) => {
      const cap = cols[i]?.cap;
      return cap ? wrapCell(cell, cap) : cell.split("\n");
    }),
  );

  const widths = cols.map((c, i) => {
    let w = c.header.length;
    for (const row of wrapped) {
      for (const line of row[i] ?? [""]) {
        if (line.length > w) w = line.length;
      }
    }
    return w;
  });

  const sep = "─";
  const top = `┌${widths.map((w) => sep.repeat(w + 2)).join("┬")}┐`;
  const mid = `├${widths.map((w) => sep.repeat(w + 2)).join("┼")}┤`;
  const rowSep = `├${widths.map((w) => sep.repeat(w + 2)).join("┼")}┤`;
  const bot = `└${widths.map((w) => sep.repeat(w + 2)).join("┴")}┘`;

  const fmtLine = (cells: string[]): string =>
    `│ ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" │ ")} │`;

  const out: string[] = [top, fmtLine(cols.map((c) => c.header)), mid];

  for (let r = 0; r < wrapped.length; r++) {
    const row = wrapped[r]!;
    const height = Math.max(...row.map((lines) => lines.length));
    for (let l = 0; l < height; l++) {
      out.push(fmtLine(row.map((lines) => lines[l] ?? "")));
    }
    if (r < wrapped.length - 1) out.push(rowSep);
  }
  out.push(bot);
  return out.join("\n");
}

function attribHook(h: HookRecord): string {
  if (h.plugin) return `${h.plugin.plugin}@${h.plugin.marketplace}`;
  if (h.repo) return `repo:${h.repo}`;
  return "";
}

function attribMcp(m: McpRecord): string {
  if (m.plugin) return `${m.plugin.plugin}@${m.plugin.marketplace}`;
  if (m.repo) return `repo:${m.repo}`;
  return "";
}

function mcpTransport(def: Record<string, unknown>): string {
  const t = def.type;
  if (typeof t === "string") return t;
  if (typeof def.url === "string") return "http";
  if (typeof def.command === "string") return "stdio";
  return "?";
}

function mcpDetail(def: Record<string, unknown>): string {
  if (typeof def.url === "string") return def.url;
  if (typeof def.command === "string") {
    const args = Array.isArray(def.args) ? def.args.filter((a) => typeof a === "string") : [];
    return [def.command, ...args].join(" ");
  }
  return JSON.stringify(def);
}

function sectionTitle(name: string, count: number): string {
  return `\n${name} (${count})`;
}

function renderHooks(hooks: HookRecord[]): string {
  if (hooks.length === 0) return `${sectionTitle("HOOKS", 0)}\n  (none)`;
  const cols: ColumnSpec[] = [
    { header: "Source" },
    { header: "Event" },
    { header: "Matcher" },
    { header: "Attribution" },
    { header: "Command", cap: COL_CAP.command },
  ];
  const rows = hooks.map((h) => [
    h.source,
    h.event,
    h.matcher ?? "",
    attribHook(h),
    h.command,
  ]);
  return `${sectionTitle("HOOKS", hooks.length)}\n${renderTable(cols, rows)}`;
}

function renderMcp(mcp: McpRecord[]): string {
  if (mcp.length === 0) return `${sectionTitle("MCP SERVERS", 0)}\n  (none)`;
  const cols: ColumnSpec[] = [
    { header: "Source" },
    { header: "Name", cap: COL_CAP.mcpName },
    { header: "Transport" },
    { header: "Approval" },
    { header: "Attribution" },
    { header: "Detail", cap: COL_CAP.mcpDetail },
  ];
  const rows = mcp.map((m) => [
    m.source,
    m.name,
    mcpTransport(m.definition),
    m.approvalState ?? "",
    attribMcp(m),
    mcpDetail(m.definition),
  ]);
  return `${sectionTitle("MCP SERVERS", mcp.length)}\n${renderTable(cols, rows)}`;
}

function renderEnv(env: EnvRecord[]): string {
  if (env.length === 0) return `${sectionTitle("ENV", 0)}\n  (none)`;
  const cols: ColumnSpec[] = [
    { header: "Source" },
    { header: "Repo" },
    { header: "Name" },
    { header: "Value", cap: COL_CAP.envValue },
  ];
  const rows = env.map((e) => [e.source, e.repo ?? "", e.name, e.value]);
  return `${sectionTitle("ENV", env.length)}\n${renderTable(cols, rows)}`;
}

function renderMarketplaces(markets: MarketplaceRecord[]): string {
  if (markets.length === 0) return `${sectionTitle("MARKETPLACES", 0)}\n  (none)`;
  const cols: ColumnSpec[] = [
    { header: "Source" },
    { header: "Repo" },
    { header: "Name" },
    { header: "Type" },
    { header: "Host Path", cap: COL_CAP.hostPath },
  ];
  const rows = markets.map((m) => [
    m.source,
    m.repo ?? "",
    m.name,
    m.sourceType ?? "?",
    m.hostPath ?? "",
  ]);
  return `${sectionTitle("MARKETPLACES", markets.length)}\n${renderTable(cols, rows)}`;
}

export interface FormatInspectInput {
  hooks: HookRecord[];
  mcpServers: McpRecord[];
  env: EnvRecord[];
  marketplaces: MarketplaceRecord[];
  config?: import("./configLayered.js").LayeredResult;
  codex?: {
    hostHome: string;
    config?: {
      present: boolean;
      sanitized?: string;
      warnings: Array<{ code: string; message: string; source?: string }>;
    };
    hooks?: {
      present: boolean;
      sanitized?: string;
      warnings: Array<{ code: string; message: string; source?: string }>;
    };
    auth?: {
      present: boolean;
      ok: boolean;
      kind?: string;
      warnings: Array<{ code: string; message: string; source?: string }>;
    };
    sessions?: {
      present: boolean;
      rolloutFiles: number;
    };
    warnings: Array<{ code: string; message: string; source?: string }>;
  };
}

function renderConfig(layered: import("./configLayered.js").LayeredResult): string {
  const rows: string[][] = [];
  for (const [key, val] of Object.entries(layered.merged)) {
    // hooks and mcp provenance is stored under the dotted key "<parent>.enable"
    // because mergeLayers tracks enablement arrays at that granularity.
    const provKey = key === "hooks" || key === "mcp" ? `${key}.enable` : key;
    const prov = layered.provenance[provKey];
    rows.push([
      key,
      // Object values assumed to be Record<string, string-coercible> (today only dockerBuildArg).
      Array.isArray(val)
        ? val.join(", ")
        : val !== null && typeof val === "object"
          ? Object.entries(val as Record<string, unknown>)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join("\n")
          : String(val),
      // Object values assumed to be Record<string, string-coercible> (today only dockerBuildArg).
      Array.isArray(prov)
        ? prov.join(", ")
        : prov !== null && typeof prov === "object"
          ? Object.entries(prov as Record<string, unknown>)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join("\n")
          : String(prov),
    ]);
  }
  if (rows.length === 0) return `${sectionTitle("RESOLVED CONFIG", 0)}\n  (none)`;
  return `${sectionTitle("RESOLVED CONFIG", rows.length)}\n${renderTable(
    [{ header: "key" }, { header: "value", cap: 60 }, { header: "from", cap: 40 }],
    rows,
  )}`;
}

function renderCodex(codex: NonNullable<FormatInspectInput["codex"]>): string {
  const rows: string[][] = [
    ["home", codex.hostHome],
    ["config", codex.config?.present ? "present" : "absent"],
    ["hooks", codex.hooks?.present ? "present" : "absent"],
    ["auth", codex.auth?.present ? `${codex.auth.ok ? "ok" : "unavailable"}${codex.auth.kind ? ` ${codex.auth.kind}` : ""}` : "absent"],
    ["sessions", codex.sessions?.present ? `rolloutFiles=${codex.sessions.rolloutFiles}` : "absent"],
  ];
  for (const warning of [
    ...(codex.config?.warnings ?? []),
    ...(codex.hooks?.warnings ?? []),
    ...(codex.auth?.warnings ?? []),
    ...codex.warnings,
  ]) {
    rows.push(["warning", warning.message]);
  }
  return `${sectionTitle("CODEX", rows.length)}\n${renderTable(
    [{ header: "key" }, { header: "value", cap: 80 }],
    rows,
  )}`;
}

export function formatInspectPretty(input: FormatInspectInput): string {
  const parts = [
    renderHooks(input.hooks),
    renderMcp(input.mcpServers),
    renderEnv(input.env),
    renderMarketplaces(input.marketplaces),
  ];
  if (input.config) {
    parts.push(renderConfig(input.config));
  }
  if (input.codex) {
    parts.push(renderCodex(input.codex));
  }
  parts.push("");
  return parts.join("\n");
}
