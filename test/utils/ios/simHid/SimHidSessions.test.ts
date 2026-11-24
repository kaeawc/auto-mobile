import { describe, expect, test } from "bun:test";
import { SimHidSessions } from "../../../../src/utils/ios/simHid/SimHidSessions";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeSimHidLauncher, FakeSimHidProvider } from "./SimHidFakes";

const SIM = "11111111-2222-3333-4444-555555555555";
const OTHER_SIM = "66666666-7777-8888-9999-000000000000";

function setup(enabled = true) {
  const provider = new FakeSimHidProvider();
  const launcher = new FakeSimHidLauncher();
  const timer = new FakeTimer();
  const sessions = new SimHidSessions({
    enabled: () => enabled,
    provider,
    launcher,
    idGenerator: new FakeIdGenerator(),
    timer,
    retryAfterFailureMs: 1000,
    retryAfterBuildFailureMs: 60_000,
  });
  return { provider, launcher, timer, sessions };
}

describe("SimHidSessions", () => {
  test("ready() starts one helper in the background and then reuses it", async () => {
    const { launcher, sessions, provider } = setup();
    expect(sessions.ready(SIM)).toBeUndefined();
    const client = await sessions.acquire(SIM, 1000);
    expect(client).toBeDefined();
    expect(sessions.ready(SIM)).toBe(client);
    expect(launcher.launches).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  test("a helper that exited is replaced on the next call", async () => {
    const { launcher, sessions } = setup();
    await sessions.acquire(SIM, 1000);
    launcher.launches[0]!.transport.exit();
    expect(sessions.ready(SIM)).toBeUndefined();
    await sessions.acquire(SIM, 1000);
    expect(launcher.launches).toHaveLength(2);
    expect(launcher.launches[0]!.kills).toBe(1);
  });

  test("a failed spawn is not retried until the cooldown passes", async () => {
    const { launcher, provider, sessions, timer } = setup();
    launcher.failure = new Error("spawn EAGAIN");
    expect(await sessions.acquire(SIM, 1000)).toBeUndefined();
    expect(await sessions.acquire(SIM, 1000)).toBeUndefined();
    expect(provider.calls).toBe(1);
    timer.advanceTime(1000);
    launcher.failure = undefined;
    expect(await sessions.acquire(SIM, 1000)).toBeDefined();
    expect(provider.calls).toBe(2);
  });

  test("a failed build waits the long build cooldown for every simulator", async () => {
    const { provider, sessions, timer } = setup();
    provider.failure = new Error("swiftc: error: cannot find type");
    expect(await sessions.acquire(SIM, 1000)).toBeUndefined();
    timer.advanceTime(1000);
    expect(await sessions.acquire(SIM, 1000)).toBeUndefined();
    expect(await sessions.acquire(OTHER_SIM, 1000)).toBeUndefined();
    expect(provider.calls).toBe(1);
    timer.advanceTime(60_000 - 1000);
    provider.failure = undefined;
    expect(await sessions.acquire(SIM, 1000)).toBeDefined();
    expect(provider.calls).toBe(2);
  });

  test("acquire() gives up after its wait while the start continues", async () => {
    const { launcher, sessions, timer } = setup();
    let open: () => void = () => {};
    launcher.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const waiting = sessions.acquire(SIM, 500);
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(500);
    expect(await waiting).toBeUndefined();
    open();
    expect(await sessions.acquire(SIM, 500)).toBeDefined();
  });

  test("release during startup kills the late helper; shutdown stops everything", async () => {
    const { launcher, sessions } = setup();
    let open: () => void = () => {};
    launcher.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const starting = sessions.acquire(SIM, 10_000);
    // Let the build finish so the launch is in flight when the session ends.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    sessions.release(SIM);
    open();
    expect(await starting).toBeUndefined();
    expect(launcher.launches[0]!.kills).toBe(1);
    launcher.gate = undefined;
    await sessions.acquire("other", 1000);
    sessions.shutdown();
    expect(launcher.launches[1]!.kills).toBe(1);
    expect(sessions.ready("other")).toBeUndefined();
  });

  test("disabled sessions never start a helper", async () => {
    const { launcher, sessions } = setup(false);
    expect(sessions.ready(SIM)).toBeUndefined();
    expect(await sessions.acquire(SIM, 1000)).toBeUndefined();
    expect(launcher.launches).toHaveLength(0);
  });
});
