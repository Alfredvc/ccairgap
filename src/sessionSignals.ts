import { execa, execaSync } from "execa";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const STOP_RETRY_MS = 1_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;

export interface SessionSignalInput {
  id: string;
  /** Runs on a second signal, before the CLI exits. */
  onForceExit?: () => void;
}

export interface SessionSignals {
  /** Tells the handler that `docker run` returned. */
  runExited(): void;
  /** Resolves when no container can still be running after a signal. */
  containerStopped(): Promise<void>;
  /** The first signal, if one arrived. */
  received(): NodeJS.Signals | undefined;
  release(): void;
}

/**
 * Turns a signal to the CLI into a normal session end, so the caller's `finally`
 * runs handoff. Without a listener, Node dies on the signal before `finally`.
 *
 * `docker run` does not end the container by itself. It forwards no signal in TTY
 * mode, and a SIGHUP can kill it while the container runs. Handoff must not race a
 * live container, so the first signal runs `docker stop` until it succeeds. The
 * retry covers a signal that arrives before the container exists. A second signal
 * kills the container and exits, and the session stays on disk for `recover`.
 */
export function installSessionSignals(input: SessionSignalInput): SessionSignals {
  const container = `ccairgap-${input.id}`;
  let first: NodeJS.Signals | undefined;
  let exited = false;
  let stopped: Promise<void> = Promise.resolve();

  const stop = async (): Promise<void> => {
    for (;;) {
      const result = await execa("docker", ["stop", container], { reject: false, stdio: "ignore" });
      if (result.exitCode === 0 || exited) return;
      await new Promise((r) => setTimeout(r, STOP_RETRY_MS));
    }
  };

  const release = (): void => {
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (first !== undefined) {
      release();
      execaSync("docker", ["kill", container], {
        reject: false,
        stdio: "ignore",
        timeout: FORCE_KILL_TIMEOUT_MS,
      });
      input.onForceExit?.();
      console.error(`ccairgap: exiting without handoff. Finish it with: ccairgap recover ${input.id}`);
      process.kill(process.pid, signal);
      return;
    }
    first = signal;
    // The terminal may be gone after a SIGHUP, and a failed write must not end the handoff.
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
    console.error(
      `\nccairgap: received ${signal}. Stopping the container, then running handoff. Send it again to exit at once.`,
    );
    stopped = stop();
  };

  for (const s of SIGNALS) process.on(s, onSignal);

  return {
    runExited() {
      exited = true;
    },
    containerStopped: () => stopped,
    received: () => first,
    release,
  };
}
