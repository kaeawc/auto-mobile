import { describe, expect, test } from "bun:test";
import { AndroidDeviceResourceController } from "../../src/utils/androidDeviceResourceController";
import type { DeviceResourceRequest } from "../../src/utils/deviceResourceController";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { createExecResult } from "../../src/utils/execResult";
import { androidDeviceResourceCatalog } from "../../src/utils/androidDeviceResourceCatalog";
import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const bootId = "11111111-1111-4111-8111-111111111111";
class ResourceAdb extends FakeAdbExecutor {
  packages = new Map([["com.google.android.gm", "0"]]);
  settings = new Map<string, string>();
  commands: string[][] = [];
  role = "";
  ignoreWrites = false;
  onCommand?: () => void;
  override async execute(args: string[], options?: AdbExecuteOptions) {
    options?.signal?.throwIfAborted();
    const words = args[1]!.slice(1, -1).split("' '");
    this.commands.push(words);
    this.onCommand?.();
    const [verb, command] = words;
    let output = "";
    if (verb === "am") {
      output = "0";
    } else if (verb === "cat") {
      output = bootId;
    } else if (verb === "pm" && command === "list") {
      output = [...this.packages.keys()].map((name) => `package:${name}`).join("\n");
    } else if (verb === "dumpsys" && command === "package") {
      output = ` User 0: installed=true hidden=false suspended=false enabled=${this.packages.get(words[2]!)}\n User 0:\n verification state`;
    } else if (verb === "dumpsys") {
      output = "mResumedActivity: com.android.launcher3/.Launcher";
    } else if (verb === "cmd") {
      output = this.role;
    } else if (verb === "settings") {
      const key = words[5]!;
      if (words[3] === "get") {
        output = this.settings.get(key) ?? "null";
      } else if (!this.ignoreWrites) {
        if (words[3] === "delete") {
          this.settings.delete(key);
        } else {
          this.settings.set(key, words[6]!);
        }
      }
    } else if (verb === "pm" && !this.ignoreWrites) {
      this.packages.set(
        words[4]!,
        String(
          ["default-state", "enable", "disable", "disable-user", "disable-until-used"].indexOf(
            command!,
          ),
        ),
      );
    } else if (verb !== "pm") {
      throw new Error(`Unhandled command ${words.join(" ")}`);
    }
    return createExecResult(output, "");
  }
}
function setup() {
  const adb = new ResourceAdb();
  const timer = new FakeTimer();
  const controller = new AndroidDeviceResourceController({ create: () => adb }, timer);
  const request: DeviceResourceRequest = {
    device: { platform: "android", deviceId: "emulator-5580", name: "resource-test" },
    resources: { mailApp: "disabled" },
    deadlineMs: timer.now() + 1000,
  };
  return { adb, timer, controller, request };
}
describe("Android resource control", () => {
  test("disables only installed optional apps, verifies state, and restores default override exactly", async () => {
    const { adb, controller, request } = setup();
    const disabled = await controller.setResources(request);
    expect(disabled.success).toBe(true);
    expect(adb.packages.get("com.google.android.gm")).toBe("3");
    expect(disabled.restore?.entries[0]?.value).toBe("0");
    const restored = await controller.setResources({
      ...request,
      resources: {},
      restore: disabled.restore,
    });
    expect(restored.success).toBe(true);
    expect(adb.packages.get("com.google.android.gm")).toBe("0");
    expect(adb.commands.some((words) => words[1] === "default-state")).toBe(true);
  });
  test("does not claim success for ignored package writes and retains restoration receipt", async () => {
    const { adb, controller, request } = setup();
    adb.ignoreWrites = true;
    const result = await controller.setResources(request);
    expect(result.success).toBe(false);
    expect(result.resources.mailApp?.state).toBe("unknown");
    expect(result.restore?.entries).toHaveLength(1);
  });
  test("protects role holders before mutating a package group", async () => {
    const { adb, controller, request } = setup();
    adb.role = "com.google.android.gm";
    expect((await controller.setResources(request)).success).toBe(false);
    expect(adb.packages.get("com.google.android.gm")).toBe("0");
  });
  test("reports absent catalogs as unsupported, and is idempotent for already-disabled packages", async () => {
    const { adb, controller, request } = setup();
    adb.packages.set("com.google.android.gm", "3");
    expect((await controller.setResources(request)).changed).toEqual([]);
    adb.packages.clear();
    expect((await controller.setResources(request)).resources.mailApp?.state).toBe("unsupported");
  });
  test("restores absent animation overrides using delete, preserving a non-default scale", async () => {
    const { adb, controller, request } = setup();
    request.resources = { animations: "disabled" };
    adb.settings.set("window_animation_scale", "0.5");
    const result = await controller.setResources(request);
    expect(result.success).toBe(true);
    expect(adb.settings.get("animator_duration_scale")).toBe("0");
    expect(
      (await controller.setResources({ ...request, resources: {}, restore: result.restore }))
        .success,
    ).toBe(true);
    expect(adb.settings.get("window_animation_scale")).toBe("0.5");
    expect(adb.settings.has("animator_duration_scale")).toBe(false);
  });
  test("rejects a receipt from another boot and an injected non-catalog target without writes", async () => {
    const { adb, controller, request } = setup();
    const receipt = (await controller.setResources(request)).restore!;
    const mutations = () =>
      adb.commands.filter((words) => words[0] === "pm" && words[1] !== "list").length;
    const count = mutations();
    expect(
      (
        await controller.setResources({
          ...request,
          resources: {},
          restore: { ...receipt, bootId: "22222222-2222-4222-8222-222222222222" },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await controller.setResources({
          ...request,
          resources: {},
          restore: {
            ...receipt,
            entries: [{ ...receipt.entries[0]!, target: "com.android.systemui" }],
          },
        })
      ).success,
    ).toBe(false);
    expect(mutations()).toBe(count);
  });
  test("propagates cancellation and stops dispatching after deadline", async () => {
    const { adb, timer, controller, request } = setup();
    const abort = new AbortController();
    const reason = new Error("preempted");
    request.signal = abort.signal;
    adb.onCommand = () => abort.abort(reason);
    await expect(controller.setResources(request)).rejects.toBe(reason);
    expect(adb.commands).toHaveLength(1);
    adb.onCommand = undefined;
    request.signal = undefined;
    request.deadlineMs = timer.now();
    expect((await controller.setResources(request)).success).toBe(false);
    expect(adb.commands).toHaveLength(1);
  });
  test("does not issue commands for unsupported resources or physical devices", async () => {
    const { adb, controller, request } = setup();
    expect(
      (await controller.setResources({ ...request, resources: { widgets: "disabled" } })).success,
    ).toBe(false);
    request.device.deviceId = "physical-device";
    expect((await controller.setResources(request)).success).toBe(false);
    expect(adb.commands).toEqual([]);
  });
});

test("undefined resource values do not enable an app", async () => {
  const { adb, controller, request } = setup();
  request.resources = { mailApp: undefined };
  expect((await controller.setResources(request)).changed).toEqual([]);
  expect(adb.commands).toEqual([]);
});

test("Android package groups do not overlap or contain shared platform providers", () => {
  const packages = Object.values(androidDeviceResourceCatalog).flat();
  expect(new Set(packages).size).toBe(packages.length);
  expect(
    packages.some((name) =>
      /providers|systemui|permissioncontroller|webview|launcher|automobile|mainline/.test(name),
    ),
  ).toBe(false);
});

test("duplicate restoration targets are rejected before any writes", async () => {
  const { adb, controller, request } = setup();
  const entry = {
    resource: "mailApp" as const,
    kind: "package" as const,
    target: "com.google.android.gm",
    value: "3",
  };
  const result = await controller.setResources({
    ...request,
    resources: {},
    restore: { deviceId: request.device.deviceId, bootId, userId: 0, entries: [entry, entry] },
  });
  expect(result.success).toBe(false);
  expect(adb.packages.get("com.google.android.gm")).toBe("0");
});
