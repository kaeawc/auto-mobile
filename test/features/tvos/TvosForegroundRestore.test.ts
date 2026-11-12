import { afterEach, expect, test } from "bun:test";
import { TargetAppForegroundRestore } from "../../../src/features/tvos/TvosForegroundRestore";
import { requireTvosRunner } from "../../../src/features/tvos/TvosRunnerRecovery";
import { TvosRunnerLifecycle } from "../../../src/features/tvos/TvosRunnerLifecycle";
import { InMemoryVisionosTargetApps } from "../../../src/features/visionos/VisionosTargetApps";
import { ActionableError } from "../../../src/models/ActionableError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";
import { FakeTvosRunnerLauncher } from "../../fakes/FakeTvosRunnerLauncher";

// Launching the tvOS runner foregrounds its host app; the app under test is brought back (#18020).

const DEVICE = "foreground-tvos";
const APP = "dev.example.tvapp";

class RecordingActivator {
  readonly calls: string[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  result: { success: boolean; error?: string } = { success: true };
  /** When set, activation stays pending until its signal aborts, like a hung `simctl launch`. */
  hangUntilAborted = false;
  aborted = 0;
  activate = async (deviceId: string, bundleId: string, signal?: AbortSignal) => {
    this.calls.push(`${deviceId} ${bundleId}`);
    this.signals.push(signal);
    if (this.hangUntilAborted) {
      // The production adapter kills the simctl child and reports a failed launch.
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.aborted++;
      return { success: false, error: "simctl launch killed" };
    }
    return this.result;
  };
}

const owners: TvosRunnerLifecycle[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stopAll();
  }
});

function fixture(launchedApp: string | null = APP, timer = new FakeTimer()) {
  const targetApps = new InMemoryVisionosTargetApps();
  if (launchedApp !== null) {
    targetApps.launched(DEVICE, launchedApp);
  }
  const activator = new RecordingActivator();
  const launcher = new FakeTvosRunnerLauncher(new FakeTvosRunnerClient());
  const owner = new TvosRunnerLifecycle({
    timer,
    launcher,
    artifacts: { resolve: async () => "/products/AutoMobileTVTest_appletvsimulator.xctestrun" },
    ports: { allocate: () => 9010, release: () => {} },
    foreground: new TargetAppForegroundRestore({ targetApps, activate: activator.activate }),
  });
  owners.push(owner);
  return { owner, launcher, activator };
}

test("a launched runner brings the last-launched app back to the foreground", async () => {
  const f = fixture();
  expect(await f.owner.start({ deviceId: DEVICE })).toMatchObject({});
  expect(f.launcher.calls).toEqual(["launch"]);
  expect(f.activator.calls).toEqual([`${DEVICE} ${APP}`]);
});

test("without a launched app nothing is activated", async () => {
  const f = fixture(null);
  await f.owner.start({ deviceId: DEVICE });
  expect(f.activator.calls).toEqual([]);
});

test("a reused runner does not re-activate the app", async () => {
  const f = fixture();
  await f.owner.start({ deviceId: DEVICE });
  await f.owner.start({ deviceId: DEVICE });
  expect(f.launcher.calls).toEqual(["launch"]);
  expect(f.activator.calls).toHaveLength(1);
});

test("a failed activation keeps the runner usable", async () => {
  const f = fixture();
  f.activator.result = { success: false, error: "app not installed" };
  const started = await f.owner.start({ deviceId: DEVICE });
  expect(started.runnerUnavailable).toBeUndefined();
  expect(f.launcher.stops).toBe(0);
});

test("an automatic runner restart brings the app back as well", async () => {
  const f = fixture();
  await f.owner.start({ deviceId: DEVICE });
  f.launcher.client.close();
  const replacement = new FakeTvosRunnerLauncher(new FakeTvosRunnerClient());
  f.launcher.launch = (options) => replacement.launch(options);
  await requireTvosRunner(DEVICE, undefined, f.owner);
  expect(f.activator.calls).toEqual([`${DEVICE} ${APP}`, `${DEVICE} ${APP}`]);
});

test("the restore names launchApp when simctl cannot activate the app", async () => {
  const activator = new RecordingActivator();
  activator.result = { success: false, error: "not installed" };
  const targetApps = new InMemoryVisionosTargetApps();
  targetApps.launched(DEVICE, APP);
  const restore = new TargetAppForegroundRestore({ targetApps, activate: activator.activate });
  const error = await restore.restore(DEVICE).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ActionableError);
  expect(String(error)).toContain("Call launchApp");
});

test("the restore forwards its signal and rejects with the abort when activation is cut short", async () => {
  const activator = new RecordingActivator();
  activator.hangUntilAborted = true;
  const targetApps = new InMemoryVisionosTargetApps();
  targetApps.launched(DEVICE, APP);
  const restore = new TargetAppForegroundRestore({ targetApps, activate: activator.activate });
  const controller = new AbortController();
  const pending = restore.restore(DEVICE, controller.signal).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(activator.signals).toEqual([controller.signal]);
  const reason = new Error("session released");
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(activator.aborted).toBe(1);
});

test("aborting startDevice during activation stops the launch and releases the start", async () => {
  const f = fixture();
  f.activator.hangUntilAborted = true;
  const controller = new AbortController();
  const started = f.owner.start({ deviceId: DEVICE, signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.activator.calls).toEqual([`${DEVICE} ${APP}`]);
  controller.abort();
  const result = await started;
  expect(f.activator.aborted).toBe(1);
  expect(f.activator.signals[0]?.aborted).toBe(true);
  expect(result.runnerUnavailable).toBeDefined();
  expect(f.launcher.stops).toBe(1);
});

test("a recovery timeout during activation stops the launch", async () => {
  const timer = new FakeTimer();
  const f = fixture(APP, timer);
  await f.owner.start({ deviceId: DEVICE });
  f.launcher.client.close();
  const replacement = new FakeTvosRunnerLauncher(new FakeTvosRunnerClient());
  f.launcher.launch = (options) => replacement.launch(options);
  f.activator.hangUntilAborted = true;
  const recovery = requireTvosRunner(DEVICE, undefined, f.owner).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  for (let tick = 0; tick < 10 && f.activator.calls.length < 2; tick++) {
    await Promise.resolve();
  }
  expect(f.activator.calls).toHaveLength(2);
  await timer.advanceTimersByTimeAsync(65_000);
  expect(await recovery).toBeInstanceOf(ActionableError);
  expect(f.activator.aborted).toBe(1);
  expect(f.activator.signals[1]?.aborted).toBe(true);
});
