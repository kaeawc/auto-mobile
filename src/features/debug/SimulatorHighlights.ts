import type { ChildProcess } from "node:child_process";
import { z } from "zod/v4";
import type { BootedDevice, HighlightOperationResult, HighlightShape } from "../../models";
import {
  DefaultHostCommandExecutor,
  type HostProcessExecutor,
} from "../../utils/HostCommandExecutor";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { ScreenCaptureHelperProvider } from "../screen-stream/ScreenCaptureHelperProvider";
import {
  readScreenCaptureHelperEnvOverride,
  resolveIosScreenCaptureHelperPath,
} from "../screen-stream/screenCaptureHelperPath";

import { IOSCtrlProxyClient } from "../observe/ios";
import { parseCapabilityMarker } from "../screen-stream/IOSScreenCaptureHelper";

export interface SimulatorHighlightsDependencies {
  fallback?: () => {
    requestAddHighlight(
      id: string,
      shape: HighlightShape,
      timeoutMs: number,
    ): Promise<HighlightOperationResult>;
  };
  executor?: HostProcessExecutor;
  timer?: Timer;
  resolveHelper?: () => Promise<string | null>;
}

interface OverlayHost {
  child: ChildProcess;
  pending: Map<string, (result: HighlightOperationResult) => void>;
}
// Keep an included application's process alive after its shapes expire:
// ScreenCaptureKit retains that connection even after removing its windows.
// Parent pipe EOF terminates these helpers when the daemon exits.
const sharedHosts = new Map<string, OverlayHost>();
let nextRequestId = 0;
const acknowledgementSchema = z.object({
  requestId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

export class SimulatorHighlights {
  private readonly executor: HostProcessExecutor;
  private readonly timer: Timer;
  private readonly resolveHelper: () => Promise<string | null>;

  private readonly hosts: Map<string, OverlayHost>;
  private readonly supportedHelpers = new Map<string, boolean>();
  private readonly fallback: NonNullable<SimulatorHighlightsDependencies["fallback"]>;

  constructor(
    private readonly device: BootedDevice,
    deps?: SimulatorHighlightsDependencies,
  ) {
    this.fallback = deps?.fallback ?? (() => IOSCtrlProxyClient.getInstance(device));
    this.executor = deps?.executor ?? new DefaultHostCommandExecutor();
    this.timer = deps?.timer ?? defaultTimer;
    this.hosts = deps ? new Map() : sharedHosts;
    this.resolveHelper =
      deps?.resolveHelper ??
      (async () => {
        if (readScreenCaptureHelperEnvOverride()) {
          return resolveIosScreenCaptureHelperPath();
        }
        return ScreenCaptureHelperProvider.getInstance().ensure();
      });
  }

  async requestAddHighlight(
    id: string,
    shape: HighlightShape,
    timeoutMs = 5000,
  ): Promise<HighlightOperationResult> {
    const controller = new AbortController();
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<HighlightOperationResult>((resolve) => {
      deadline = this.timer.setTimeout(() => {
        controller.abort();
        resolve({ success: false, error: "Simulator highlight timed out" });
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.sendHighlight(id, shape, controller.signal, timeoutMs),
        expired,
      ]);
    } finally {
      if (deadline) {
        this.timer.clearTimeout(deadline);
      }
    }
  }

  private async sendHighlight(
    id: string,
    shape: HighlightShape,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<HighlightOperationResult> {
    try {
      const helper = await this.resolveHelper();
      signal.throwIfAborted();
      if (!helper) {
        return await this.fallback().requestAddHighlight(id, shape, timeoutMs);
      }
      let supported = this.supportedHelpers.get(helper);
      if (supported === undefined) {
        const probe = await this.executor.executeCommand(helper, ["--help"], { timeoutMs, signal });
        signal.throwIfAborted();
        supported = probe.stderr
          .split(/\r?\n/)
          .some((line) => parseCapabilityMarker(line) === "simulator-highlights");
        this.supportedHelpers.set(helper, supported);
      }
      if (!supported) {
        return await this.fallback().requestAddHighlight(id, shape, timeoutMs);
      }
      const key = `${helper}:${this.device.deviceId}`;
      const requestId = String(++nextRequestId);
      const json = JSON.stringify({ requestId, id, shape });
      let host = this.hosts.get(key);
      if (!host) {
        const child = this.executor.spawn(
          helper,
          ["--highlight-simulator", this.device.name, "--highlight-json", json],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        host = { child, pending: new Map() };
        this.hosts.set(key, host);
        this.watchHost(key, host);
      } else {
        // Register the reply before sending the next command.
        const result = this.waitForReply(host, requestId, signal);
        host.child.stdin?.write(`${json}\n`);
        return await result;
      }
      return await this.waitForReply(host, requestId, signal);
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  private waitForReply(
    host: OverlayHost,
    requestId: string,
    signal: AbortSignal,
  ): Promise<HighlightOperationResult> {
    return new Promise((resolve) => {
      const finish = (result: HighlightOperationResult) => {
        signal.removeEventListener("abort", abort);
        host.pending.delete(requestId);
        resolve(result);
      };
      const abort = () => finish({ success: false, error: "Simulator highlight timed out" });
      host.pending.set(requestId, finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }

  private watchHost(key: string, host: OverlayHost): void {
    let stdout = "";
    let stderr = "";
    const fail = (error: string) => {
      if (this.hosts.get(key) === host) {
        this.hosts.delete(key);
      }
      for (const finish of host.pending.values()) {
        finish({ success: false, error });
      }
    };
    host.child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 65536) {
        fail("Invalid highlight acknowledgement");
        host.child.kill();
        return;
      }
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        try {
          const reply = acknowledgementSchema.parse(JSON.parse(line));
          host.pending.get(reply.requestId)?.({
            success: reply.success,
            ...(reply.error ? { error: reply.error } : {}),
          });
        } catch (error) {
          fail(`Invalid highlight acknowledgement: ${error}`);
        }
      }
    });
    host.child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });
    host.child.stdin?.on("error", (error) => fail(String(error)));
    host.child.once("error", (error) => fail(String(error)));
    host.child.once("exit", () => fail(stderr.trim() || "Highlight helper exited before drawing"));
  }
}
