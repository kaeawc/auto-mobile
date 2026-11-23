import type { ExecResult } from "../../../models";
import { mergeDyldInsertLibraries } from "../../prototype/ios/prototypeAgentInjection";
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

/** `xcrun simctl <args>`; `SimCtlClient.executeCommandArgs` implements it. */
export interface PosterSimctlRunner {
  executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal): Promise<ExecResult>;
}

const LAUNCHCTL_TIMEOUT_MS = 15_000;

/**
 * Turns on the camera poster for every app the simulator starts from now on (#19047), not only
 * apps `launchApp` starts: the home screen, XCUITest and system relaunches. It sets three
 * variables in the simulator's launchd environment:
 *
 * - `DYLD_INSERT_LIBRARIES` gains the gate library, which every new process loads. It links only
 *   libSystem and loads the poster library only into app processes that use AVFoundation.
 * - `AM_CAMERA_POSTER_DYLIB` names the poster library the gate loads.
 * - `AM_CAMERA_POSTER_CONFIG` names the per-simulator file the registry mirrors, so a new poster
 *   or a clear reaches the next launch of each app without touching launchd again.
 *
 * The launchd environment lasts until the simulator shuts down.
 */
export class IosCameraPosterDeviceWide {
  constructor(
    private readonly simctl: PosterSimctlRunner,
    private readonly posterProvider: IosCameraPosterDylibProvider,
    private readonly gateProvider: IosCameraPosterDylibProvider,
    private readonly config: Pick<IosCameraPosterDeviceConfig, "path">,
  ) {}

  async activate(udid: string, signal?: AbortSignal): Promise<void> {
    const [poster, gate] = [await this.posterProvider.ensure(), await this.gateProvider.ensure()];
    const existing = await this.launchctl(udid, ["getenv", "DYLD_INSERT_LIBRARIES"], signal);
    await this.setenv(udid, "AM_CAMERA_POSTER_DYLIB", poster, signal);
    await this.setenv(udid, "AM_CAMERA_POSTER_CONFIG", this.config.path(udid), signal);
    // Last, so no process loads the gate before it can find the poster library.
    await this.setenv(
      udid,
      "DYLD_INSERT_LIBRARIES",
      mergeDyldInsertLibraries(existing.stdout.trim(), gate),
      signal,
    );
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
  defaultDeviceWide ??= new IosCameraPosterDeviceWide(
    new SimCtlClient(null),
    iosCameraPosterDylibProvider,
    iosCameraPosterGateProvider,
    iosCameraPosterDeviceConfig,
  );
  return defaultDeviceWide;
}
