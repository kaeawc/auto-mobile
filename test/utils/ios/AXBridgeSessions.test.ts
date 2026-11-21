import { describe, expect, test } from "bun:test";
import { AXBridgeSessions } from "../../../src/utils/ios/AXBridgeSessions";
import { AXBridgePreflightError } from "../../../src/utils/ios/AXBridgePreflight";
import { FEATURE_FLAG_DEFINITIONS } from "../../../src/models/FeatureFlagDefinitions";
import { FakeAXBridgePreflight } from "../../fakes/FakeAXBridgePreflight";
import { FakeAXBridgeProcessLauncher } from "../../fakes/FakeAXBridgeProcessLauncher";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";

function setup(enabled = true) {
  const preflight = new FakeAXBridgePreflight();
  const launcher = new FakeAXBridgeProcessLauncher();
  const flag = { enabled };
  const sessions = new AXBridgeSessions({
    enabled: () => flag.enabled,
    preflight,
    launcher,
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(["a", "b"]),
  });
  return { sessions, preflight, launcher, flag };
}

describe("AXBridgeSessions", () => {
  test("is off by default and does no preflight or launch when disabled", async () => {
    expect(FEATURE_FLAG_DEFINITIONS.find((f) => f.key === "ios-axbridge")?.defaultValue).toBe(
      false,
    );
    const { sessions, preflight, launcher } = setup(false);
    expect(await sessions.start("s", "d")).toBeUndefined();
    expect(preflight.aquaCalls).toBe(0);
    expect(launcher.launches).toHaveLength(0);
  });
  test.each(["not_aqua", "accessibility_not_trusted"] as const)(
    "rejects %s before launch",
    async (code) => {
      const { sessions, preflight, launcher } = setup();
      preflight.aqua = code !== "not_aqua";
      preflight.trusted = code !== "accessibility_not_trusted";
      const ready = sessions.start("s", "d");
      await expect(ready).rejects.toBeInstanceOf(AXBridgePreflightError);
      await expect(ready).rejects.toMatchObject({ code });
      expect(launcher.launches).toHaveLength(0);
    },
  );
  test("reuses concurrent starts; release kills only its handle and rejects pending actions", async () => {
    const { sessions, launcher } = setup();
    const ready = sessions.start("s", "d");
    expect(sessions.start("s", "d")).toBe(ready);
    const client = await ready;
    await sessions.start("other", "d2");
    const action = client!.invokeAction({ actionName: "Edit" });
    sessions.release("s");
    await expect(action).rejects.toThrow("closed");
    sessions.release("s");
    expect(launcher.launches.map((l) => l.kills)).toEqual([1, 0]);
    sessions.shutdown();
    expect(launcher.launches.map((l) => l.kills)).toEqual([1, 1]);
    expect(await sessions.start("late", "d")).toBeUndefined();
  });
  test("release while preflight is pending prevents spawning", async () => {
    const { sessions, launcher } = setup();
    const ready = sessions.start("s", "d");
    sessions.release("s");
    await expect(ready).rejects.toThrow("ended");
    expect(launcher.launches).toHaveLength(0);
  });
  test.each(["release", "shutdown", "disable"])("%s reaps a late launch", async (operation) => {
    const { sessions, launcher, flag } = setup();
    const barrier = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    launcher.beforeReturn = () => {
      started.resolve();
      return barrier.promise;
    };
    const ready = sessions.start("s", "d");
    await started.promise;
    if (operation === "release") {
      sessions.release("s");
    }
    if (operation === "shutdown") {
      sessions.shutdown();
    }
    if (operation === "disable") {
      flag.enabled = false;
    }
    barrier.resolve();
    await expect(ready).rejects.toThrow("ended or was disabled");
    expect(launcher.launches[0].kills).toBe(1);
  });
});

test("a released late launch cannot reap a replacement session's companion", async () => {
  const { sessions, launcher } = setup();
  const barrier = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  launcher.beforeReturn = () => {
    started.resolve();
    return launcher.launches.length === 1 ? barrier.promise : Promise.resolve();
  };
  const old = sessions.start("s", "old-device");
  await started.promise;
  sessions.release("s");
  const replacement = await sessions.start("s", "new-device");
  barrier.resolve();
  await expect(old).rejects.toThrow("ended or was disabled");
  expect(launcher.launches.map((launch) => launch.kills)).toEqual([1, 0]);
  expect(await sessions.start("s", "new-device")).toBe(replacement);
  sessions.shutdown();
});
