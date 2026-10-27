import type { DeviceAppManager } from "./DeviceAppManager";
import type { IosCrashCommandOptions } from "./IosCrashBackend";

/** The DeviceAppManager slice crashApp needs on a physical device (#14096). */
export type PhysicalIosAppProcessControl = Pick<
  DeviceAppManager,
  "findRunningAppPid" | "signalProcess"
>;

export type PhysicalIosAbortOutcome = "signalled" | "already_exited";

/**
 * Crash an app on a physical iOS 17+ device (#14096): resolve its main-process PID through
 * `devicectl device info processes`, then deliver SIGABRT with `devicectl device process signal`.
 * DeviceAppManager owns every devicectl invocation (#4053); this binds it to one device.
 */
export class PhysicalIosAppCrasher {
  constructor(
    private readonly deviceId: string,
    private readonly apps: PhysicalIosAppProcessControl,
  ) {}

  /** `null`: installed, not running. `undefined`: not installed. */
  findAppPid(bundleId: string): Promise<number | null | undefined> {
    return this.apps.findRunningAppPid(this.deviceId, bundleId);
  }

  /** devicectl's own process-command deadline bounds the call; cancellation is checked after. */
  async sendAbort(
    pid: number,
    options: Pick<IosCrashCommandOptions, "signal"> = {},
  ): Promise<PhysicalIosAbortOutcome> {
    options.signal?.throwIfAborted();
    const outcome = await this.apps.signalProcess(this.deviceId, pid, "SIGABRT");
    options.signal?.throwIfAborted();
    return outcome;
  }

  /** SIGKILL for appLifecycle's state-preserving kill (#14098). */
  async sendKill(
    pid: number,
    options: Pick<IosCrashCommandOptions, "signal"> = {},
  ): Promise<PhysicalIosAbortOutcome> {
    options.signal?.throwIfAborted();
    const outcome = await this.apps.signalProcess(this.deviceId, pid, "SIGKILL");
    options.signal?.throwIfAborted();
    return outcome;
  }
}
