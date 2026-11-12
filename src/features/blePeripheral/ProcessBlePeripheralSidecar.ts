import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod/v4";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  createExitTracker,
  waitForExit,
  type ProcessTracker,
} from "../../utils/ChildProcessTracker";
import type { HostChildProcess, HostSpawnOptions } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { BlePeripheralSidecar } from "./BlePeripheralManager";
import {
  bleSidecarStatusSchema,
  type BleNotification,
  type BlePeripheralConfig,
  type BleSidecarStatus,
} from "./blePeripheralSchema";

export interface BleSidecarSpawner {
  spawn(file: string, args: string[], options: HostSpawnOptions): HostChildProcess;
}

const eventSchema = z.object({
  event: z.enum([
    "ready",
    "advertising",
    "connected",
    "disconnected",
    "status",
    "notified",
    "stopped",
    "error",
  ]),
  id: z.number().int().optional(),
  message: z.string().optional(),
  status: bleSidecarStatusSchema.optional(),
});

function scriptPath(): string {
  const source = fileURLToPath(new URL("./sidecar/peripheral.py", import.meta.url));
  return existsSync(source)
    ? source
    : fileURLToPath(new URL("./ble-peripheral.py", import.meta.url));
}

/** JSON-lines transport. Every command is acknowledged; crashes and pipe failures reject outstanding calls. */
export class ProcessBlePeripheralSidecar implements BlePeripheralSidecar {
  private tracker?: ProcessTracker;
  private lines?: Interface;
  private child?: HostChildProcess;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  private snapshot: BleSidecarStatus = {
    running: false,
    advertising: false,
    connected: [],
    subscribed: [],
    pythonReady: false,
    bumbleReady: false,
  };
  private ready?: { resolve: () => void; reject: (error: Error) => void };
  private stopped = false;

  constructor(
    private readonly deps: { spawner: BleSidecarSpawner; timer: Timer; script?: () => string },
  ) {}

  async start(python: string, config: BlePeripheralConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.stopped) {
      throw new ActionableError("BLE sidecar already stopped");
    }
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    const startup = raceWithDeadline(ready, {
      timer: this.deps.timer,
      timeoutMs: 15_000,
      signal,
      label: "BLE sidecar startup",
    });
    try {
      this.attach(
        this.deps.spawner.spawn(python, ["-I", "-u", (this.deps.script ?? scriptPath)()], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }),
      );
      this.write({ ...config, action: "start" });
      await startup;
    } catch (error) {
      this.fail(toActionableError(error, "BLE sidecar startup failed"));
      await startup.catch((failure: unknown) =>
        logger.debug("BLE startup rejection joined", failure),
      );
      throw toActionableError(
        error,
        "Could not start BLE sidecar; check the Python environment and netsim transport",
      );
    }
  }

  private attach(child: HostChildProcess): void {
    this.child = child;
    const stderr: string[] = [];
    this.tracker = {
      process: child,
      stderr,
      ...createExitTracker(child, stderr, { maxStderrChars: 4096 }),
    };
    void this.tracker.exitPromise.then(
      () =>
        this.fail(
          new ActionableError(
            `BLE sidecar exited. ${stderr.join("").slice(-4096)} Check the netsim transport and restart the peripheral.`,
          ),
        ),
      (error: unknown) => this.fail(toActionableError(error, "BLE sidecar process failed")),
    );
    child.stdin?.on("error", (error: Error) =>
      this.fail(toActionableError(error, "BLE sidecar stdin failed")),
    );
    if (!child.stdout || !child.stdin || !child.stderr) {
      throw new ActionableError("BLE sidecar needs stdin/stdout/stderr pipes");
    }
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.lines.on("close", () =>
      this.fail(new ActionableError("BLE sidecar stdout closed; restart the peripheral")),
    );
    child.stdout.on("error", (error: Error) =>
      this.fail(toActionableError(error, "BLE sidecar stdout failed")),
    );
  }

  private receive(line: string): void {
    if (this.stopped) {
      return;
    }
    try {
      if (line.length > 65536) {
        throw new ActionableError("BLE sidecar response exceeds 64 KiB");
      }
      const event = eventSchema.parse(JSON.parse(line));
      this.handleEvent(event);
    } catch (error) {
      this.fail(toActionableError(error, "Invalid BLE sidecar JSON response"));
    }
  }

  private handleEvent(event: z.infer<typeof eventSchema>): void {
    if (event.status) {
      this.snapshot = event.status;
    }
    if (event.event === "error") {
      const error = new ActionableError(`BLE sidecar: ${event.message ?? "unknown error"}`);
      if (event.id === undefined) {
        this.fail(error);
      } else {
        this.pending.get(event.id)?.reject(error);
      }
    } else if (event.event === "ready") {
      if (!event.status?.running) {
        throw new ActionableError("BLE ready event must report a running peripheral");
      }
      this.ready?.resolve();
    } else if (event.id !== undefined) {
      this.pending.get(event.id)?.resolve();
    }
  }

  private write(command: object): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new ActionableError("BLE sidecar stdin is unavailable; restart the peripheral");
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private async request(action: "notify" | "status", args: BleNotification = {}): Promise<void> {
    if (!this.snapshot.running || this.stopped) {
      throw new ActionableError("BLE sidecar is stopped; start a new peripheral");
    }
    const id = ++this.sequence;
    const response = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const completed = raceWithDeadline(response, {
      timer: this.deps.timer,
      timeoutMs: 10_000,
      label: `BLE ${action}`,
    });
    try {
      this.write({ action, id, ...args });
      await completed;
    } catch (error) {
      this.pending.get(id)?.reject(toActionableError(error, `BLE ${action} failed`));
      await completed.catch((failure: unknown) =>
        logger.debug("BLE command rejection joined", failure),
      );
      throw toActionableError(error, `BLE ${action} failed`);
    } finally {
      this.pending.delete(id);
    }
  }

  notify(notification: BleNotification): Promise<void> {
    return this.request("notify", notification);
  }

  async status(): Promise<BleSidecarStatus> {
    if (this.snapshot.running && !this.stopped) {
      await this.request("status");
    }
    return this.snapshot;
  }

  async stop(): Promise<void> {
    if (this.snapshot.running && !this.stopped) {
      try {
        this.write({ action: "stop", id: ++this.sequence });
      } catch (error) {
        // A broken pipe cannot prevent the unconditional process kill below.
        logger.warn("BLE stop command could not be written; killing the sidecar", error);
      }
    }
    this.stopped = true;
    this.fail(new ActionableError("BLE sidecar stopped"));
    if (this.tracker) {
      if (this.child?.pid === undefined) {
        // Node supplies no PID when spawn fails; there is no child to reap.
        await this.tracker.exitPromise.catch((error: unknown) =>
          logger.debug("BLE process never spawned", error),
        );
        this.lines?.close();
        return;
      }
      try {
        await waitForExit(this.tracker.process, this.tracker.exitPromise, {
          timer: this.deps.timer,
          timeoutMs: 500,
          forceKillTimeoutMs: 500,
          signal: "SIGKILL",
        });
      } catch (error) {
        throw toActionableError(error, "Could not confirm BLE sidecar exit; retry stop");
      }
      this.lines?.close();
    }
  }

  private fail(error: Error): void {
    this.snapshot = {
      ...this.snapshot,
      running: false,
      advertising: false,
      connected: [],
      subscribed: [],
    };
    this.ready?.reject(error);
    for (const command of this.pending.values()) {
      command.reject(error);
    }
    if (!this.stopped) {
      this.stopped = true;
      try {
        this.child?.kill("SIGKILL");
      } catch (killError) {
        // Retain the tracker so owner cleanup can retry a failed signal.
        logger.warn("Failed to signal an unusable BLE sidecar", killError);
      }
    }
    logger.debug(error.message, error);
  }
}
