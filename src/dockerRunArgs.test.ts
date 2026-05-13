import { describe, expect, it } from "vitest";
import {
  formatDangerWarnings,
  parseDockerRunArgs,
  scanDangerousArgs,
  validateIntegrationDockerRunArgs,
} from "./dockerRunArgs.js";

describe("parseDockerRunArgs", () => {
  it("splits a single value on whitespace", () => {
    expect(parseDockerRunArgs(["-p 8080:8080"])).toEqual(["-p", "8080:8080"]);
  });

  it("preserves quoted tokens with spaces", () => {
    expect(parseDockerRunArgs(['--label "key=value with space"'])).toEqual([
      "--label",
      "key=value with space",
    ]);
  });

  it("concatenates multiple values in order", () => {
    expect(
      parseDockerRunArgs(["-p 8080:8080", "-e FOO=bar", "--network my-net"]),
    ).toEqual(["-p", "8080:8080", "-e", "FOO=bar", "--network", "my-net"]);
  });

  it("preserves user-provided volume tokens in order for docker's later last-wins handling", () => {
    expect(
      parseDockerRunArgs([
        "-v /override-codex:/home/claude/.codex:rw",
        "--mount type=bind,src=/tmp/out,dst=/output",
      ]),
    ).toEqual([
      "-v",
      "/override-codex:/home/claude/.codex:rw",
      "--mount",
      "type=bind,src=/tmp/out,dst=/output",
    ]);
  });

  it("rejects shell operators", () => {
    expect(() => parseDockerRunArgs(["-p 8080 && rm -rf /"])).toThrow(
      /unsupported shell construct/,
    );
  });

  it("accepts empty input", () => {
    expect(parseDockerRunArgs([])).toEqual([]);
  });
});

describe("scanDangerousArgs", () => {
  it("flags --privileged", () => {
    const hits = scanDangerousArgs(["--privileged"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.token).toBe("--privileged");
  });

  it("flags --cap-add SYS_ADMIN (two-token form)", () => {
    const hits = scanDangerousArgs(["--cap-add", "SYS_ADMIN"]);
    // both --cap-add and the SYS_ADMIN token get flagged — intentional
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.token.startsWith("--cap-add"))).toBe(true);
  });

  it("flags --network=host and --network host", () => {
    expect(scanDangerousArgs(["--network=host"])).toHaveLength(1);
    expect(scanDangerousArgs(["--network", "host"])).toEqual([
      { token: "--network host", reason: expect.any(String) },
    ]);
  });

  it("flags --pid=host, --userns=host, --ipc=host", () => {
    for (const tok of ["--pid=host", "--userns=host", "--ipc=host"]) {
      expect(scanDangerousArgs([tok])).toHaveLength(1);
    }
  });

  it("does not flag --network=my-net (not host)", () => {
    expect(scanDangerousArgs(["--network=my-net"])).toEqual([]);
  });

  it("flags docker.sock bind", () => {
    const hits = scanDangerousArgs(["-v", "/var/run/docker.sock:/var/run/docker.sock"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reason).toMatch(/docker daemon/);
  });

  it("flags --cap-drop narrower than ALL", () => {
    expect(scanDangerousArgs(["--cap-drop", "NET_ADMIN"])).toHaveLength(1);
    expect(scanDangerousArgs(["--cap-drop=NET_ADMIN"])).toHaveLength(1);
    expect(scanDangerousArgs(["--cap-drop=ALL"])).toEqual([]);
  });

  it("returns no hits for plain port publish / env", () => {
    expect(scanDangerousArgs(["-p", "8080:8080", "-e", "FOO=bar"])).toEqual([]);
  });
});

describe("formatDangerWarnings", () => {
  it("mentions suppression flag", () => {
    const lines = formatDangerWarnings([{ token: "--privileged", reason: "grants all" }]);
    expect(lines[0]).toMatch(/--no-warn-docker-args/);
    expect(lines[0]).toMatch(/--privileged/);
  });
});

describe("validateIntegrationDockerRunArgs", () => {
  it("accepts -e KEY=VAL, --env KEY=VAL, --env=KEY=VAL", () => {
    expect(() =>
      validateIntegrationDockerRunArgs(
        ["-e", "FOO=1", "--env", "BAR=2", "--env=BAZ=3"],
        "switchboard.yaml",
      ),
    ).not.toThrow();
  });

  it("accepts --add-host, --label, --dns, --dns-search", () => {
    expect(() =>
      validateIntegrationDockerRunArgs(
        ["--add-host", "x:1.2.3.4", "--label", "k=v", "--dns", "8.8.8.8", "--dns-search", "ex.com"],
        "f.yaml",
      ),
    ).not.toThrow();
  });

  it("rejects --privileged", () => {
    expect(() =>
      validateIntegrationDockerRunArgs(["--privileged"], "f.yaml"),
    ).toThrow(/flag '--privileged' not in safe allowlist/);
  });

  it("rejects -v / --volume / --mount", () => {
    for (const flag of ["-v", "--volume", "--mount"]) {
      expect(() =>
        validateIntegrationDockerRunArgs([flag, "/:/host"], "f.yaml"),
      ).toThrow(/not in safe allowlist/);
    }
  });

  it("rejects --user, --name, --entrypoint, --cap-add, --network", () => {
    for (const flag of ["--user", "--name", "--entrypoint", "--cap-add", "--network"]) {
      expect(() =>
        validateIntegrationDockerRunArgs([flag, "x"], "f.yaml"),
      ).toThrow(/not in safe allowlist/);
    }
  });

  it("accepts -e KEY (bare form, host env passthrough)", () => {
    expect(() =>
      validateIntegrationDockerRunArgs(
        ["-e", "TMUX_PANE", "--env", "DISPLAY", "--env=USER"],
        "f.yaml",
      ),
    ).not.toThrow();
  });

  it("rejects -e KEY when KEY is not a valid env var name", () => {
    for (const bad of ["1FOO", "FOO-BAR", "FOO BAR", "", "FOO.BAR"]) {
      expect(() =>
        validateIntegrationDockerRunArgs(["-e", bad], "f.yaml"),
      ).toThrow(/bare form \(host env passthrough\) requires a POSIX env var name/);
    }
  });

  it("error message names the source file", () => {
    expect(() =>
      validateIntegrationDockerRunArgs(["--privileged"], "switchboard.yaml"),
    ).toThrow(/switchboard\.yaml/);
  });
});
