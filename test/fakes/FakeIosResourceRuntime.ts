import type { SimCtl } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { PlistReader } from "../../src/utils/ios-cmdline-tools/PlistClient";
import { createExecResult } from "../../src/utils/execResult";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { basename } from "node:path";

export const udid = "12345678-1234-1234-1234-123456789ABC";
export const label = "com.apple.PosterBoard";
export const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";

export class FakeWallpaperSimctl implements Pick<SimCtl, "executeCommandArgs"> {
  calls: string[][] = [];
  budgets: number[] = [];
  disabled = false;
  loaded = true;
  booted = true;
  malformed = false;
  emptyOverrides = false;
  ignoreWrites = false;
  failVerb?: string;
  onCommand?: (args: string[]) => void;
  states = new Map<string, { disabled: boolean; loaded: boolean }>();
  failLabel?: string;
  deviceTypeIdentifier?: string = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";

  state(service: string) {
    if (service === label) {
      return { disabled: this.disabled, loaded: this.loaded };
    }
    if (!this.states.has(service)) {
      this.states.set(service, { disabled: false, loaded: true });
    }
    return this.states.get(service)!;
  }

  async executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal) {
    this.calls.push(args);
    this.budgets.push(timeoutMs!);
    signal?.throwIfAborted();
    this.onCommand?.(args);
    if (args[0] === "list") {
      return createExecResult(
        JSON.stringify(
          args[1] === "devices"
            ? {
                devices: {
                  [runtime]: [
                    {
                      udid,
                      state: this.booted ? "Booted" : "Shutdown",
                      isAvailable: true,
                      deviceTypeIdentifier: this.deviceTypeIdentifier,
                    },
                  ],
                },
              }
            : { runtimes: [{ identifier: runtime, runtimeRoot: "/runtime", isAvailable: true }] },
        ),
        "",
      );
    }
    const verb = args[3];
    const service = args[4]?.startsWith("system/")
      ? args[4].slice(7)
      : basename(args[5] ?? "", ".plist");
    if (this.failVerb === verb && (!this.failLabel || this.failLabel === service)) {
      throw new Error("permission denied");
    }
    if (verb === "print-disabled") {
      return createExecResult(
        this.malformed
          ? "unexpected output"
          : this.emptyOverrides && !this.disabled
            ? "\n\tdisabled services = (no disabled services)\n"
            : `disabled services = {\n "${label}" => ${this.disabled}\n "com.apple.apsd" => true\n${[...this.states].map(([name, state]) => `"${name}" => ${state.disabled}`).join("\n")}\n}`,
        "",
      );
    }
    const state = this.state(service);
    if (verb === "print" && !state.loaded) {
      throw new Error(`Could not find service "${service}" in domain for system`);
    }
    if (!this.ignoreWrites) {
      if (verb === "disable") {
        state.disabled = true;
      }
      if (verb === "enable") {
        state.disabled = false;
      }
      if (verb === "bootout") {
        state.loaded = false;
      }
      if (verb === "bootstrap") {
        state.loaded = true;
      }
      if (service === label) {
        this.disabled = state.disabled;
        this.loaded = state.loaded;
      }
    }
    return createExecResult("", "");
  }

  mutations() {
    return this.calls.filter((args) =>
      ["disable", "enable", "bootout", "bootstrap"].includes(args[3] ?? ""),
    );
  }
}

export class FakeWallpaperPlist implements Pick<PlistReader, "readJsonFile"> {
  definition?: unknown;
  missing = new Set<string>();
  definitions = new Map<string, unknown>();
  paths: string[] = [];
  directoryReads = 0;
  async readDirectory(path: string): Promise<string[]> {
    this.directoryReads++;
    const labels = Object.values(iosDeviceResourceCatalog).flat();
    return labels
      .filter(
        (name) =>
          !this.missing.has(name) &&
          (name === label ? path.endsWith("LaunchAngels") : path.endsWith("LaunchDaemons")),
      )
      .map((name) => `${name}.plist`);
  }
  async readJsonFile(path: string) {
    this.paths.push(path);
    const name = basename(path, ".plist");
    return this.definition ?? this.definitions.get(name) ?? { Label: name };
  }
}
