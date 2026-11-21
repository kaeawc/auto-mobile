import { afterEach, expect, test } from "bun:test";
import { WatchRunnerLifecycle } from "../../../src/features/watch/WatchRunnerLifecycle";
import {
  requireWatchRunner,
  withWatchRunnerRead,
  type WatchRunnerRecoveryLifecycle,
} from "../../../src/features/watch/WatchRunnerRecovery";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { watchPress, watchTapAt, watchSwipeOn } from "../../../src/features/watch/WatchActions";
import type { WatchRunnerClient } from "../../../src/features/watch/WatchRunnerClient";
import type { WatchRunnerLauncher } from "../../../src/features/watch/WatchRunnerLauncher";
import { observeWatch } from "../../../src/server/observeWatch";
import type { BootedDevice } from "../../../src/models";
import { getStructuredPayload } from "../../../src/utils/toolUtils";
import type { WatchObservation } from "../../../src/models/WatchObservation";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { FakeWatchRunnerLauncher } from "../../fakes/FakeWatchRunnerLauncher";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../../fakes/FakeTimer";

const DEVICE = "recovery-watch";
const owners: WatchRunnerLifecycle[] = [];
const unregisters: (() => void)[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stopAll();
  }
  for (const unregister of unregisters.splice(0)) {
    unregister();
  }
});

/** A real lifecycle over a fake launcher whose Nth launch registers the Nth client. */
function ownedFixture(clients: WatchRunnerClient[], launcher?: WatchRunnerLauncher) {
  const fake = new FakeWatchRunnerLauncher(clients.at(-1) ?? new FakeWatchRunnerClient(), clients);
  const owner = new WatchRunnerLifecycle({
    launcher: launcher ?? fake,
    artifacts: { resolve: async () => "/products/CtrlProxyWatch_watchsimulator.xctestrun" },
    ports: { allocate: () => 9010, release: () => {} },
  });
  owners.push(owner);
  return { owner, launcher: fake };
}

/** Records restarts without launching anything. */
class FakeRecoveryLifecycle implements WatchRunnerRecoveryLifecycle {
  restarts = 0;
  constructor(
    private readonly owned: boolean,
    private readonly onRestart: () => string | undefined = () => undefined,
  ) {}
  ownsRunner(): boolean {
    return this.owned;
  }
  async restartOwned(): Promise<string | undefined> {
    this.restarts++;
    return this.onRestart();
  }
}

/** Usable until its first request, which drops the connection mid-flight. */
class DroppingWatchRunnerClient extends FakeWatchRunnerClient {
  override async request(...args: Parameters<FakeWatchRunnerClient["request"]>) {
    this.failure ??= new Error("Watch runner disconnected; reconnect it.");
    return super.request(...args);
  }
}

function register(client: WatchRunnerClient): void {
  unregisters.push(watchRunners.register(DEVICE, client));
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test("a usable runner is returned without a restart", async () => {
  const client = new FakeWatchRunnerClient();
  register(client);
  const lifecycle = new FakeRecoveryLifecycle(true);
  expect(await requireWatchRunner(DEVICE, undefined, lifecycle)).toBe(client);
  expect(await withWatchRunnerRead(DEVICE, (c) => c.hierarchy(), undefined, lifecycle)).toBe(
    client.tree,
  );
  expect(lifecycle.restarts).toBe(0);
});

test("a closed owned runner is restarted once for the same bundle and the action then succeeds", async () => {
  const dropped = new FakeWatchRunnerClient();
  const fresh = new FakeWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropped, fresh]);
  await owner.start({ deviceId: DEVICE, bundleId: "dev.example.watch" });
  dropped.close();

  const client = await requireWatchRunner(DEVICE, undefined, owner);
  await client.request({ type: "tap", x: 10, y: 20 });

  expect(client).toBe(fresh);
  expect(fresh.commands).toEqual([{ type: "tap", x: 10, y: 20 }]);
  expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([
    "dev.example.watch",
    "dev.example.watch",
  ]);
  expect(launcher.stops).toBe(1);
  expect(owner.targetBundleId(DEVICE)).toBe("dev.example.watch");
});

/** Registers like the real launcher and can simulate xcodebuild exiting, which unregisters. */
class ExitingWatchRunnerLauncher implements WatchRunnerLauncher {
  launches = 0;
  private unregister = () => {};
  constructor(private readonly clients: WatchRunnerClient[]) {}
  async launch(options: { deviceId: string }): Promise<{ stop(): void }> {
    const client = this.clients[this.launches++]!;
    this.unregister = watchRunners.register(options.deviceId, client);
    return { stop: () => this.exit() };
  }
  exit(): void {
    this.unregister();
  }
}

test("an owned runner whose process exited and unregistered is restarted", async () => {
  const fresh = new FakeWatchRunnerClient();
  const launcher = new ExitingWatchRunnerLauncher([new FakeWatchRunnerClient(), fresh]);
  const { owner } = ownedFixture([], launcher);
  await owner.start({ deviceId: DEVICE });
  launcher.exit();
  expect(watchRunners.get(DEVICE)).toBeUndefined();

  expect(await requireWatchRunner(DEVICE, undefined, owner)).toBe(fresh);
  expect(launcher.launches).toBe(2);
});

test("concurrent callers share one restart of a dropped owned runner", async () => {
  const dropped = new FakeWatchRunnerClient();
  const fresh = new FakeWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropped, fresh]);
  await owner.start({ deviceId: DEVICE });
  dropped.close();

  const [first, second] = await Promise.all([
    requireWatchRunner(DEVICE, undefined, owner),
    requireWatchRunner(DEVICE, undefined, owner),
  ]);

  expect(first).toBe(fresh);
  expect(second).toBe(fresh);
  expect(launcher.launches).toHaveLength(2);
});

test("a closed runner AutoMobile did not start is refused without a restart", async () => {
  const client = new FakeWatchRunnerClient();
  client.close();
  register(client);
  const lifecycle = new FakeRecoveryLifecycle(false);

  await expect(requireWatchRunner(DEVICE, undefined, lifecycle)).rejects.toThrow(
    `The watch runner for ${DEVICE} is disconnected and was not started by AutoMobile; restart it before trying again.`,
  );
  expect(lifecycle.restarts).toBe(0);
});

test("a device with no runner keeps the start-and-connect refusal", async () => {
  await expect(
    requireWatchRunner(DEVICE, undefined, new FakeRecoveryLifecycle(false)),
  ).rejects.toThrow(`Start and connect the watch XCUITest runner for ${DEVICE} before acting.`);
});

test("a failed restart surfaces an actionable error and is not retried", async () => {
  const client = new FakeWatchRunnerClient();
  client.close();
  register(client);
  const lifecycle = new FakeRecoveryLifecycle(true, () => "Watch runner startup timed out");

  const error = await rejection(requireWatchRunner(DEVICE, undefined, lifecycle));

  expect(String(error)).toContain(
    `The watch runner for ${DEVICE} disconnected and could not be restarted: Watch runner startup timed out. Call startDevice`,
  );
  expect(lifecycle.restarts).toBe(1);
});

test("a read that drops mid-request restarts the owned runner once and repeats", async () => {
  const dropping = new DroppingWatchRunnerClient();
  const fresh = new FakeWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropping, fresh]);
  await owner.start({ deviceId: DEVICE });
  expect(dropping.isUsable()).toBe(true);

  const tree = await withWatchRunnerRead(DEVICE, (client) => client.hierarchy(), undefined, owner);

  expect(tree).toBe(fresh.tree);
  expect(launcher.launches).toHaveLength(2);
});

test("a read that fails again after a restart surfaces the error instead of looping", async () => {
  const dropped = new FakeWatchRunnerClient();
  const alsoDropping = new DroppingWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropped, alsoDropping]);
  await owner.start({ deviceId: DEVICE });
  dropped.close();

  await expect(
    withWatchRunnerRead(DEVICE, (client) => client.hierarchy(), undefined, owner),
  ).rejects.toThrow("Watch runner disconnected; reconnect it.");
  expect(launcher.launches).toHaveLength(2);
});

test("a read error from a still-usable runner is not treated as a drop", async () => {
  const client = new FakeWatchRunnerClient();
  register(client);
  const lifecycle = new FakeRecoveryLifecycle(true);
  await expect(
    withWatchRunnerRead(
      DEVICE,
      async () => {
        throw new Error("element not found");
      },
      undefined,
      lifecycle,
    ),
  ).rejects.toThrow("element not found");
  expect(lifecycle.restarts).toBe(0);
});

test("tapAt, swipeOn and home refuse a dropped unowned runner before sending a command", async () => {
  const client = new FakeWatchRunnerClient();
  client.close();
  register(client);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const refusal =
    "is disconnected and was not started by AutoMobile; restart it before trying again.";

  await expect(watchTapAt(DEVICE, { x: 1, y: 2 }, undefined, timer)).rejects.toThrow(refusal);
  await expect(watchSwipeOn(DEVICE, { direction: "up" })).rejects.toThrow(refusal);
  await expect(watchPress(DEVICE, "home")).rejects.toThrow(refusal);
  expect(client.commands).toEqual([]);
});

const watch: BootedDevice = { name: "Apple Watch", deviceId: DEVICE, platform: "watchos" };

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test("observe restarts a dropped owned watch runner and returns its hierarchy", async () => {
  const dropped = new FakeWatchRunnerClient();
  const fresh = new FakeWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropped, fresh]);
  await owner.start({ deviceId: DEVICE });
  dropped.close();
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);

  const response = await observeWatch(watch, {}, undefined, {
    screenshots: { capture: async () => pngOfSize(416, 496) },
    watchRunnerLifecycle: owner,
    heldDeviceRead: () => false,
    watchTargetApp: { notRunningTarget: async () => undefined },
    timer,
    idGenerator: new CountingIdGenerator("watch"),
    fileWriter: new FakeScreenshotFileWriter(),
    pathProtection: new FakeScreenshotPathProtection(timer),
    cacheDir: () => "/cache/screenshots",
  });

  const result = getStructuredPayload<WatchObservation>(response)!;
  expect(Object.hasOwn(result, "hierarchyUnavailable")).toBe(false);
  expect(Object.hasOwn(result, "viewHierarchy")).toBe(true);
  expect(launcher.launches).toHaveLength(2);
  expect(fresh.commands[0]).toEqual({ type: "hierarchy" });
});

test("a sessionless read of a held device never restarts its dropped runner", async () => {
  const dropped = new FakeWatchRunnerClient();
  const { owner, launcher } = ownedFixture([dropped, new FakeWatchRunnerClient()]);
  await owner.start({ deviceId: DEVICE });
  dropped.close();
  const timer = new FakeTimer();

  await rejection(
    observeWatch(watch, {}, undefined, {
      screenshots: { capture: async () => pngOfSize(416, 496) },
      watchRunnerLifecycle: owner,
      heldDeviceRead: () => true,
      watchTargetApp: { notRunningTarget: async () => undefined },
      timer,
      idGenerator: new CountingIdGenerator("watch"),
      fileWriter: new FakeScreenshotFileWriter(),
      pathProtection: new FakeScreenshotPathProtection(timer),
      cacheDir: () => "/cache/screenshots",
    }),
  );
  expect(launcher.launches).toHaveLength(1);
});
