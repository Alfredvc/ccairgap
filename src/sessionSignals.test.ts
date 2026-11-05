import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const execaMock = vi.fn();
const execaSyncMock = vi.fn();
vi.mock("execa", () => ({ execa: execaMock, execaSync: execaSyncMock }));

const { installSessionSignals } = await import("./sessionSignals.js");

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const STOP = ["stop", "ccairgap-s1"];

let stderr: string[];
let kill: MockInstance<typeof process.kill>;
let handle: ReturnType<typeof installSessionSignals> | undefined;

/** Installs the handler and returns the listener that it added for the signal. */
function install(signal: NodeJS.Signals, onForceExit?: () => void) {
  const existing = new Set(process.listeners(signal));
  handle = installSessionSignals({ id: "s1", onForceExit });
  const listener = process.listeners(signal).find((l) => !existing.has(l));
  expect(listener).toBeDefined();
  return { signals: handle, fire: () => (listener as (s: NodeJS.Signals) => void)(signal) };
}

beforeEach(() => {
  stderr = [];
  execaMock.mockReset();
  execaSyncMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0 });
  vi.spyOn(console, "error").mockImplementation((...a) => void stderr.push(a.join(" ")));
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  handle?.release();
  handle = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("installSessionSignals", () => {
  it.each(SIGNALS)("the first %s stops the container and does not end the process", async (signal) => {
    const { signals, fire } = install(signal);
    expect(signals.received()).toBeUndefined();

    fire();
    await signals.containerStopped();

    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(execaMock).toHaveBeenCalledWith("docker", STOP, expect.anything());
    expect(signals.received()).toBe(signal);
    expect(kill).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain(`received ${signal}`);
  });

  it("does nothing without a signal", async () => {
    const { signals } = install("SIGTERM");
    signals.runExited();
    await signals.containerStopped();
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("retries until the container exists and stops", async () => {
    vi.useFakeTimers();
    execaMock.mockResolvedValueOnce({ exitCode: 1 }).mockResolvedValueOnce({ exitCode: 1 });
    const { signals, fire } = install("SIGTERM");

    fire();
    await vi.advanceTimersByTimeAsync(2_000);
    await signals.containerStopped();

    expect(execaMock).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once docker run has returned", async () => {
    vi.useFakeTimers();
    execaMock.mockResolvedValue({ exitCode: 1 });
    const { signals, fire } = install("SIGTERM");

    fire();
    await vi.advanceTimersByTimeAsync(0);
    signals.runExited();
    await vi.advanceTimersByTimeAsync(1_000);
    await signals.containerStopped();

    expect(execaMock).toHaveBeenCalledTimes(2);
  });

  it("waits for a stop in progress even after docker run returned", async () => {
    // A SIGHUP can kill `docker run` while the container still runs.
    let finish!: (v: { exitCode: number }) => void;
    execaMock.mockReturnValue(new Promise((r) => (finish = r)));
    const { signals, fire } = install("SIGHUP");

    fire();
    signals.runExited();
    let done = false;
    void signals.containerStopped().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);

    finish({ exitCode: 0 });
    await signals.containerStopped();
    expect(done).toBe(true);
  });

  it("a second signal kills the container, cleans up, and re-raises that signal", async () => {
    const order: string[] = [];
    execaSyncMock.mockImplementation((_c: string, args: string[]) => void order.push(args.join(" ")));
    kill.mockImplementation(() => {
      order.push("raise");
      return true;
    });
    const { signals, fire } = install("SIGINT", () => order.push("force"));
    const listener = process.listeners("SIGINT").at(-1);

    fire();
    await signals.containerStopped();
    fire();

    expect(order).toEqual(["kill ccairgap-s1", "force", "raise"]);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(process.listeners("SIGINT")).not.toContain(listener);
    expect(stderr.join("\n")).toContain("ccairgap recover s1");
  });

  it("bounds the docker kill, because a stuck daemon must not block the exit", async () => {
    const { signals, fire } = install("SIGTERM");
    fire();
    await signals.containerStopped();
    fire();
    expect(execaSyncMock.mock.calls[0]![2]).toMatchObject({ reject: false, timeout: 5_000 });
  });

  it("removes its listeners on release", () => {
    const before = SIGNALS.map((s) => process.listenerCount(s));
    const signals = installSessionSignals({ id: "s1" });
    expect(SIGNALS.map((s) => process.listenerCount(s))).toEqual(before.map((n) => n + 1));
    signals.release();
    expect(SIGNALS.map((s) => process.listenerCount(s))).toEqual(before);
  });
});
