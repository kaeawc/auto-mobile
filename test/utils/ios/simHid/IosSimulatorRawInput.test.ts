import { describe, expect, test } from "bun:test";
import {
  iosSimulatorRawInputFor,
  SessionIosSimulatorRawInput,
} from "../../../../src/utils/ios/simHid/IosSimulatorRawInput";
import { SimHidLaunchSettle } from "../../../../src/utils/ios/simHid/SimHidLaunchSettle";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeSimHidClient, FakeSimHidSessionAccess } from "./SimHidFakes";

const SIM = "11111111-2222-3333-4444-555555555555";
const PORTRAIT = { width: 402, height: 874 };

function setup(sessions: FakeSimHidSessionAccess) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const settle = new SimHidLaunchSettle(timer, 3000);
  return { timer, settle, input: new SessionIosSimulatorRawInput(SIM, sessions, settle, 30_000) };
}

describe("SessionIosSimulatorRawInput", () => {
  test("preferred mode uses only a running helper and sends the tap in points", async () => {
    const client = new FakeSimHidClient();
    const { input } = setup(new FakeSimHidSessionAccess(client));
    let dispatched = 0;
    const outcome = await input.tap(
      { x: 10, y: 20, holdMs: 50, screen: PORTRAIT },
      { mode: "preferred", onDispatch: () => dispatched++ },
    );
    expect(outcome.status).toBe("delivered");
    expect(dispatched).toBe(1);
    expect(client.commands).toEqual([
      {
        command: { cmd: "tap", x: 10, y: 20, holdMs: 50, width: 402, height: 874 },
        timeoutMs: 3050,
      },
    ]);
  });

  test("onDispatch fires only after a delivered or indeterminate reply, never for sent:false", async () => {
    const notSent = new FakeSimHidClient({ status: "unavailable", reason: "no message" });
    const { input } = setup(new FakeSimHidSessionAccess(notSent));
    let dispatched = 0;
    const tap = await input.tap(
      { x: 1, y: 1, holdMs: 0, screen: PORTRAIT },
      { mode: "preferred", onDispatch: () => dispatched++ },
    );
    expect(tap.status).toBe("unavailable");
    expect(notSent.commands).toHaveLength(1);
    expect(dispatched).toBe(0);
    notSent.outcome = { status: "indeterminate", reason: "timed out" };
    await input.button("lock", { mode: "preferred", onDispatch: () => dispatched++ });
    expect(dispatched).toBe(1);
  });

  test("no running helper is unavailable in preferred mode; fallback waits for one", async () => {
    const started = new FakeSimHidClient();
    const sessions = new FakeSimHidSessionAccess(undefined, started);
    const { input } = setup(sessions);
    expect((await input.button("home", { mode: "preferred" })).status).toBe("unavailable");
    expect(sessions.acquireCalls).toEqual([]);
    expect((await input.button("lock", { mode: "fallback" })).status).toBe("delivered");
    expect(sessions.acquireCalls).toEqual([30_000]);
    expect(started.commands[0]!.command).toEqual({ cmd: "button", button: "lock" });
  });

  test("landscape or unknown screens and unmapped keys stay on CtrlProxy", async () => {
    const client = new FakeSimHidClient();
    const { input } = setup(new FakeSimHidSessionAccess(client));
    const landscape = await input.swipe(
      {
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        durationMs: 300,
        screen: { width: 874, height: 402 },
      },
      { mode: "preferred" },
    );
    expect(landscape).toEqual({ status: "unavailable", reason: "landscape layouts use CtrlProxy" });
    expect((await input.tap({ x: 1, y: 1, holdMs: 0 }, { mode: "fallback" })).status).toBe(
      "unavailable",
    );
    expect((await input.key("search", [], { mode: "preferred" })).status).toBe("unavailable");
    expect(client.commands).toEqual([]);
  });

  test("touches wait out a recent app launch; keys do not", async () => {
    const client = new FakeSimHidClient();
    const { input, settle, timer } = setup(new FakeSimHidSessionAccess(client));
    settle.noteLaunch(SIM);
    timer.advanceTime(1000);
    await input.key("enter", ["shift"], { mode: "preferred" });
    expect(timer.getSleepHistory()).toEqual([]);
    await input.swipe(
      { from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationMs: 300, screen: PORTRAIT },
      { mode: "preferred" },
    );
    expect(timer.getSleepHistory()).toEqual([2000]);
    expect(client.commands.map((entry) => entry.command.cmd)).toEqual(["key", "swipe"]);
  });

  test("an aborted signal sends nothing", async () => {
    const client = new FakeSimHidClient();
    const { input } = setup(new FakeSimHidSessionAccess(client));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      input.button("home", { mode: "preferred", signal: controller.signal }),
    ).rejects.toThrow();
    expect(client.commands).toEqual([]);
  });

  test("only iOS simulators get a HID route", () => {
    const sessions = new FakeSimHidSessionAccess();
    expect(iosSimulatorRawInputFor({ platform: "ios", deviceId: SIM }, sessions)).toBeDefined();
    expect(
      iosSimulatorRawInputFor({ platform: "ios", deviceId: "00008030-001C2D3E1234567A" }, sessions),
    ).toBeUndefined();
    expect(
      iosSimulatorRawInputFor({ platform: "android", deviceId: SIM }, sessions),
    ).toBeUndefined();
  });
});
