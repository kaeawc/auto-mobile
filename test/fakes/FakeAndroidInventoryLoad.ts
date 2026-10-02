import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, DeviceInfo, ExecResult } from "../../src/models";
import type {
  HostCommandOptions,
  HostProcessExecutor,
  StartedHostCommand,
} from "../../src/utils/HostCommandExecutor";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { createExecResult } from "../../src/utils/execResult";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { FakeChildProcess } from "./FakeChildProcess";
import { FakeTimer } from "./FakeTimer";
import { FakeAvdConfigReader } from "./FakeAvdConfigReader";

/** Five deterministic serials; all device commands contend with session capture at the injected host seam. */
export class FakeAndroidInventoryLoad implements HostProcessExecutor {
  readonly devices: BootedDevice[] = Array.from({ length: 5 }, (_, index) => ({
    deviceId: `emulator-${5554 + index * 2}`,
    name: `Pixel_${index}`,
    platform: "android",
    observedAt: 1,
  }));
  readonly images: DeviceInfo[] = this.devices.map((device) => ({
    name: device.name,
    platform: "android",
    source: "local",
  }));
  readonly calls = new Map<string, number>();
  private readonly nextAvailable = new Map<string, number>();
  readonly adbFactory: AdbClientFactory = { create: (device) => this.adb(device ?? null) };

  constructor(readonly timer: FakeTimer) {}

  count(serial: string, command: string): number {
    return this.calls.get(`${serial}:${command}`) ?? 0;
  }
  private record(serial: string, command: string): void {
    const key = `${serial}:${command}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
  }
  private delay(serial: string, durationMs: number): number {
    const start = Math.max(this.timer.now(), this.nextAvailable.get(serial) ?? 0);
    const end = start + durationMs;
    this.nextAvailable.set(serial, end);
    return end - this.timer.now();
  }

  adb(device: BootedDevice | null): AdbClient {
    const client = new AdbClient(
      device,
      null,
      null,
      undefined,
      this.timer,
      undefined,
      undefined,
      undefined,
      undefined,
      this,
    );
    // Typed device-list seam: do not invent parser input for the five-device fixture.
    Object.defineProperty(client, "getBaseCommandParts", {
      value: async () => ({ adbPath: "fake-adb", baseArgs: device ? ["-s", device.deviceId] : [] }),
    });
    Object.defineProperty(client, "isTestMode", { value: false });
    Object.defineProperty(client, "readDeviceListFromAdb", {
      value: async () => {
        this.record("host", "devices -l");
        await this.timer.sleep(1);
        return this.devices;
      },
    });
    return client;
  }

  emulator(): AndroidEmulatorClient {
    const client = new AndroidEmulatorClient(
      async () => createExecResult("", ""),
      null,
      this.timer,
      this.adbFactory,
      new FakeAvdConfigReader(),
    );
    Object.defineProperty(client, "ensureEmulatorPath", { value: async () => "fake-emulator" });
    // Typed identity/enumeration seams isolate workload behavior from console/AVD text parsing.
    const enumerate = async () => {
      this.record("host", "emulator -list-avds");
      await this.timer.sleep(1);
      return this.images;
    };
    // Baseline replay uses the pre-existing public seam; that version always enumerates afresh.
    if (!("listAvdsUncached" in client)) {
      Object.defineProperty(client, "listAvds", { value: enumerate });
    }
    Object.defineProperty(client, "listAvdsUncached", { value: enumerate });
    Object.defineProperty(client, "getRunningAVDName", {
      value: async (device: BootedDevice, timeoutMs: number, signal?: AbortSignal) => {
        this.record(device.deviceId, "emu avd name");
        try {
          await raceWithDeadline(this.timer.sleep(this.delay(device.deviceId, 1)), {
            timer: this.timer,
            timeoutMs,
            signal: signal ?? getAbortSignal(),
            label: "fake AVD identity",
          });
          return {
            name: this.devices.find((known) => known.deviceId === device.deviceId)?.name ?? "",
          };
        } catch (error) {
          signal?.throwIfAborted();
          return {
            name: "",
            diagnostic: {
              phase: "avd-name-resolution",
              summary: String(error),
              deviceId: device.deviceId,
            },
          };
        }
      },
    });
    return client;
  }

  executeCommandWithChild(
    _file: string,
    args: string[] = [],
    _options?: HostCommandOptions,
  ): StartedHostCommand {
    const serial = args[0] === "-s" ? args[1] : "host";
    const command = args.slice(serial === "host" ? 0 : 2).join(" ");
    this.record(serial, command);
    const child = new FakeChildProcess(this.timer);
    const pending = Promise.withResolvers<ExecResult>();
    const isSession = command.startsWith("exec-out") || command.includes("screenrecord");
    const handle = this.timer.setTimeout(
      () => {
        pending.resolve(this.commandResult(command));
        child.simulateExit();
      },
      this.delay(serial, isSession ? 20_000 : 1),
    );
    child.once("exit", (_code, signal) => {
      if (signal) {
        this.timer.clearTimeout(handle);
        pending.reject(new Error("fake child cancelled"));
      }
    });
    return { child: child as unknown as ChildProcess, result: pending.promise };
  }
  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    return this.executeCommandWithChild(file, args, options).result;
  }
  spawn(_file: string, _args: string[], _options?: SpawnOptions): ChildProcess {
    throw new Error("No long-lived process is permitted in this fixture");
  }

  private commandResult(command: string): ExecResult {
    const fixtures: Record<string, string> = {
      "shell dumpsys SurfaceFlinger --display-id": "fold-surfaceflinger.txt",
      "shell dumpsys display": "fold-open-display-device-info.txt",
      "shell cmd device_state print-states": "fold-states.txt",
    };
    const name = fixtures[command];
    return createExecResult(
      name ? readFileSync(join(import.meta.dir, "../fixtures/android-display", name), "utf8") : "",
      "",
    );
  }
}
