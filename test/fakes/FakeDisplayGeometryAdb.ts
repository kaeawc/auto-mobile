import type {
  AdbExecuteOptions,
  AdbExecutor,
} from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbClient } from "./FakeAdbClient";

export interface FakeOverlay {
  target: string;
  packageName: string;
  state: "enabled" | "disabled" | "unavailable";
}

const NAVBAR = "com.android.internal.systemui.navbar.";
const CUTOUT = "com.android.internal.display.cutout.emulation.";

/** The API 35 emulator overlay set: gesture navigation on, no cutout emulation. */
export function api35Overlays(): FakeOverlay[] {
  const android = (name: string, state: FakeOverlay["state"] = "disabled"): FakeOverlay => ({
    target: "android",
    packageName: name,
    state,
  });
  return [
    android(`${CUTOUT}corner`),
    android(`${CUTOUT}double`),
    android(`${CUTOUT}hole`),
    android(`${CUTOUT}tall`),
    android(`${CUTOUT}waterfall`),
    android(`${NAVBAR}gestural`, "enabled"),
    android(`${NAVBAR}gestural_extra_wide_back`),
    android(`${NAVBAR}gestural_narrow_back`),
    android(`${NAVBAR}gestural_wide_back`),
    android(`${NAVBAR}threebutton`),
    {
      target: "com.android.systemui",
      packageName: "com.android.systemui.auto_generated_rro_vendor__",
      state: "enabled",
    },
  ];
}

interface FakeDisplay {
  physical: string;
  override?: string;
}

/**
 * A FakeAdbClient that models the device state behind `wm size` and `cmd overlay` (#14101), so
 * tests assert end states and the commands sent rather than scripting every read. Other
 * commands fall through to FakeAdbClient's configured results; every command is recorded there.
 */
export class FakeDisplayGeometryAdb extends FakeAdbClient implements AdbExecutor {
  readonly displays = new Map<number, FakeDisplay>([[0, { physical: "1080x2400" }]]);
  overlays: FakeOverlay[] = api35Overlays();
  /** When true, `wm size` writes are accepted but have no effect (an OEM shell ignoring them). */
  ignoreSizeWrites = false;
  /** Commands (exact) that report a shell failure instead of applying. */
  readonly failing = new Set<string>();

  override async executeCommand(command: string, options?: AdbExecuteOptions): Promise<ExecResult> {
    const fallback = await super.executeCommand(command, options);
    if (this.failing.has(command)) {
      return createExecResult("", "Error: injected failure");
    }
    const stdout = this.handle(command.replace(/^shell /, ""));
    return stdout === undefined ? fallback : createExecResult(stdout, "");
  }

  enabled(prefix: string): string[] {
    return this.overlays
      .filter((overlay) => overlay.packageName.startsWith(prefix) && overlay.state === "enabled")
      .map((overlay) => overlay.packageName);
  }

  /** The `cmd overlay list` text for the current state, grouped by target. */
  renderOverlayList(): string {
    const targets = [...new Set(this.overlays.map((overlay) => overlay.target))];
    return targets
      .map((target) => {
        const lines = this.overlays
          .filter((overlay) => overlay.target === target)
          .map((overlay) => {
            const status =
              overlay.state === "enabled" ? "[x]" : overlay.state === "disabled" ? "[ ]" : "---";
            return `${status} ${overlay.packageName}\n`;
          });
        return `${target}\n${lines.join("")}\n`;
      })
      .join("");
  }

  private handle(command: string): string | undefined {
    const wm = /^wm size(?: (reset|\d+x\d+))?(?: -d (\d+))?$/.exec(command);
    if (wm) {
      return this.wmSize(wm[1], Number(wm[2] ?? 0));
    }
    if (command === "cmd overlay list android" || command === "cmd overlay list") {
      return this.renderOverlayList();
    }
    const overlay = /^cmd overlay (enable-exclusive --category|enable|disable) (\S+)$/.exec(
      command,
    );
    return overlay ? this.overlayCommand(overlay[1], overlay[2]) : undefined;
  }

  private wmSize(value: string | undefined, displayId: number): string {
    const display = this.displays.get(displayId);
    if (!display) {
      return `Error: invalid display ${displayId}`;
    }
    if (value === undefined) {
      const override = display.override ? `Override size: ${display.override}\n` : "";
      return `Physical size: ${display.physical}\n${override}`;
    }
    if (!this.ignoreSizeWrites) {
      display.override = value === "reset" || value === display.physical ? undefined : value;
    }
    return "";
  }

  private overlayCommand(verb: string, packageName: string): string {
    const target = this.overlays.find((overlay) => overlay.packageName === packageName);
    if (!target || target.state === "unavailable") {
      return `Error: Unable to ${verb} ${packageName}`;
    }
    if (verb === "disable") {
      target.state = "disabled";
      return "";
    }
    if (verb !== "enable") {
      const prefix = packageName.startsWith(NAVBAR) ? NAVBAR : CUTOUT;
      for (const overlay of this.overlays) {
        if (overlay.packageName.startsWith(prefix) && overlay.state === "enabled") {
          overlay.state = "disabled";
        }
      }
    }
    target.state = "enabled";
    return "";
  }
}
