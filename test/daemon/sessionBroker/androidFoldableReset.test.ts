import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";
import { expect, test } from "bun:test";
import { AndroidBaselineReset } from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";

for (const fullBaseline of [false, true]) {
  test.each(["foldable", "phone", "tablet"] as const)(
    `restores %s posture after strategy (fullBaseline=${fullBaseline})`,
    async (archetype) => {
      const host = new FakeAndroidResetHost();
      const events: string[] = [];
      host.strategy = {
        fullBaseline,
        reset: async () => {
          events.push("strategy");
        },
      };
      const reset = new AndroidBaselineReset(
        Object.assign(host, {
          postureReset: {
            restore: async () => {
              events.push("opened");
            },
          },
        }),
      );
      const profile = { ...ANDROID_RESET_PROFILE, archetype };
      await reset.capture("r", ANDROID_RESET_DEVICE, profile, "s", {
        stableDeviceId: "avd",
        timer: new FakeTimer(),
      });
      host.onHealth = () => {
        events.push("health");
      };
      await reset.reset("r", ANDROID_RESET_DEVICE, profile, async () => {});
      expect(events).toEqual(
        archetype === "foldable" ? ["strategy", "opened", "health"] : ["strategy", "health"],
      );
    },
  );
}
test("failed or missing fold posture restore fails reset", async () => {
  for (const postureReset of [
    undefined,
    {
      restore: async () => {
        throw new Error("unsupported opened");
      },
    },
  ]) {
    const host = new FakeAndroidResetHost();
    host.strategy = { reset: async () => {} };
    const reset = new AndroidBaselineReset(Object.assign(host, { postureReset }));
    const profile = { ...ANDROID_RESET_PROFILE, archetype: "foldable" as const };
    await reset.capture("r", ANDROID_RESET_DEVICE, profile, "s", {
      stableDeviceId: "avd",
      timer: new FakeTimer(),
    });
    await expect(reset.reset("r", ANDROID_RESET_DEVICE, profile, async () => {})).rejects.toThrow(
      "opened",
    );
  }
});

test("fold posture restoration is bounded by the reset deadline and receives cancellation", async () => {
  const host = new FakeAndroidResetHost();
  const timer = new FakeTimer();
  host.timer = timer;
  host.resetTimeoutMs = 100;
  host.strategy = { reset: async () => {} };
  let restoreSignal: AbortSignal | undefined;
  const reset = new AndroidBaselineReset(
    Object.assign(host, {
      postureReset: {
        restore: async (_device: typeof ANDROID_RESET_DEVICE, signal: AbortSignal) => {
          restoreSignal = signal;
          await timer.sleep(1000);
          signal.throwIfAborted();
        },
      },
    }),
  );
  const profile = { ...ANDROID_RESET_PROFILE, archetype: "foldable" as const };
  await reset.capture("r", ANDROID_RESET_DEVICE, profile, "s", { stableDeviceId: "avd", timer });
  const pending = reset.reset("r", ANDROID_RESET_DEVICE, profile, async () => {});
  await expect(
    settleByFakeEvents(timer, pending, { description: "fold reset deadline" }),
  ).rejects.toThrow("timed out");
  expect(restoreSignal?.aborted).toBe(true);
});
