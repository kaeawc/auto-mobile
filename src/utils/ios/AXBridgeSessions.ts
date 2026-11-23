import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { IdGenerator } from "../IdGenerator";
import { logger } from "../logger";
import type { Timer } from "../SystemTimer";
import { TransportAXBridgeClient, type AXBridgeClient } from "./AXBridgeClient";
import { AXBridgePreflightError, type AXBridgePreflight } from "./AXBridgePreflight";
import type { AXBridgeProcessHandle, AXBridgeProcessLauncher } from "./AXBridgeProcessLauncher";

export interface AXBridgeSessionsOptions {
  enabled(): boolean;
  preflight: AXBridgePreflight;
  launcher: AXBridgeProcessLauncher;
  idGenerator: IdGenerator;
  timer: Timer;
}

interface Entry {
  client?: AXBridgeClient;
  process?: AXBridgeProcessHandle;
  ready: Promise<AXBridgeClient | undefined>;
}

/** One companion per session; entry identity fences release/reacquisition during async startup. */
export class AXBridgeSessions {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;

  constructor(private readonly options: AXBridgeSessionsOptions) {}

  start(sessionId: string, deviceId: string): Promise<AXBridgeClient | undefined> {
    if (this.stopped || !this.options.enabled()) {
      return Promise.resolve(undefined);
    }
    const existing = this.entries.get(sessionId);
    if (existing) {
      return existing.ready;
    }
    const entry: Entry = { ready: Promise.resolve(undefined) };
    this.entries.set(sessionId, entry);
    entry.ready = this.launch(sessionId, deviceId, entry);
    return entry.ready;
  }

  private async launch(sessionId: string, deviceId: string, entry: Entry): Promise<AXBridgeClient> {
    try {
      if (!(await this.options.preflight.isAquaSession())) {
        throw new AXBridgePreflightError("not_aqua");
      }
      if (!this.options.preflight.isAccessibilityTrusted()) {
        throw new AXBridgePreflightError("accessibility_not_trusted");
      }
      this.assertCurrent(sessionId, entry);
      const handle = await this.options.launcher.launch(deviceId);
      if (this.entries.get(sessionId) !== entry || !this.options.enabled()) {
        try {
          handle.transport.close();
        } finally {
          handle.kill();
        }
        throw new ActionableError(
          "AXBridge session ended or was disabled during startup. Reacquire the session to retry.",
        );
      }
      entry.process = handle;
      entry.client = new TransportAXBridgeClient(
        handle.transport,
        this.options.idGenerator,
        this.options.timer,
      );
      return entry.client;
    } catch (error) {
      if (this.entries.get(sessionId) === entry) {
        this.release(sessionId);
      }
      throw toActionableError(error, "Could not start the session's AXBridge companion");
    }
  }

  private assertCurrent(sessionId: string, entry: Entry): void {
    if (this.entries.get(sessionId) !== entry || !this.options.enabled()) {
      throw new ActionableError(
        "AXBridge session ended or was disabled before startup. Reacquire the session to retry.",
      );
    }
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    this.entries.delete(sessionId);
    try {
      entry?.client?.close();
    } finally {
      entry?.process?.kill();
    }
  }

  shutdown(): void {
    this.stopped = true;
    for (const sessionId of this.entries.keys()) {
      try {
        this.release(sessionId);
      } catch (error) {
        logger.warn(`Could not reap AXBridge for session ${sessionId}`, error);
      }
    }
  }
}
