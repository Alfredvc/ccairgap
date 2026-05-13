import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  CodexAuthError,
  planCodexAuth,
  sanitizeCodexAuthJson,
  writeCodexSessionAuth,
} from "./codexAuth.js";

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}

describe("sanitizeCodexAuthJson", () => {
  const now = Date.parse("2026-05-13T00:00:00.000Z");

  it("preserves only OPENAI_API_KEY for API-key file auth", () => {
    const result = sanitizeCodexAuthJson({
      selected: true,
      nowMs: now,
      json: JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: { refresh_token: "drop" } }),
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.authJson ?? "{}")).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("sanitizes ChatGPT token auth by blanking refresh_token", () => {
    const result = sanitizeCodexAuthJson({
      selected: true,
      nowMs: now,
      json: JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-05-12T00:00:00.000Z",
        tokens: {
          id_token: jwt({ plan_type: "Plus" }),
          access_token: jwt({ exp: Math.floor((now + 60 * 60 * 1000) / 1000) }),
          refresh_token: "secret-refresh",
          account_id: "acct",
        },
      }),
    });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.authJson ?? "{}");
    expect(parsed.tokens.refresh_token).toBe("");
    expect(parsed.tokens.access_token).toContain(".");
    expect(parsed.last_refresh).toBe("2026-05-12T00:00:00.000Z");
  });

  it("rejects selected near-expired access tokens", () => {
    expect(() =>
      sanitizeCodexAuthJson({
        selected: true,
        nowMs: now,
        json: JSON.stringify({
          last_refresh: "2026-05-12T00:00:00.000Z",
          tokens: {
            id_token: jwt({ plan_type: "Plus" }),
            access_token: jwt({ exp: Math.floor((now + 60_000) / 1000) }),
            refresh_token: "secret",
          },
        }),
      }),
    ).toThrow(/safety buffer/);
  });

  it("rejects selected stale last_refresh when access expiry cannot be parsed", () => {
    expect(() =>
      sanitizeCodexAuthJson({
        selected: true,
        nowMs: now,
        json: JSON.stringify({
          last_refresh: "2026-05-04T00:00:00.000Z",
          tokens: {
            id_token: jwt({ plan_type: "Plus" }),
            access_token: "opaque",
            refresh_token: "secret",
          },
        }),
      }),
    ).toThrow(/last_refresh is too old/);
  });

  it("rejects selected agent_identity but reports advisory warning when not selected", () => {
    const json = JSON.stringify({ agent_identity: { private_key: "secret" } });

    expect(() => sanitizeCodexAuthJson({ selected: true, json, nowMs: now })).toThrow(
      CodexAuthError,
    );
    const advisory = sanitizeCodexAuthJson({ selected: false, json, nowMs: now });
    expect(advisory.ok).toBe(false);
    expect(advisory.warnings[0]?.code).toBe("unsupported-agent-identity");
  });

  it("fails closed for managed and unknown ChatGPT file auth", () => {
    for (const idPayload of [{ plan_type: "Business" }, {}]) {
      expect(() =>
        sanitizeCodexAuthJson({
          selected: true,
          nowMs: now,
          json: JSON.stringify({
            last_refresh: "2026-05-12T00:00:00.000Z",
            tokens: {
              id_token: jwt(idPayload),
              access_token: jwt({ exp: Math.floor((now + 60 * 60 * 1000) / 1000) }),
              refresh_token: "secret",
            },
          }),
        }),
      ).toThrow(CodexAuthError);
    }
  });
});

describe("planCodexAuth and writes", () => {
  let root: string;
  let home: string;
  let session: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccairgap-codex-auth-"));
    home = join(root, "codex");
    session = join(root, "session");
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("selected keyring and missing file auth are fatal", () => {
    expect(() =>
      planCodexAuth({ hostHome: home, selected: true, credentialsStore: "keyring" }),
    ).toThrow(/keyring/);
    expect(() =>
      planCodexAuth({ hostHome: home, selected: true, credentialsStore: "file" }),
    ).toThrow(/missing/);
  });

  it("non-selected missing file auth is advisory", () => {
    const result = planCodexAuth({ hostHome: home, selected: false });
    expect(result.ok).toBe(false);
    expect(result.warnings[0]?.code).toBe("missing-auth-json");
  });

  it("writes session auth as 0600", () => {
    writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    const plan = planCodexAuth({ hostHome: home, selected: true });
    const path = writeCodexSessionAuth(session, plan.authJson ?? "");

    expect(readFileSync(path, "utf8")).toContain("sk-test");
    if (platform() !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
