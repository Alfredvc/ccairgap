import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { execa } from "execa";
import {
  mkTmpHome,
  seedGitRepo,
  seedClaudeHome,
  seedHostCreds,
  cleanupContainers,
} from "../helpers/env";
import { dockerAvailable } from "../helpers/dockerAvailable";
import { assertBranchExists, assertSessionDirRemoved, testCmd } from "../helpers/assertions";

const FAKE_DOCKERFILE = "e2e/fixtures/fake.Dockerfile";
const DIST_CLI = path.resolve("dist/cli.js");
const NODE_OPTIONS = `--require ${path.resolve("e2e/helpers/force-linux.cjs")}`;

// exec replaces the shell, so PID 1 is sleep. It ignores SIGTERM as PID 1, which
// is the slow case: `docker stop` waits for its grace period and then kills it.
const WORK = [
  'git -c user.email=t@t -c user.name=t commit --allow-empty -m "work" >/dev/null',
  "touch /tmp/ready",
  "exec sleep 300",
].join(" && ");

describe.skipIf(!(await dockerAvailable()))("signal handoff", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCreds(home);
    repo = await seedGitRepo(home, "myapp");
  });

  afterEach(async () => {
    for (const id of sessionIds()) await cleanupContainers(id);
    await cleanup();
  });

  function sessionIds(): string[] {
    try {
      return readdirSync(path.join(ccairgapHome, "sessions"));
    } catch {
      return [];
    }
  }

  async function startSession() {
    const cli = execa(
      "node",
      [
        DIST_CLI,
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty",
        "--print", "x",
        ...testCmd(WORK),
      ],
      {
        env: { ...process.env, HOME: home, CCAIRGAP_HOME: ccairgapHome, NODE_OPTIONS },
        reject: false,
        stdio: "ignore",
        // execa otherwise sends SIGKILL 5 s after a SIGTERM, and `docker stop` takes 10 s here.
        forceKillAfterDelay: false,
      },
    );
    return { cli, id: await waitReady() };
  }

  async function waitReady(): Promise<string> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const id = sessionIds()[0];
      if (id) {
        const ready = await execa("docker", ["exec", `ccairgap-${id}`, "test", "-f", "/tmp/ready"], {
          reject: false,
        });
        if (ready.exitCode === 0) return id;
      }
      if (Date.now() > deadline) throw new Error("session did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const containerExists = async (id: string) =>
    (
      await execa("docker", ["ps", "-a", "-q", "--filter", `name=^/ccairgap-${id}$`])
    ).stdout.trim() !== "";

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    it(`${signal} stops the container, runs handoff, and ends with the signal`, async () => {
      const { cli, id } = await startSession();
      cli.kill(signal);
      const ended = await cli;

      expect({ signal: ended.signal, code: ended.exitCode }).toEqual({ signal, code: undefined });
      await assertBranchExists(repo, new RegExp(`^ccairgap/${id}$`));
      await assertSessionDirRemoved(ccairgapHome, id);
      expect(await containerExists(id)).toBe(false);
    }, 200_000);
  }

  it("SIGTERM in TTY mode stops the container, which `docker run` does not do there", async () => {
    // Runs the CLI on a pseudo-terminal, so the CLI passes -it to `docker run`.
    const PTY = [
      "import os, pty, sys",
      "pid, fd = pty.fork()",
      "if pid == 0:",
      "    os.execvp(sys.argv[1], sys.argv[1:])",
      "print(pid, flush=True)",
      "while True:",
      "    try:",
      "        if not os.read(fd, 65536): break",
      "    except OSError:",
      "        break",
      "_, status = os.waitpid(pid, 0)",
      'print("signal", os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0, flush=True)',
    ].join("\n");
    const cli = execa(
      "python3",
      ["-I", "-c", PTY, "node", DIST_CLI, "--repo", repo, "--dockerfile", FAKE_DOCKERFILE, "--no-preserve-dirty", ...testCmd(WORK)],
      { env: { ...process.env, HOME: home, CCAIRGAP_HOME: ccairgapHome, NODE_OPTIONS }, reject: false, buffer: true },
    );
    const pid = await new Promise<number>((resolve) => {
      cli.stdout!.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
    });
    const id = await waitReady();
    expect(await execa("docker", ["inspect", "-f", "{{.Config.Tty}}", `ccairgap-${id}`]).then((r) => r.stdout)).toBe("true");

    process.kill(pid, "SIGTERM");
    const ended = await cli;

    expect(String(ended.stdout)).toContain("signal 15");
    await assertBranchExists(repo, new RegExp(`^ccairgap/${id}$`));
    await assertSessionDirRemoved(ccairgapHome, id);
    expect(await containerExists(id)).toBe(false);
  }, 200_000);

  it("a second signal exits at once, kills the container, and keeps the session", async () => {
    const { cli, id } = await startSession();
    cli.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1_000));
    const secondAt = Date.now();
    cli.kill("SIGTERM");
    const ended = await cli;

    expect(ended.signal).toBe("SIGTERM");
    // `docker stop` alone waits 10 s for this PID 1.
    expect(Date.now() - secondAt).toBeLessThan(5_000);
    expect(sessionIds()).toContain(id);
    const deadline = Date.now() + 15_000;
    while ((await containerExists(id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await containerExists(id)).toBe(false);
  }, 200_000);
});
