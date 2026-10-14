import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { executionTracker } from "../../src/server/executionTracker";
import { LivenessScenario } from "../helpers/livenessScenarioHarness";
import { PIXEL, PIXEL_FOLD, type WireFixture } from "./helpers/desktopWireHarness";

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "desktop-wire");
const DESKTOP_1 = "d0000000-0000-4000-8000-000000000001";
const DESKTOP_2 = "d0000000-0000-4000-8000-000000000002";
const AGENT = "a0000000-0000-4000-8000-00000000000a";

// Capture setup: desktopWireContract.test.ts:59 and :639. Other out-of-band events are
// derived in replay from agent-bind/release and daemon-restart's heartbeat-lapse (:96-102,
// :240-243, :532). End holders mirror each contract row's assertions and description.
// Daemon.startOn rehydrates persisted sessions (src/daemon/daemon.ts:1685-1688), whereas
// the capture restarts with fresh fake persistence. Pin both actual envelopes, not a relaxed
// comparison: the old heartbeat succeeds and release finds a real held device.
const RESTART_MISMATCHES = [
  `heartbeat-lapse#0: ${JSON.stringify({ success: true, result: { sessionId: DESKTOP_1 } })}`,
  `release-lapsed#0: ${JSON.stringify({ success: true, result: { message: `Session ${DESKTOP_1} released`, device: PIXEL.deviceId, alreadyReleased: false } })}`,
];

const ROWS = [
  { name: "no-click-start", holders: [null, null] },
  { name: "bind-error-not-ownership", holders: [null, null], missingPixel: true },
  { name: "bound-device-control", holders: [DESKTOP_1, null] },
  { name: "close-pane-releases-device", holders: [DESKTOP_2, null] },
  { name: "daemon-restart", holders: [DESKTOP_2, null] },
  { name: "first-tap-binds-device", holders: [DESKTOP_1, null] },
  { name: "heartbeat-expiry", holders: [null, null] },
  { name: "held-by-another-session", holders: [DESKTOP_1, null] },
  { name: "held-device-input-refused", holders: [AGENT, null] },
  { name: "hidden-window-release", holders: [DESKTOP_2, null] },
  { name: "idle-release", holders: [DESKTOP_2, null] },
  { name: "input-keeps-session", holders: [DESKTOP_1, null] },
  { name: "quit-releases-device", holders: [null, null] },
  { name: "released-session-tap", holders: [null, DESKTOP_2] },
  { name: "tap-held-device-releases-previous", holders: [null, AGENT] },
  { name: "watching-allocates-nothing", holders: [null, null] },
];

let scenario: LivenessScenario | undefined;
afterEach(async () => {
  const current = scenario;
  try {
    await current?.stop();
  } finally {
    scenario = undefined;
  }
  // Windows runs unit files in one process: every row, including failures, resets the singletons.
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
  expect(executionTracker.getActiveExecutionCount()).toBe(0);
});

function fixture(name: string): WireFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as WireFixture;
}

async function start(missingPixel = false): Promise<LivenessScenario> {
  scenario = await LivenessScenario.start({
    devices: missingPixel ? [PIXEL_FOLD.deviceId] : [PIXEL.deviceId, PIXEL_FOLD.deviceId],
    deviceNames: { [PIXEL.deviceId]: PIXEL.name, [PIXEL_FOLD.deviceId]: PIXEL_FOLD.name },
  });
  return scenario;
}

// The first scenario pays for module-level one-time costs (database template, Daemon module graph).
// beforeAll is outside the per-test budget: replay a throwaway register -> bind -> tap -> release
// cycle so the first use of session setup, input dispatch and release also stays outside each row.
beforeAll(async () => {
  const warm = await LivenessScenario.start({
    devices: [PIXEL.deviceId, PIXEL_FOLD.deviceId],
    deviceNames: { [PIXEL.deviceId]: PIXEL.name, [PIXEL_FOLD.deviceId]: PIXEL_FOLD.name },
  });
  try {
    await warm.replayDesktopFixture(fixture("close-pane-releases-device"));
  } finally {
    await warm.stop();
  }
});

describe("started daemon desktop fixture replay", () => {
  test("every captured fixture has a scenario row", () => {
    expect(
      readdirSync(FIXTURE_DIR)
        .filter((name) => name.endsWith(".json"))
        .sort(),
    ).toEqual(ROWS.map(({ name }) => `${name}.json`).sort());
  });

  for (const row of ROWS) {
    test(`replay ${row.name}`, async () => {
      const live = await start(row.missingPixel);
      const captured = fixture(row.name);
      const replay = await live.replayDesktopFixture(captured);
      expect(replay.drivenFrames).toBe(
        captured.exchanges.reduce((count, frame) => count + (frame.repeat ?? 1), 0),
      );
      expect(replay.skipped).toEqual([]);
      expect(replay.mismatches).toEqual(row.name === "daemon-restart" ? RESTART_MISMATCHES : []);
      expect(replay.unclaimedInputs).toEqual([]);
      expect(replay.unclaimedControls).toEqual([]);
      expect([
        live.poolState(PIXEL.deviceId).sessionId,
        live.poolState(PIXEL_FOLD.deviceId).sessionId,
      ]).toEqual(row.holders);
    });
  }

  test("claim-before-input detects the captured desktop with its bind removed (n/K2 negative control)", async () => {
    const live = await start();
    const captured = fixture("first-tap-binds-device");
    // Drop captured frames only: do not synthesize or modify a request.
    captured.exchanges = captured.exchanges.filter(
      (frame) => frame.actor !== "desktop" || frame.request.params.name !== "setActiveDevice",
    );
    const replay = await live.replayDesktopFixture(captured);
    expect(replay.skipped).toEqual([]);
    expect(replay.unclaimedInputs).toEqual(["tap#0"]);
    expect(replay.unclaimedControls).toEqual([]);
    expect(replay.mismatches).toEqual([
      'held#0: {"success":true,"result":{"activeSessions":0,"activeExecutions":0,"sessions":[]}}',
    ]);
    expect(live.poolState().sessionId).toBeNull();
  });

  test("a control with the desktop's bind removed is refused: no unclaimed control succeeds (K3 negative control)", async () => {
    const live = await start();
    const captured = fixture("bound-device-control");
    // Drop captured frames only: do not synthesize or modify a request.
    captured.exchanges = captured.exchanges.filter(
      (frame) => frame.actor !== "desktop" || frame.request.params.name !== "setActiveDevice",
    );
    const replay = await live.replayDesktopFixture(captured);
    expect(replay.skipped).toEqual([]);
    // sessionManager.ts:5113-5122 keeps an observer registration from becoming an active session until bound.
    expect(replay.unclaimedControls).toEqual([]);
    expect(replay.unclaimedInputs).toEqual([]);
    expect(replay.mismatches).toEqual([
      `rotate#0: ${JSON.stringify({
        success: true,
        result: {
          content: [
            {
              type: "text",
              text: `Error: Session ${DESKTOP_1} is not an active daemon session (not found). Acquire a device with getAndroid or getApple before using its sessionUuid.`,
            },
          ],
          isError: true,
        },
      })}`,
    ]);
    expect(live.poolState().sessionId).toBeNull();
  });
});
