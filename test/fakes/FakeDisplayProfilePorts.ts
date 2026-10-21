import type {
  DisplayConfigResult,
  DisplayConfigValues,
  SetDisplayConfigInput,
} from "../../src/features/utility/DisplayConfig";
import type {
  DisplayConfigPort,
  DisplayProfilePorts,
  PostureControl,
} from "../../src/features/utility/DisplayProfile";
import type { RequestedPosture } from "../../src/features/device/postureCommands";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "./FakeAdbExecutor";

/** A DisplayConfig that holds values in memory and reports what each set replaced. */
export class FakeDisplayConfigPort implements DisplayConfigPort {
  values: DisplayConfigValues = { fontScale: "default", density: "default", theme: "light" };
  calls: SetDisplayConfigInput[] = [];
  densitySupport: boolean | "partial" = true;
  failWith?: string;

  async setConfig(input: SetDisplayConfigInput): Promise<DisplayConfigResult> {
    this.calls.push(input);
    const previous = { ...this.values };
    const base = {
      deviceId: "emulator-5554",
      platform: "android" as const,
      supported: { fontScale: true, density: this.densitySupport, theme: true },
      previous,
    };
    if (this.failWith) {
      return { ...base, success: false, error: this.failWith };
    }
    this.values = {
      ...this.values,
      ...(input.fontScale !== undefined ? { fontScale: input.fontScale } : {}),
      ...(input.density !== undefined ? { density: input.density } : {}),
      ...(input.theme !== undefined ? { theme: input.theme } : {}),
    };
    return { ...base, success: true, applied: { ...this.values } };
  }
}

export class FakePostureControl implements PostureControl {
  current: RequestedPosture | undefined = "opened";
  calls: RequestedPosture[] = [];
  unsupported?: string;

  async read(): Promise<RequestedPosture | undefined> {
    return this.current;
  }

  async set(posture: RequestedPosture) {
    this.calls.push(posture);
    if (this.unsupported) {
      return { status: "unsupported" as const, detail: this.unsupported };
    }
    this.current = posture;
    return { status: "applied" as const };
  }
}

/** An Android 34 emulator with stock overlays and no size override. */
export function createFakeDisplayProfilePorts(): DisplayProfilePorts & {
  shell: FakeAdbExecutor;
  displayConfig: FakeDisplayConfigPort;
  posture: FakePostureControl;
} {
  const shell = new FakeAdbExecutor();
  shell.setAndroidApiLevel(34);
  shell.setCommandResponse("shell wm size", createExecResult("Physical size: 1080x2400\n", ""));
  shell.setCommandResponse(
    "shell cmd overlay list android",
    createExecResult(
      [
        "android",
        "[ ] com.android.internal.display.cutout.emulation.corner",
        "[ ] com.android.internal.display.cutout.emulation.hole",
        "[x] com.android.internal.systemui.navbar.gestural",
        "[ ] com.android.internal.systemui.navbar.threebutton",
        "",
      ].join("\n"),
      "",
    ),
  );
  shell.setCommandResponse("shell getprop debug.hwui.force_dark", createExecResult("\n", ""));
  return {
    shell,
    displayConfig: new FakeDisplayConfigPort(),
    posture: new FakePostureControl(),
  };
}

export const fakeEmulator: BootedDevice = {
  name: "emu",
  platform: "android",
  deviceId: "emulator-5554",
};
