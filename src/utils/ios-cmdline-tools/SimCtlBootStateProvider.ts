import type { SimulatorBootStateProvider, SimulatorBootSummary } from "./CoreDeviceCapabilityProbe";
import type { SimCtl } from "./SimCtlClient";

import type { DeviceInfo } from "../../models";
import { defaultTimer, type Timer } from "../SystemTimer";
import { SingleFlight } from "../cache/SingleFlight";

/** Fresh boot checks; diagnostics share a one-second, deadline-bounded simctl listing. */
export class SimCtlBootStateProvider implements SimulatorBootStateProvider {
  private readonly scopes = new Map<string, string>();
  private summary?: { at: number; value: SimulatorBootSummary };
  private readonly flights = new SingleFlight<string, SimulatorBootSummary>();

  constructor(
    private readonly simctl: Pick<SimCtl, "getDeviceInfo"> &
      Partial<Pick<SimCtl, "listSimulatorImages">>,
    private readonly options: { timer?: Timer; timeoutMs?: number } = {},
  ) {}

  getCapabilityScope(deviceId: string): string {
    return this.scopes.get(deviceId) ?? deviceId;
  }

  private rememberScope(device: DeviceInfo): void {
    if (!device.deviceId) {
      return;
    }
    if (!this.scopes.has(device.deviceId) && this.scopes.size >= 64) {
      const oldest = this.scopes.keys().next().value;
      if (oldest !== undefined) {
        this.scopes.delete(oldest);
      }
    }
    const scope = device.deviceType
      ? `${device.deviceType}${device.runtime ? `@${device.runtime}` : ""}`
      : device.deviceId;
    this.scopes.set(device.deviceId, scope);
  }

  async readSummary(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SimulatorBootSummary> {
    options.signal?.throwIfAborted();
    const timer = this.options.timer ?? defaultTimer;
    const now = timer.now();
    if (this.summary && now >= this.summary.at && now - this.summary.at < 1000) {
      return { ...this.summary.value };
    }
    return this.flights.run(
      "summary",
      async (signal) => {
        if (!this.simctl.listSimulatorImages) {
          throw new Error("simulator listing provider not configured");
        }
        const devices = await this.simctl.listSimulatorImages(
          options.timeoutMs ?? this.options.timeoutMs,
          { bypassCache: true, signal },
        );
        const value: SimulatorBootSummary = {
          status: "available",
          booted: 0,
          shutdown: 0,
          unknown: 0,
        };
        for (const device of devices) {
          const state =
            device.state === "Booted"
              ? "booted"
              : device.state === "Shutdown"
                ? "shutdown"
                : "unknown";
          value[state] += 1;
        }
        this.summary = { at: timer.now(), value };
        return { ...value };
      },
      options.signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }

  async getBootState(deviceId: string): Promise<"booted" | "shutdown" | "unknown"> {
    // Never trust the discovery TTL/last-good fallback for a capability decision.
    // The old getDeviceInfo seam remains usable by narrow injected fakes.
    if (this.simctl.listSimulatorImages && this.options.timeoutMs !== undefined) {
      const devices = await this.simctl.listSimulatorImages(this.options.timeoutMs, {
        bypassCache: true,
      });
      const device = devices.find((candidate) => candidate.deviceId === deviceId);
      if (device) {
        this.rememberScope(device);
      }
      return device?.state === "Booted"
        ? "booted"
        : device?.state === "Shutdown"
          ? "shutdown"
          : "unknown";
    }
    const device = await this.simctl.getDeviceInfo(deviceId);
    switch (device?.state) {
      case "Booted":
        return "booted";
      case "Shutdown":
        return "shutdown";
      default:
        return "unknown";
    }
  }
}
