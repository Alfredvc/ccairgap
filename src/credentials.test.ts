import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  stripRefreshToken,
  CredentialsDeadError,
  resolveCredentials,
} from "./credentials.js";
import * as authRefresh from "./authRefresh.js";

describe("stripRefreshToken", () => {
  it("removes claudeAiOauth.refreshToken and preserves other fields", () => {
    const input = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1_700_000_000_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
        rateLimitTier: "tier1",
      },
      other: { kept: true },
    });
    const out = JSON.parse(stripRefreshToken(input));
    expect(out.claudeAiOauth.refreshToken).toBeUndefined();
    expect(out.claudeAiOauth.accessToken).toBe("at");
    expect(out.claudeAiOauth.expiresAt).toBe(1_700_000_000_000);
    expect(out.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(out.claudeAiOauth.subscriptionType).toBe("max");
    expect(out.claudeAiOauth.rateLimitTier).toBe("tier1");
    expect(out.other).toEqual({ kept: true });
  });

  it("no-op when refreshToken absent", () => {
    const input = JSON.stringify({
      claudeAiOauth: { accessToken: "at" },
    });
    const out = JSON.parse(stripRefreshToken(input));
    expect(out.claudeAiOauth.accessToken).toBe("at");
    expect("refreshToken" in out.claudeAiOauth).toBe(false);
  });

  it("returns input unchanged on parse failure", () => {
    const input = "not json{";
    expect(stripRefreshToken(input)).toBe(input);
  });

  it("returns input unchanged when claudeAiOauth is not an object", () => {
    const input = JSON.stringify({ claudeAiOauth: "oops" });
    const out = JSON.parse(stripRefreshToken(input));
    expect(out.claudeAiOauth).toBe("oops");
  });
});

describe("CredentialsDeadError", () => {
  it("carries classification + finalTtlMs", () => {
    const e = new CredentialsDeadError("refresh token revoked", "revoked", 10_000);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("CredentialsDeadError");
    expect(e.message).toBe("refresh token revoked");
    expect(e.classification).toBe("revoked");
    expect(e.finalTtlMs).toBe(10_000);
  });
});

// macOS keychain path needs `security` on PATH and a real keychain entry,
// which isn't available in CI. Skip these under darwin — the strip / refresh
// logic under test is platform-agnostic anyway.
describe.skipIf(platform() === "darwin")("resolveCredentials", () => {
  let tmpHome: string;
  let sessionDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ccairgap-creds-"));
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    sessionDir = join(tmpHome, "session");
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeHostCreds(obj: unknown): void {
    writeFileSync(join(tmpHome, ".claude", ".credentials.json"), JSON.stringify(obj));
  }

  it("hard-fails when refresh fails + final ttl < 5 min (no session state mutated)", async () => {
    const now = Date.now();
    writeHostCreds({
      claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: now + 60_000 },
    });
    vi.spyOn(authRefresh, "refreshIfLowTtl").mockResolvedValue({
      ok: false,
      reason: "refresh token revoked",
      classification: "revoked",
      finalJson: "{}",
      finalTtlMs: 60_000,
    });

    await expect(
      resolveCredentials(sessionDir, { refreshBelowMs: 2 * 60 * 60 * 1000 }),
    ).rejects.toMatchObject({
      name: "CredentialsDeadError",
      message: "refresh token revoked",
      classification: "revoked",
      finalTtlMs: 60_000,
    });

    // No session-dir side effects.
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("hard-fails on cold-start-dead even when refresh disabled (--refresh-below-ttl 0)", async () => {
    const now = Date.now();
    writeHostCreds({
      claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: now + 60_000 },
    });
    vi.spyOn(authRefresh, "refreshIfLowTtl").mockResolvedValue({
      ok: true,
      action: "fresh",
      finalJson: JSON.stringify({
        claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: now + 60_000 },
      }),
      finalTtlMs: 60_000,
    });

    await expect(
      resolveCredentials(sessionDir, { refreshBelowMs: 0 }),
    ).rejects.toMatchObject({
      name: "CredentialsDeadError",
      classification: "expired",
    });
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("soft-fail surfaces via refreshResult; session creds file still written + stripped", async () => {
    const now = Date.now();
    const freshJson = JSON.stringify({
      claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: now + 60 * 60 * 1000 },
    });
    writeHostCreds(JSON.parse(freshJson));
    vi.spyOn(authRefresh, "refreshIfLowTtl").mockResolvedValue({
      ok: false,
      reason: "network error contacting Anthropic",
      classification: "network",
      finalJson: freshJson,
      finalTtlMs: 60 * 60 * 1000,
    });

    const result = await resolveCredentials(sessionDir, { refreshBelowMs: 2 * 60 * 60 * 1000 });
    expect(result.refreshResult.ok).toBe(false);
    expect(result.finalTtlMs).toBe(60 * 60 * 1000);
    expect(existsSync(result.hostPath)).toBe(true);

    const onDisk = JSON.parse(readFileSync(result.hostPath, "utf8"));
    expect(onDisk.claudeAiOauth.refreshToken).toBeUndefined();
    expect(onDisk.claudeAiOauth.accessToken).toBe("at");
  });

  it("success: strips refreshToken, returns session path, origin=file on linux", async () => {
    const now = Date.now();
    const hostJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: now + 8 * 60 * 60 * 1000,
      },
    });
    writeHostCreds(JSON.parse(hostJson));
    vi.spyOn(authRefresh, "refreshIfLowTtl").mockResolvedValue({
      ok: true,
      action: "fresh",
      finalJson: hostJson,
      finalTtlMs: 8 * 60 * 60 * 1000,
    });

    const result = await resolveCredentials(sessionDir, { refreshBelowMs: 120 * 60 * 1000 });
    expect(result.hostPath).toBe(join(sessionDir, "creds", ".credentials.json"));
    expect(result.origin).toBe("file");
    expect(result.refreshResult.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.hostPath, "utf8"));
    expect(onDisk.claudeAiOauth.refreshToken).toBeUndefined();
    expect(onDisk.claudeAiOauth.accessToken).toBe("at");
  });

  it("rejects missing claudeAiOauth before calling refresh", async () => {
    writeHostCreds({});
    const refreshSpy = vi.spyOn(authRefresh, "refreshIfLowTtl");

    await expect(
      resolveCredentials(sessionDir, { refreshBelowMs: 120 * 60 * 1000 }),
    ).rejects.toThrow(/claudeAiOauth/);
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(existsSync(sessionDir)).toBe(false);
  });
});
