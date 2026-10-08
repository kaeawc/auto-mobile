import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DAEMON_OWNED_SESSIONS_PARAM } from "../../src/daemon/constants";
import {
  DESKTOP_CLIENT_NAME,
  DesktopWireHarness,
  PIXEL,
  PIXEL_FOLD,
  type WireFixture,
} from "./helpers/desktopWireHarness";

/*
 * Desktop/IDE <-> daemon wire contract (#10669).
 *
 * Each scenario replays the frames the desktop-core module sends for one studio UI
 * transition (McpDaemonClient.kt builds them; DesktopDaemonSessionComposition.kt
 * decides when) against the REAL daemon handlers, and checks the answers into
 * test/fixtures/desktop-wire/<scenario>.json. The Kotlin suite
 * DesktopWireFixtureCompositionTest replays those fixtures through
 * rememberDesktopDaemonSession and asserts the client's frames equal the
 * fixture's desktop frames and the resulting UI state. So:
 *   - a daemon change that alters an answer fails the drift check here;
 *   - a client change that alters the frame sequence fails the Kotlin replay.
 *
 * Regenerate after an intended change on either side:
 *   UPDATE_CAPTURED_FIXTURES=1 bun test test/daemon/desktopWireContract.test.ts
 * then run the Gradle task `:desktop-core:test`.
 *
 * Session UUIDs are fixed so the fixtures are deterministic; the Kotlin replay
 * mints them from the fixture's `sessions` map in the order the client creates
 * sessions ("desktop-1", "desktop-2", ...).
 *
 * Owner decisions 2026-10-08 (#10730): desktop input is active tool use and
 * watching is not, and the desktop may watch any device. So the client
 * registers an observer session that allocates nothing, allocates a device
 * (`setActiveDevice`) only on the first input to it, and after the daemon drops
 * the hold (idle release, restart, expiry) rotates to a fresh observer session
 * and never re-sends the bind on its own.
 */

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "desktop-wire");
const DESKTOP_1 = "d0000000-0000-4000-8000-000000000001";
const DESKTOP_2 = "d0000000-0000-4000-8000-000000000002";
const AGENT = "a0000000-0000-4000-8000-00000000000a";
// DesktopDaemonSessionComposition.kt HIDDEN_RELEASE_GRACE_MS (10 s) at one heartbeat per 2 s.
const HIDDEN_GRACE_TICKS = 5;
const IDLE_WINDOW_TICKS = 120; // > 2 min idle window + one cleanup sweep at 2 s per tick
const TEN_MINUTES_TICKS = 300;
const MINUTE_TICKS = 30;

let harness: DesktopWireHarness | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

async function startHarness(devices = [PIXEL, PIXEL_FOLD]): Promise<DesktopWireHarness> {
  harness = new DesktopWireHarness(devices);
  await harness.start();
  return harness;
}

/**
 * `tools/call setActiveDevice` exactly as McpDaemonClient.setActiveDevice + callTool build it: the
 * client's own `sessionUuid`, and its owned-session list, which it seeds with that UUID.
 */
function bindParams(sessionUuid: string, deviceId: string = PIXEL.deviceId) {
  return {
    name: "setActiveDevice",
    arguments: {
      deviceId,
      platform: "android",
      sessionUuid,
      [DAEMON_OWNED_SESSIONS_PARAM]: [sessionUuid],
    },
  };
}

/** McpDaemonClient.registerSession (RegisterSessionRequest). */
function registerParams(sessionId: string) {
  return { sessionId, clientName: DESKTOP_CLIENT_NAME };
}

/**
 * McpDaemonClient.inputTap with no duration/frameContext; withInputSession adds the session the
 * input acts for (#10698), which the daemon's input ownership check reads.
 */
function tapParams(sessionUuid: string, deviceId: string = PIXEL.deviceId) {
  return { platform: "android", deviceId, x: 540, y: 1200, sessionUuid };
}

const WHO_HOLDS = { includeSessions: true };

/** Another client (an agent's MCP proxy) binds `deviceId` and keeps its session alive. */
async function agentHolds(wire: DesktopWireHarness, deviceId: string): Promise<void> {
  const answer = await wire.send("agent", "agent-bind", "tools/call", bindParams(AGENT, deviceId));
  expect(answer.success).toBe(true);
  expect(wire.holderOf(deviceId)).toBe(AGENT);
  wire.keepAlive.add(AGENT);
}

function checkFixture(fixture: WireFixture): void {
  const path = join(FIXTURE_DIR, `${fixture.scenario}.json`);
  const generated = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
    writeFileSync(path, generated);
  }
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}; generate it with UPDATE_CAPTURED_FIXTURES=1 bun test ${import.meta.path}`,
    );
  }
  // Parsed comparison so the diff names the drifted exchange, not a line offset.
  expect(fixture).toEqual(JSON.parse(readFileSync(path, "utf8")) as WireFixture);
}

function textOf(response: { result?: unknown }): string {
  const content = (response.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  return content?.[0]?.text ?? "";
}

function isToolError(response: { result?: unknown }): boolean {
  return (response.result as { isError?: boolean } | undefined)?.isError === true;
}

/** The client starts watching: an observer registration and its first heartbeats. */
async function startWatching(
  wire: DesktopWireHarness,
  sessionId: string,
  ticks: number,
): Promise<void> {
  const register = await wire.send(
    "desktop",
    "register",
    "daemon/registerSession",
    registerParams(sessionId),
  );
  expect(register.success).toBe(true);
  await wire.heartbeats("heartbeat-watching", sessionId, ticks);
}

/**
 * The first input on a free device: the client allocates it, and only then sends the input under
 * the same session.
 */
async function tapAllocating(
  wire: DesktopWireHarness,
  sessionId: string,
  labels: { bind: string; tap: string },
  deviceId: string = PIXEL.deviceId,
): Promise<void> {
  const bind = await wire.send(
    "desktop",
    labels.bind,
    "tools/call",
    bindParams(sessionId, deviceId),
  );
  expect(isToolError(bind)).toBe(false);
  const tap = await wire.send("desktop", labels.tap, "input/tap", tapParams(sessionId, deviceId));
  expect(tap).toMatchObject({ success: true });
  expect(wire.holderOf(deviceId)).toBe(sessionId);
}

describe("desktop wire contract (#10669, #10730)", () => {
  test("watching a focused device for ten minutes allocates nothing", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, TEN_MINUTES_TICKS);
    await wire.send("probe", "nothing-held", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "watching-allocates-nothing",
        "A focused pane that is only watched: an observer registration and ten minutes of " +
          "heartbeats, with no setActiveDevice and nothing held (#10730).",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("the first tap allocates the device, then the tap, then heartbeats only", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 3);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 5);
    await wire.send("probe", "held", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);
    checkFixture(
      wire.fixture(
        "first-tap-binds-device",
        "Watch a free device, then tap it: one bind before the tap, then heartbeats only (#10730).",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("app start with no pane registers an observer and allocates nothing", async () => {
    const wire = await startHarness();
    const register = await wire.send(
      "desktop",
      "register",
      "daemon/registerSession",
      registerParams(DESKTOP_1),
    );
    expect(register.success).toBe(true);
    await wire.heartbeats("heartbeat", DESKTOP_1, 5);
    await wire.send("probe", "nothing-held", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    expect(wire.holderOf(PIXEL_FOLD.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "no-click-start",
        "No pane open: the session registers deviceless and only heartbeats (#10660).",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a tap on a device another session holds is refused, then watched, never grabbed, and taken on request", async () => {
    const wire = await startHarness();
    await agentHolds(wire, PIXEL.deviceId);
    await startWatching(wire, DESKTOP_1, 2);

    // The tap's allocation is refused, so the tap itself is never sent.
    const refused = await wire.send("desktop", "bind-refused", "tools/call", bindParams(DESKTOP_1));
    expect(isToolError(refused)).toBe(true);
    expect(textOf(refused)).toContain(`is already assigned to session ${AGENT}`);
    await wire.heartbeats("heartbeat-viewing", DESKTOP_1, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(AGENT);

    wire.keepAlive.delete(AGENT);
    const release = await wire.send("agent", "agent-release", "daemon/releaseSession", {
      sessionId: AGENT,
    });
    expect(release.success).toBe(true);
    // Another tap here is dropped without a frame: nothing retries.
    await wire.heartbeats("heartbeat-after-holder-release", DESKTOP_1, 5);
    await wire.send("probe", "not-grabbed", "daemon/activeSessions", WHO_HOLDS);
    // Two-sided: the watcher neither held the device while the agent did nor grabbed it after.
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    const takeControl = await wire.send(
      "desktop",
      "take-control",
      "tools/call",
      bindParams(DESKTOP_1),
    );
    expect(isToolError(takeControl)).toBe(false);
    await wire.heartbeats("heartbeat-controlling", DESKTOP_1, 3);
    const tap = await wire.send("desktop", "tap-controlling", "input/tap", tapParams(DESKTOP_1));
    expect(tap).toMatchObject({ success: true });
    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);

    checkFixture(
      wire.fixture(
        "held-by-another-session",
        "Watch a device an agent holds, then tap it: the allocation is refused and the tap " +
          "dropped, the pane keeps watching, nothing grabs the device when the agent releases " +
          "it, and Take control binds it once (#10660, #10730). The agent's session is kept " +
          "alive by unrecorded heartbeats while it holds the device.",
        { "desktop-1": DESKTOP_1, agent: AGENT },
      ),
    );
  });

  test("input and a device control on a device another session holds are refused with a typed code", async () => {
    const wire = await startHarness();
    await agentHolds(wire, PIXEL.deviceId);
    await startWatching(wire, DESKTOP_1, 2);

    // A pane whose session no longer holds the device (the hold lapsed and an agent took it) sends
    // its input and controls under its own session; the daemon refuses both with the typed code
    // the client matches to show the held-elsewhere notice (#10743, #10783).
    const tap = await wire.send("desktop", "tap-refused", "input/tap", tapParams(DESKTOP_1));
    expect(tap).toMatchObject({ success: false, code: "device_owned_by_other_session" });
    const rotate = await wire.send("desktop", "rotate-refused", "tools/call", {
      name: "rotate",
      arguments: {
        orientation: "landscape",
        platform: "android",
        deviceId: PIXEL.deviceId,
        sessionUuid: DESKTOP_1,
        [DAEMON_OWNED_SESSIONS_PARAM]: [DESKTOP_1],
      },
    });
    expect(isToolError(rotate)).toBe(true);
    expect(JSON.parse(textOf(rotate))).toMatchObject({
      success: false,
      code: "device_owned_by_other_session",
      deviceId: PIXEL.deviceId,
      retryable: false,
    });
    await wire.heartbeats("heartbeat-viewing", DESKTOP_1, 2);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(AGENT);

    checkFixture(
      wire.fixture(
        "held-device-input-refused",
        "An agent holds the device and the desktop sends a tap and a rotate under its own " +
          "session: the daemon refuses both with code device_owned_by_other_session (the tap on " +
          "the socket response, the rotate in its tool error payload), and the agent keeps the " +
          "device (#10743, #10783).",
        { "desktop-1": DESKTOP_1, agent: AGENT },
      ),
    );
  });

  test("closing the tapped pane releases the device; reopening it only watches until the next tap", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 2);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    const release = await wire.send("desktop", "release-on-close", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    expect(release.success).toBe(true);
    await wire.send(
      "desktop",
      "register-fresh",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-closed", DESKTOP_2, 3);
    await wire.send("probe", "released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    // The pane opens again: watching only.
    await wire.heartbeats("heartbeat-reopened", DESKTOP_2, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    await tapAllocating(wire, DESKTOP_2, { bind: "bind-on-tap", tap: "tap-reopened" });
    await wire.heartbeats("heartbeat-tapped", DESKTOP_2, 2);

    checkFixture(
      wire.fixture(
        "close-pane-releases-device",
        "Close the pane of the tapped device: the held session is released and a fresh " +
          "observer session registers; reopening the pane allocates nothing until the next " +
          "tap, which binds under the fresh session (#10659, #10730).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("quitting releases the held device", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    const release = await wire.send("desktop", "release-on-quit", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    expect(release.success).toBe(true);
    await wire.send("probe", "released", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "quit-releases-device",
        "Quit (the session composable leaves) releases the session and its device; no frame " +
          "follows.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("hiding the window past the grace after tapping releases the device; showing it only watches (#10695)", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);
    await wire.heartbeats("heartbeat-hidden", DESKTOP_1, HIDDEN_GRACE_TICKS);

    const release = await wire.send("desktop", "release-hidden", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    expect(release.success).toBe(true);
    await wire.send(
      "desktop",
      "register-passive",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-released", DESKTOP_2, 5);
    await wire.send("probe", "released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    // Shown again: nothing binds until the user taps the pane.
    await wire.heartbeats("heartbeat-shown", DESKTOP_2, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    await tapAllocating(wire, DESKTOP_2, { bind: "bind-on-input", tap: "tap-after-show" });
    await wire.heartbeats("heartbeat-rebound", DESKTOP_2, 2);

    checkFixture(
      wire.fixture(
        "hidden-window-release",
        "Close the window to the tray (or hide the IDE tool window) past the grace after a " +
          "tap: the session rotates, releasing the device; showing it again only watches, and " +
          "the first tap binds it under the fresh session (#10695, #10730).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("tapping a held device after a free one releases the free one (#10697)", async () => {
    const wire = await startHarness();
    await agentHolds(wire, PIXEL_FOLD.deviceId);
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    const refused = await wire.send(
      "desktop",
      "bind-held-refused",
      "tools/call",
      bindParams(DESKTOP_1, PIXEL_FOLD.deviceId),
    );
    expect(isToolError(refused)).toBe(true);
    // The daemon refuses before rebinding, so DESKTOP_1 still holds PIXEL until the client
    // rotates its session.
    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);
    await wire.send("desktop", "release-previous", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    await wire.send(
      "desktop",
      "register-viewer",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-viewing", DESKTOP_2, 3);
    await wire.send("probe", "previous-released", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    expect(wire.holderOf(PIXEL_FOLD.deviceId)).toBe(AGENT);
    checkFixture(
      wire.fixture(
        "tap-held-device-releases-previous",
        "Tap a free device, then one an agent holds: the refusal leaves the first hold, which " +
          "the client drops by rotating to a fresh observer session that watches the held " +
          "device without re-sending the bind (#10697, #10730).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2, agent: AGENT },
      ),
    );
  });

  test("an idle release after the last tap drops back to watching and never re-binds (#10693, #10730)", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    const healthyTicks = await wire.heartbeatsUntilLapse("heartbeat", DESKTOP_1, IDLE_WINDOW_TICKS);
    // Released by the 2-minute idle window after the tap, not by a missed heartbeat.
    expect(healthyTicks).toBeGreaterThanOrEqual(60);
    await wire.send("probe", "idle-released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    // The client rotates to a fresh observer session instead of re-sending its bind.
    await wire.send("desktop", "release-lapsed", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    await wire.send(
      "desktop",
      "register-fresh",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    // Still watching well past another idle window: nothing re-acquires the device.
    await wire.heartbeats("heartbeat-watching-after-release", DESKTOP_2, IDLE_WINDOW_TICKS);
    await wire.send("probe", "still-released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    // The next tap allocates it again.
    await tapAllocating(wire, DESKTOP_2, { bind: "bind-on-tap", tap: "tap-after-release" });
    await wire.heartbeats("heartbeat-after-tap", DESKTOP_2, 2);

    checkFixture(
      wire.fixture(
        "idle-release",
        "Tap, then only watch: the idle window releases the session, the next heartbeat is not " +
          "found, and the client drops back to watching under a fresh observer session with no " +
          "re-bind, even past another idle window; the next tap allocates the device again " +
          "(#10693, #10730).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("a tap every minute for ten minutes keeps one allocation (#10693)", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap-minute-0" });
    for (let minute = 1; minute <= 10; minute++) {
      await wire.heartbeats(`heartbeat-minute-${minute}`, DESKTOP_1, MINUTE_TICKS);
      const tap = await wire.send(
        "desktop",
        `tap-minute-${minute}`,
        "input/tap",
        tapParams(DESKTOP_1),
      );
      expect(tap).toMatchObject({ success: true });
    }
    await wire.heartbeats("heartbeat-after-taps", DESKTOP_1, 2);
    await wire.send("probe", "still-held", "daemon/sessionInfo", { sessionId: DESKTOP_1 });

    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);
    checkFixture(
      wire.fixture(
        "input-keeps-session",
        "Pane taps (input/tap) under the desktop session count as activity: one bind on the " +
          "first tap, then ten minutes of one tap per minute never idle-release the session.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a daemon restart drops back to watching under a fresh session; the next tap re-allocates", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    await wire.restartDaemon();
    const lapse = await wire.send("desktop", "heartbeat-lapse", "daemon/heartbeat", {
      sessionId: DESKTOP_1,
    });
    expect(lapse.success).toBe(false);
    await wire.send("desktop", "release-lapsed", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    await wire.send(
      "desktop",
      "register-fresh",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-after-restart", DESKTOP_2, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    await tapAllocating(wire, DESKTOP_2, { bind: "bind-on-tap", tap: "tap-after-restart" });
    await wire.heartbeats("heartbeat-after-tap", DESKTOP_2, 2);

    checkFixture(
      wire.fixture(
        "daemon-restart",
        "A restarted daemon has no record of the session: the heartbeat is not found, and the " +
          "client drops back to watching under a fresh observer session instead of re-binding; " +
          "the next tap allocates the device under it (#10730).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("a stalled client's session expires terminally and the client watches under a fresh session", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    await wire.stall(30_000);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    const lapse = await wire.send("desktop", "heartbeat-lapse", "daemon/heartbeat", {
      sessionId: DESKTOP_1,
    });
    expect(lapse.success).toBe(false);
    await wire.send("desktop", "release-rotated", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    await wire.send(
      "desktop",
      "register-fresh",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-fresh", DESKTOP_2, 3);
    await wire.send("probe", "nothing-held", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "heartbeat-expiry",
        "The client stops heartbeating (host sleep, hung UI) past the liveness lease: the " +
          "reaper releases the session terminally, the next heartbeat is not found, and the " +
          "client watches under a fresh observer session without re-binding.",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("a tap after the session was terminally released allocates under a fresh session", async () => {
    const wire = await startHarness();
    await startWatching(wire, DESKTOP_1, 1);
    await tapAllocating(wire, DESKTOP_1, { bind: "bind", tap: "tap" });
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    // Reaped before the client's next heartbeat noticed; the user taps another pane meanwhile.
    await wire.stall(30_000);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    const refused = await wire.send(
      "desktop",
      "bind-refused-released",
      "tools/call",
      bindParams(DESKTOP_1, PIXEL_FOLD.deviceId),
    );
    expect(isToolError(refused)).toBe(true);
    expect(textOf(refused)).toContain("cannot be reused");
    await wire.send("desktop", "release-rotated", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    await tapAllocating(
      wire,
      DESKTOP_2,
      { bind: "bind-fresh", tap: "tap-fresh" },
      PIXEL_FOLD.deviceId,
    );
    await wire.heartbeats("heartbeat-fresh", DESKTOP_2, 2);

    checkFixture(
      wire.fixture(
        "released-session-tap",
        "A tap on another pane after the reaper terminally released the session: the bind is " +
          "refused as released, the client rotates, and the waiting tap goes through once the " +
          "fresh session allocates the device.",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("a non-ownership bind error on a tap is retried and then surfaced (#10696)", async () => {
    const wire = await startHarness([PIXEL_FOLD]);
    await startWatching(wire, DESKTOP_1, 1);
    const first = await wire.send("desktop", "bind-error-1", "tools/call", bindParams(DESKTOP_1));
    expect(isToolError(first)).toBe(true);
    expect(textOf(first)).not.toContain("already assigned");
    await wire.heartbeats("heartbeat-1", DESKTOP_1, 1);
    await wire.send("desktop", "bind-error-2", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat-2", DESKTOP_1, 1);
    await wire.send("desktop", "bind-error-3", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat-surfaced", DESKTOP_1, 3);

    expect(wire.holderOf(PIXEL_FOLD.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "bind-error-not-ownership",
        "Tap a device the daemon's pool does not have: the tap is dropped, and the allocation " +
          "error is retried a bounded number of times and surfaced, never treated as another " +
          "session's hold.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });
});
