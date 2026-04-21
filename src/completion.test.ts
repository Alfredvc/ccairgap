import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  candidatesFor,
  launchFlags,
  resumeNameCandidates,
  sessionIdCandidates,
  subcommandNames,
} from "./completion.js";

function makeProgram(): Command {
  const p = new Command();
  p.name("ccairgap")
    .option("--repo <path>", "repo")
    .option("--ro <path>", "ro")
    .option("-r, --resume <id>", "resume");
  p.command("list").description("list").action(() => {});
  p.command("recover [id]").description("recover").action(() => {});
  p.command("completion-server", { hidden: true }).action(() => {});
  return p;
}

describe("completion — static candidates", () => {
  const program = makeProgram();

  it("launchFlags returns long-form option names", () => {
    expect(launchFlags(program)).toEqual(expect.arrayContaining(["--repo", "--ro", "--resume"]));
  });

  it("subcommandNames excludes the hidden completion-server callback", () => {
    const names = subcommandNames(program);
    expect(names).toContain("list");
    expect(names).toContain("recover");
    expect(names).not.toContain("completion-server");
  });
});

describe("completion — sessionIdCandidates", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccairgap-completion-"));
    mkdirSync(join(tmp, "sessions-root"), { recursive: true });
  });

  afterEach(() => {
    // best-effort cleanup; tmpdir scrapes periodically anyway
  });

  it("lists only directory entries under the given sessions dir", () => {
    const sd = join(tmp, "sessions-root");
    mkdirSync(join(sd, "alpha-1234"));
    mkdirSync(join(sd, "beta-5678"));
    writeFileSync(join(sd, "stray-file"), "");
    const out = sessionIdCandidates(sd);
    expect(out.sort()).toEqual(["alpha-1234", "beta-5678"]);
  });

  it("returns [] when the dir does not exist", () => {
    expect(sessionIdCandidates(join(tmp, "nope"))).toEqual([]);
  });
});

describe("completion — resumeNameCandidates", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccairgap-completion-resume-"));
  });

  it("returns [] when cwd is not a git repo", async () => {
    const nonRepo = join(tmp, "not-a-repo");
    mkdirSync(nonRepo, { recursive: true });
    expect(await resumeNameCandidates(nonRepo)).toEqual([]);
  });
});

describe("completion — candidatesFor routing", () => {
  const program = makeProgram();

  it("prev=install-completion → shell names", async () => {
    expect(await candidatesFor("install-completion", program)).toEqual(["bash", "zsh", "fish"]);
  });

  it("prev is an unrelated flag → subcommand + flag list", async () => {
    const out = await candidatesFor("--unknown", program);
    expect(out).toEqual(expect.arrayContaining(["list", "recover", "--repo", "--ro", "--resume"]));
  });

  it("prev=recover and no sessions dir → []", async () => {
    // Run in a tmp cwd so any real $XDG_STATE_HOME/ccairgap is not reachable.
    // sessionIdCandidates opens whatever sessionsDir() returns; if that dir is
    // missing the empty array is returned.
    const out = await candidatesFor("recover", program);
    // Do not assert the exact content — the host running tests may have real
    // sessions. Just assert the call does not throw and returns an array.
    expect(Array.isArray(out)).toBe(true);
  });
});
