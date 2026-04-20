import { describe, it, expect, vi } from "vitest";
import { refreshIfLowTtl } from "./authRefresh.js";

function makeCreds(partial: {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: partial.accessToken ?? "at-initial",
      refreshToken: partial.refreshToken ?? "rt-initial",
      expiresAt: partial.expiresAt,
      scopes: partial.scopes ?? ["user:inference"],
    },
  });
}

const REFRESH_BELOW_MS = 2 * 60 * 60 * 1000; // 2h

describe("refreshIfLowTtl", () => {
  it("ttl above threshold → action: fresh, no lock or exec", async () => {
    const now = 1_000_000_000_000;
    const json = makeCreds({ expiresAt: now + 8 * 60 * 60 * 1000 });
    const acquireLock = vi.fn();
    const runAuthLogin = vi.fn();
    const readCreds = vi.fn().mockResolvedValue(json);

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("fresh");
    expect(acquireLock).not.toHaveBeenCalled();
    expect(runAuthLogin).not.toHaveBeenCalled();
    expect(readCreds).toHaveBeenCalledTimes(1);
  });

  it("ttl below threshold → refresh ok, action: refreshed", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const fresh = makeCreds({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: now + 8 * 60 * 60 * 1000,
    });
    const readCreds = vi
      .fn()
      .mockResolvedValueOnce(stale) // pre-lock
      .mockResolvedValueOnce(stale) // in-lock
      .mockResolvedValueOnce(fresh); // post-refresh
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireLock = vi.fn().mockResolvedValue(release);
    const runAuthLogin = vi.fn().mockResolvedValue(undefined);

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("refreshed");
    expect(result.finalJson).toBe(fresh);
    expect(acquireLock).toHaveBeenCalledOnce();
    expect(runAuthLogin).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();

    // env carries the refresh token + scopes.
    const env = runAuthLogin.mock.calls[0]?.[0] as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("rt-initial");
    expect(env.CLAUDE_CODE_OAUTH_SCOPES).toBe("user:inference");
  });

  it("benign race-loss: another writer refreshed while we waited → already-fresh", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const fresh = makeCreds({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: now + 8 * 60 * 60 * 1000,
    });
    const readCreds = vi
      .fn()
      .mockResolvedValueOnce(stale) // pre-lock
      .mockResolvedValueOnce(fresh); // in-lock (someone else refreshed)
    const release = vi.fn().mockResolvedValue(undefined);
    const acquireLock = vi.fn().mockResolvedValue(release);
    const runAuthLogin = vi.fn();

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("already-fresh");
    expect(runAuthLogin).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("failure: invalid_grant → classification revoked", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const readCreds = vi.fn().mockResolvedValue(stale);
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const runAuthLogin = vi.fn().mockRejectedValue(
      Object.assign(new Error("exit 1"), {
        stderr: "Error: invalid_grant\n  at …",
      }),
    );

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.classification).toBe("revoked");
      expect(result.reason).toBe("refresh token revoked");
    }
  });

  it("failure: network error on stderr → classification network", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const readCreds = vi.fn().mockResolvedValue(stale);
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const runAuthLogin = vi.fn().mockRejectedValue(
      Object.assign(new Error("exit 1"), {
        stderr: "getaddrinfo ENOTFOUND platform.claude.com",
      }),
    );

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.classification).toBe("network");
  });

  it("failure: ENOENT → classification binary-missing", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const readCreds = vi.fn().mockResolvedValue(stale);
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const runAuthLogin = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.classification).toBe("binary-missing");
  });

  it("failure: timedOut → classification timeout", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const readCreds = vi.fn().mockResolvedValue(stale);
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const runAuthLogin = vi.fn().mockRejectedValue(
      Object.assign(new Error("timeout"), { timedOut: true }),
    );

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.classification).toBe("timeout");
  });

  it("failure: unknown exit → stderr first line truncated to 120 chars", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const readCreds = vi.fn().mockResolvedValue(stale);
    const acquireLock = vi.fn().mockResolvedValue(vi.fn());
    const longFirstLine = "E".repeat(200);
    const runAuthLogin = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("exit 7"), {
          stderr: `${longFirstLine}\nsecond`,
        }),
      );

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.classification).toBe("unknown");
      expect(result.reason.length).toBe(120);
    }
  });

  it("refreshBelowMs=0 disables refresh even at low ttl", async () => {
    const now = 1_000_000_000_000;
    const stale = makeCreds({ expiresAt: now + 60 * 1000 });
    const acquireLock = vi.fn();
    const runAuthLogin = vi.fn();
    const readCreds = vi.fn().mockResolvedValue(stale);

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: 0,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("fresh");
    expect(acquireLock).not.toHaveBeenCalled();
    expect(runAuthLogin).not.toHaveBeenCalled();
  });

  it("missing expiresAt → NaN ttl, skip refresh, action: fresh", async () => {
    const now = 1_000_000_000_000;
    const json = JSON.stringify({ claudeAiOauth: { accessToken: "at" } });
    const acquireLock = vi.fn();
    const runAuthLogin = vi.fn();
    const readCreds = vi.fn().mockResolvedValue(json);

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("fresh");
    expect(Number.isNaN(result.finalTtlMs)).toBe(true);
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it("missing refreshToken → no refresh attempt even when ttl low", async () => {
    const now = 1_000_000_000_000;
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: "at", expiresAt: now + 60 * 1000 },
    });
    const acquireLock = vi.fn();
    const runAuthLogin = vi.fn();
    const readCreds = vi.fn().mockResolvedValue(json);

    const result = await refreshIfLowTtl({
      lockPath: "/tmp/claude",
      refreshBelowMs: REFRESH_BELOW_MS,
      readCreds,
      acquireLock,
      runAuthLogin,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("fresh");
    expect(acquireLock).not.toHaveBeenCalled();
    expect(runAuthLogin).not.toHaveBeenCalled();
  });
});
