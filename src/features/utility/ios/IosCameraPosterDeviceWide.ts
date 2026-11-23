import type { ExecResult } from "../../../models";
import { ActionableError } from "../../../models/ActionableError";
import { mergeDyldInsertLibraries } from "../../prototype/ios/prototypeAgentInjection";
import { SingleFlight } from "../../../utils/cache/SingleFlight";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  iosCameraPosterDylibProvider,
  iosCameraPosterGateProvider,
  type IosCameraPosterDylibProvider,
} from "./IosCameraPosterDylibProvider";
import {
  iosCameraPosterDeviceConfig,
  type IosCameraPosterDeviceConfig,
} from "./IosCameraPosterDeviceConfig";
import {
  IOS_CAMERA_POSTER_GATE_FILE,
  iosCameraPosterActivationStore,
  type IosCameraPosterActivationStore,
} from "./IosCameraPosterActivationStore";
import {
  defaultSimulatorBootEnvironment,
  type SimulatorBootEnvironment,
} from "./SimulatorBootEnvironment";
import type { IosCameraPosterRegistry } from "./IosCameraPosterRegistry";

/** `xcrun simctl <args>`; `SimCtlClient.executeCommandArgs` implements it. */
export interface PosterSimctlRunner {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

export interface IosCameraPosterDeviceWideDependencies {
  simctl: PosterSimctlRunner;
  posterProvider: IosCameraPosterDylibProvider;
  gateProvider: IosCameraPosterDylibProvider;
  config: Pick<IosCameraPosterDeviceConfig, "path">;
  store: IosCameraPosterActivationStore;
  bootEnvironment: SimulatorBootEnvironment;
}

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const DYLD = "DYLD_INSERT_LIBRARIES";
const POSTER_VARIABLES = ["AM_CAMERA_POSTER_DYLIB", "AM_CAMERA_POSTER_CONFIG"] as const;

function entries(value: string): string[] {
  return value.split(":").filter((entry) => entry.length > 0);
}

function isGate(entry: string, gate: string | undefined): boolean {
  return entry === gate || entry.endsWith(`/${IOS_CAMERA_POSTER_GATE_FILE}`);
}

/** The value with every gate entry removed; other inserted libraries keep their order. */
export function withoutGate(value: string, gate?: string): string {
  return entries(value)
    .filter((entry) => !isGate(entry, gate))
    .join(":");
}

/**
 * Turns on the camera poster for every app the simulator starts from now on (#19047), not only
 * apps `launchApp` starts: the home screen, XCUITest and system relaunches. It sets three
 * variables in the simulator's launchd environment:
 *
 * - `DYLD_INSERT_LIBRARIES` gains the gate library, which every new process loads. It links only
 *   libSystem and loads the poster library only into user-installed app processes that use
 *   AVFoundation.
 * - `AM_CAMERA_POSTER_DYLIB` names the poster library the gate loads.
 * - `AM_CAMERA_POSTER_CONFIG` names the per-simulator file the registry mirrors, so a new poster
 *   or a clear reaches the next launch of each app without touching launchd again.
 *
 * The activation store records each change so {@link deactivate} can undo it on every clear path
 * and at the next daemon start. A boot resets the launchd environment, so {@link afterBoot}
 * re-applies a poster the registry still holds.
 */
export class IosCameraPosterDeviceWide {
  private readonly deactivations = new SingleFlight<string, void>();

  private readonly simctl: PosterSimctlRunner;
  private readonly posterProvider: IosCameraPosterDylibProvider;
  private readonly gateProvider: IosCameraPosterDylibProvider;
  private readonly config: Pick<IosCameraPosterDeviceConfig, "path">;
  private readonly store: IosCameraPosterActivationStore;
  private readonly bootEnvironment: SimulatorBootEnvironment;

  constructor(deps: IosCameraPosterDeviceWideDependencies) {
    this.simctl = deps.simctl;
    this.posterProvider = deps.posterProvider;
    this.gateProvider = deps.gateProvider;
    this.config = deps.config;
    this.store = deps.store;
    this.bootEnvironment = deps.bootEnvironment;
  }

  async activate(udid: string, signal?: AbortSignal): Promise<void> {
    const poster = await this.posterProvider.ensure();
    const gate = this.store.installGate(await this.gateProvider.ensure());
    // launchd_sim gives a variable it inherited at boot precedence over `launchctl setenv`, and
    // `launchctl getenv` does not show it: a boot-time DYLD_INSERT_LIBRARIES cannot be extended.
    const bootValue = withoutGate(await this.bootEnvironment.dyldInsertLibraries(udid, signal));
    if (bootValue) {
      throw new ActionableError(
        `The simulator was booted with DYLD_INSERT_LIBRARIES=${bootValue}, which launchd keeps over launchctl setenv, so the camera poster cannot be inserted device-wide.`,
      );
    }
    const current = (await this.launchctl(udid, ["getenv", DYLD], signal)).stdout.trim();
    const prior = this.store.read(udid);
    // A prior record whose gate is gone from launchd belongs to an earlier boot.
    const launchctlBefore =
      prior && entries(current).some((entry) => isGate(entry, prior.gate))
        ? prior.launchctlBefore
        : withoutGate(current);
    await this.setenv(udid, POSTER_VARIABLES[0], poster, signal);
    await this.setenv(udid, POSTER_VARIABLES[1], this.config.path(udid), signal);
    // Recorded before the gate goes in, so an interrupted activation is still undone later.
    this.store.write(udid, { gate, launchctlBefore });
    // Last, so no process loads the gate before it can find the poster library.
    await this.setenv(udid, DYLD, mergeDyldInsertLibraries(withoutGate(current), gate), signal);
  }

  /**
   * Removes the gate from `DYLD_INSERT_LIBRARIES` (keeping any other inserted library) and unsets
   * the poster variables. A simulator with no recorded activation is left alone.
   */
  deactivate(udid: string, signal?: AbortSignal): Promise<void> {
    return this.deactivations.run(udid, () => this.runDeactivate(udid, signal));
  }

  /** A boot reset the launchd environment: re-apply the poster the registry still holds. */
  async afterBoot(udid: string, registry: Pick<IosCameraPosterRegistry, "get">): Promise<void> {
    if (registry.get(udid)) {
      await this.activate(udid);
    } else if (this.store.read(udid)) {
      await this.deactivate(udid);
    }
  }

  /** Undo activations a previous daemon left: its registry, and so its posters, did not survive. */
  async sweep(): Promise<void> {
    for (const udid of this.store.list()) {
      try {
        await this.deactivate(udid);
      } catch (error) {
        // A simulator that has shut down lost its launchd environment anyway.
        logger.warn(
          `Failed to undo the device-wide camera poster on ${udid}: ${errorMessage(error)}`,
        );
      } finally {
        this.store.remove(udid);
      }
    }
  }

  private async runDeactivate(udid: string, signal?: AbortSignal): Promise<void> {
    const record = this.store.read(udid);
    if (!record) {
      return;
    }
    const current = (await this.launchctl(udid, ["getenv", DYLD], signal)).stdout.trim();
    const remaining = withoutGate(current, record.gate);
    if (remaining) {
      await this.setenv(udid, DYLD, remaining, signal);
    } else {
      await this.launchctl(udid, ["unsetenv", DYLD], signal);
    }
    for (const name of POSTER_VARIABLES) {
      await this.launchctl(udid, ["unsetenv", name], signal);
    }
    this.store.remove(udid);
  }

  private setenv(udid: string, name: string, value: string, signal?: AbortSignal) {
    return this.launchctl(udid, ["setenv", name, value], signal);
  }

  private launchctl(udid: string, args: string[], signal?: AbortSignal): Promise<ExecResult> {
    return this.simctl.executeCommandArgs(
      ["spawn", udid, "launchctl", ...args],
      LAUNCHCTL_TIMEOUT_MS,
      signal,
    );
  }
}

let defaultDeviceWide: IosCameraPosterDeviceWide | undefined;

/** Created on first use, so importing this module starts no simctl client. */
export function defaultIosCameraPosterDeviceWide(): IosCameraPosterDeviceWide {
  defaultDeviceWide ??= new IosCameraPosterDeviceWide({
    simctl: new SimCtlClient(null),
    posterProvider: iosCameraPosterDylibProvider,
    gateProvider: iosCameraPosterGateProvider,
    config: iosCameraPosterDeviceConfig,
    store: iosCameraPosterActivationStore,
    bootEnvironment: defaultSimulatorBootEnvironment,
  });
  return defaultDeviceWide;
}
