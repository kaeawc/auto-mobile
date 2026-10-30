import { describe, expect, test } from "bun:test";
import {
  ToolBindingProvisioner,
  type BindingProvisionPortDependencies,
} from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import type { BindingToolInvoker } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { discardsAndroidSnapshotOnExit } from "../../../../src/daemon/sessionBroker/hostConfig";
import { FakeTimer } from "../../../fakes/FakeTimer";

const ANDROID_SPEC = {
  runtime: "system-images;android-35;google_apis;arm64-v8a",
  deviceType: "pixel_8",
};

/** The first provisionDevice arguments the provisioner sends; the call itself then fails. */
async function sentArgs(
  platform: "android" | "ios",
  policy: BindingProvisionPortDependencies["discardAndroidSnapshotOnExit"],
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> | undefined;
  const invokeTool: BindingToolInvoker = async (_name, args) => {
    sent = args;
    throw new Error("stop after recording");
  };
  const timer = new FakeTimer();
  const provisioner = new ToolBindingProvisioner({
    invokeTool,
    deviceManager: { listDeviceImages: async () => [] },
    androidConfigReader: { readConfig: async () => null },
    timer,
    releaseSession: async () => {},
    ...(policy ? { discardAndroidSnapshotOnExit: policy } : {}),
  });
  await provisioner
    .provision({
      platform,
      name: "amslot-x",
      spec:
        platform === "android" ? ANDROID_SPEC : { runtime: "iOS-18-0", deviceType: "iPhone-16" },
      mode: "create",
      deadlineMs: timer.now() + 60_000,
    })
    .catch(() => undefined);
  return sent ?? {};
}

describe("broker provisioning and the exit snapshot (#15477)", () => {
  test("an Android emulator the host destroys is booted without an exit snapshot", async () => {
    expect(await sentArgs("android", () => true)).toMatchObject({ discardSnapshotOnExit: true });
  });

  test("warm reuse, no policy and iOS keep the default", async () => {
    expect(await sentArgs("android", () => false)).not.toHaveProperty("discardSnapshotOnExit");
    expect(await sentArgs("android", undefined)).not.toHaveProperty("discardSnapshotOnExit");
    expect(await sentArgs("ios", () => true)).not.toHaveProperty("discardSnapshotOnExit");
  });
});

describe("discardsAndroidSnapshotOnExit", () => {
  type Config = NonNullable<Parameters<typeof discardsAndroidSnapshotOnExit>[0]>;
  const config = (
    androidResetMode?: Config["androidResetMode"],
    androidKeepBootedFallback?: Config["androidKeepBootedFallback"],
  ): Config => ({ androidResetMode, androidKeepBootedFallback });

  test("an unread config keeps the exit snapshot", () => {
    expect(discardsAndroidSnapshotOnExit(undefined)).toBe(false);
  });

  test("no reset mode discards: released emulators are destroyed", () => {
    expect(discardsAndroidSnapshotOnExit(config())).toBe(true);
  });

  test("keep-booted without the snapshot fallback discards (#15793)", () => {
    expect(discardsAndroidSnapshotOnExit(config("keep-booted", "destroy"))).toBe(true);
    expect(discardsAndroidSnapshotOnExit(config("keep-booted"))).toBe(true);
  });

  test("modes that can reset from a snapshot keep the default", () => {
    expect(discardsAndroidSnapshotOnExit(config("snapshot"))).toBe(false);
    expect(discardsAndroidSnapshotOnExit(config("keep-booted", "snapshot"))).toBe(false);
  });
});
