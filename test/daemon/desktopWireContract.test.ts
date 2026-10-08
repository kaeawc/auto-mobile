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
 */

const FIXTURE_DIR = join(import.meta.dir, "..", "fixtures", "desktop-wire");
const DESKTOP_1 = "d0000000-0000-4000-8000-000000000001";
const DESKTOP_2 = "d0000000-0000-4000-8000-000000000002";
const AGENT = "a0000000-0000-4000-8000-00000000000a";
// DesktopDaemonSessionComposition.kt HIDDEN_RELEASE_GRACE_MS (10 s) at one heartbeat per 2 s.
const HIDDEN_GRACE_TICKS = 5;
const IDLE_WINDOW_TICKS = 120; // > 2 min idle window + one cleanup sweep at 2 s per tick

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

describe("desktop wire contract (#10669)", () => {
  test("focus binds the device and heartbeats keep it", async () => {
    const wire = await startHarness();
    const bind = await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    expect(isToolError(bind)).toBe(false);
    await wire.heartbeats("heartbeat", DESKTOP_1, 5);
    await wire.send("probe", "held", "daemon/activeSessions", WHO_HOLDS);

    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);
    checkFixture(
      wire.fixture("focus-binds-device", "Focus a free device: one bind, then heartbeats only.", {
        "desktop-1": DESKTOP_1,
      }),
    );
  });

  test("app start with no click registers an observer and allocates nothing", async () => {
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
        "A null binding (no pane focused) registers deviceless and only heartbeats (#10660).",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a device held by another session is refused, viewed, never grabbed, then taken on request", async () => {
    const wire = await startHarness();
    await agentHolds(wire, PIXEL.deviceId);

    const refused = await wire.send("desktop", "bind-refused", "tools/call", bindParams(DESKTOP_1));
    expect(isToolError(refused)).toBe(true);
    expect(textOf(refused)).toContain(`is already assigned to session ${AGENT}`);
    const register = await wire.send(
      "desktop",
      "register-viewer",
      "daemon/registerSession",
      registerParams(DESKTOP_1),
    );
    expect(register.success).toBe(true);
    await wire.heartbeats("heartbeat-viewing", DESKTOP_1, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(AGENT);

    wire.keepAlive.delete(AGENT);
    const release = await wire.send("agent", "agent-release", "daemon/releaseSession", {
      sessionId: AGENT,
    });
    expect(release.success).toBe(true);
    await wire.heartbeats("heartbeat-after-holder-release", DESKTOP_1, 5);
    await wire.send("probe", "not-grabbed", "daemon/activeSessions", WHO_HOLDS);
    // Two-sided: the viewer neither held the device while the agent did nor grabbed it after.
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    const takeControl = await wire.send(
      "desktop",
      "take-control",
      "tools/call",
      bindParams(DESKTOP_1),
    );
    expect(isToolError(takeControl)).toBe(false);
    await wire.heartbeats("heartbeat-controlling", DESKTOP_1, 3);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);

    checkFixture(
      wire.fixture(
        "held-by-another-session",
        "Focus a device an agent holds: refused bind, observer registration (viewer mode), no " +
          "grab when the agent releases, one bind on Take control (#10660). The agent's session " +
          "is kept alive by unrecorded heartbeats while it holds the device.",
        { "desktop-1": DESKTOP_1, agent: AGENT },
      ),
    );
  });

  test("unfocusing releases the held device and refocusing re-acquires under a fresh session", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    const release = await wire.send("desktop", "release-on-unfocus", "daemon/releaseSession", {
      sessionId: DESKTOP_1,
    });
    expect(release.success).toBe(true);
    await wire.send(
      "desktop",
      "register-fresh",
      "daemon/registerSession",
      registerParams(DESKTOP_2),
    );
    await wire.heartbeats("heartbeat-unfocused", DESKTOP_2, 3);
    await wire.send("probe", "released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    const refocus = await wire.send("desktop", "refocus", "tools/call", bindParams(DESKTOP_2));
    expect(isToolError(refocus)).toBe(false);
    await wire.heartbeats("heartbeat-refocused", DESKTOP_2, 2);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_2);

    checkFixture(
      wire.fixture(
        "unfocus-releases-device",
        "Unfocus to Empty releases the held session and registers a fresh deviceless one; " +
          "refocus binds under the fresh session (#10659).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("quitting releases the held device", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
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

  test("hiding the window past the grace releases the device; the first tap re-binds (#10695)", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
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
    const tap = await wire.send("desktop", "tap-after-show", "input/tap", tapParams(DESKTOP_2));
    expect(tap.success).toBe(true);
    const rebind = await wire.send("desktop", "bind-on-input", "tools/call", bindParams(DESKTOP_2));
    expect(isToolError(rebind)).toBe(false);
    await wire.heartbeats("heartbeat-rebound", DESKTOP_2, 2);
    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_2);

    checkFixture(
      wire.fixture(
        "hidden-window-release",
        "Close the window to the tray (or hide the IDE tool window) past the grace: the session " +
          "rotates, releasing the device; showing it again binds nothing, and the first tap " +
          "on the pane binds it under the fresh session (#10695).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("focusing a held device after a free one releases the free one (#10697)", async () => {
    const wire = await startHarness();
    await agentHolds(wire, PIXEL_FOLD.deviceId);
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
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
    const refusedAgain = await wire.send(
      "desktop",
      "bind-held-refused-fresh",
      "tools/call",
      bindParams(DESKTOP_2, PIXEL_FOLD.deviceId),
    );
    expect(isToolError(refusedAgain)).toBe(true);
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
        "refused-focus-change",
        "Focus a free device, then one an agent holds: the refusal leaves the first hold, which " +
          "the client drops by rotating to a fresh session that views the held device (#10697).",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2, agent: AGENT },
      ),
    );
  });

  test("an idle release lapses the heartbeat, and today the lapse rebind re-acquires (#10693)", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    const healthyTicks = await wire.heartbeatsUntilLapse("heartbeat", DESKTOP_1, IDLE_WINDOW_TICKS);
    // Released by the 2-minute idle window, not by a missed heartbeat.
    expect(healthyTicks).toBeGreaterThanOrEqual(60);
    await wire.send("probe", "idle-released", "daemon/activeSessions", WHO_HOLDS);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();

    // The client re-sends its acknowledged binding after a lapse. The idle release is not
    // terminal (`cleanup-expired`), so the daemon accepts the same UUID and re-binds; #10693 /
    // #10730 will change one side of this exchange.
    await wire.send("desktop", "rebind-after-lapse", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat-after-rebind", DESKTOP_1, 2);
    await wire.send("probe", "after-rebind", "daemon/activeSessions", WHO_HOLDS);

    checkFixture(
      wire.fixture(
        "idle-release",
        "Focused with heartbeats but no tool calls or input: the idle window releases the " +
          "session, the next heartbeat is not found, and the client's lapse rebind follows.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a tap every minute keeps the focused device's session (#10693)", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    for (let minute = 1; minute <= 4; minute++) {
      await wire.heartbeats(`heartbeat-minute-${minute}`, DESKTOP_1, 30);
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
        "Pane taps (input/tap) on the focused device count as activity: four minutes of one " +
          "tap per minute never idle-release the session.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a daemon restart lapses the heartbeat and the rebind re-acquires", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    await wire.restartDaemon();
    const lapse = await wire.send("desktop", "heartbeat-lapse", "daemon/heartbeat", {
      sessionId: DESKTOP_1,
    });
    expect(lapse.success).toBe(false);
    const rebind = await wire.send(
      "desktop",
      "rebind-after-lapse",
      "tools/call",
      bindParams(DESKTOP_1),
    );
    expect(isToolError(rebind)).toBe(false);
    await wire.heartbeats("heartbeat-after-rebind", DESKTOP_1, 2);

    expect(wire.holderOf(PIXEL.deviceId)).toBe(DESKTOP_1);
    checkFixture(
      wire.fixture(
        "daemon-restart",
        "A restarted daemon has no record of the session: the heartbeat is not found and the " +
          "client's lapse rebind binds again under the same UUID.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });

  test("a stalled client's session expires terminally and its rebind is refused", async () => {
    const wire = await startHarness();
    await wire.send("desktop", "bind", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat", DESKTOP_1, 2);

    await wire.stall(30_000);
    expect(wire.holderOf(PIXEL.deviceId)).toBeNull();
    const lapse = await wire.send("desktop", "heartbeat-lapse", "daemon/heartbeat", {
      sessionId: DESKTOP_1,
    });
    expect(lapse.success).toBe(false);
    const rebind = await wire.send(
      "desktop",
      "rebind-refused",
      "tools/call",
      bindParams(DESKTOP_1),
    );
    expect(isToolError(rebind)).toBe(true);
    expect(textOf(rebind)).toContain("cannot be reused");
    // The client rotates: the released session is disposed (and released again, idempotently).
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
          "reaper releases the session terminally, the re-sent bind is refused as released, and " +
          "the client views the device under a fresh deviceless session.",
        { "desktop-1": DESKTOP_1, "desktop-2": DESKTOP_2 },
      ),
    );
  });

  test("a non-ownership bind error is retried and then surfaced (#10696)", async () => {
    const wire = await startHarness([PIXEL_FOLD]);
    const first = await wire.send("desktop", "bind-error-1", "tools/call", bindParams(DESKTOP_1));
    expect(isToolError(first)).toBe(true);
    expect(textOf(first)).not.toContain("already assigned");
    await wire.send(
      "desktop",
      "register-while-retrying",
      "daemon/registerSession",
      registerParams(DESKTOP_1),
    );
    await wire.heartbeats("heartbeat-1", DESKTOP_1, 1);
    await wire.send("desktop", "bind-error-2", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat-2", DESKTOP_1, 1);
    await wire.send("desktop", "bind-error-3", "tools/call", bindParams(DESKTOP_1));
    await wire.heartbeats("heartbeat-surfaced", DESKTOP_1, 3);

    expect(wire.holderOf(PIXEL_FOLD.deviceId)).toBeNull();
    checkFixture(
      wire.fixture(
        "bind-error-not-ownership",
        "Focus a device the daemon's pool does not have: an ordinary bind error, retried a " +
          "bounded number of times and surfaced, never treated as another session's hold.",
        { "desktop-1": DESKTOP_1 },
      ),
    );
  });
});
