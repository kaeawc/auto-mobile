import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AndroidPhysicalDisplayIdResolver } from "../../../src/features/observe/android/AndroidPhysicalDisplayId";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

// Interaction of #9906 (screencap -d takes the physical id) with #10105 (the display
// inventory is refreshed on display events): a hot-plugged secondary display does not bump
// the default panel's generation, so the resolver's per-device cache must still follow the
// inventory invalidation instead of serving the pre-event logical -> physical mapping.
const fixtureDirectory = "test/features/observe/android/fixtures";
const surfaceFlingerTwoDisplays = readFileSync(
  `${fixtureDirectory}/surfaceflinger-two-displays.txt`,
  "utf8",
);
// The first captured line alone: a device with one physical display.
const surfaceFlingerOneDisplay = `${surfaceFlingerTwoDisplays.split("\n")[0]}\n`;
const defaultDisplayLine = readFileSync(
  `${fixtureDirectory}/cmd-display-two-displays.txt`,
  "utf8",
).split("\n")[1];

const INNER = "4619827259835644672";
const COVER = "4619827259835644673";

function displayList(...extra: string[]): string {
  return ["Displays:", defaultDisplayLine, ...extra, ""].join("\n");
}

function secondaryDisplay(logicalId: number, physicalId: string): string {
  return `  Display id ${logicalId}: DisplayInfo{"Secondary", displayId ${logicalId}, type INTERNAL, uniqueId "local:${physicalId}", isValid=true}`;
}

const deviceIds: string[] = [];
function uniqueDevice(label: string): string {
  const deviceId = `inventory-screencap-${label}`;
  deviceIds.push(deviceId);
  return deviceId;
}

afterEach(() => {
  for (const deviceId of deviceIds.splice(0)) {
    displayTransitions.reset(deviceId);
  }
});

function setup(): { adb: FakeAdbExecutor; resolver: AndroidPhysicalDisplayIdResolver } {
  const adb = new FakeAdbExecutor();
  // The production resolver, with its production display-revision source.
  const resolver = new AndroidPhysicalDisplayIdResolver({ timer: new FakeTimer() });
  return { adb, resolver };
}

const getDisplaysReads = (adb: FakeAdbExecutor): number =>
  adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays"))
    .length;

describe("screencap physical-id resolution follows display inventory events (#9906, #10105)", () => {
  test("a secondary display re-added under the same logical id resolves to its new physical id", async () => {
    const deviceId = uniqueDevice("replug");
    const { adb, resolver } = setup();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, INNER)),
      stderr: "",
    });
    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);
    expect(getDisplaysReads(adb)).toBe(1);

    // Same logical id, another panel behind it: no default-display transition happens.
    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, COVER)),
      stderr: "",
    });
    displayTransitions.notifyAndroidTransition(deviceId, { change: "removed", displayId: 2 });
    displayTransitions.notifyAndroidTransition(deviceId, { change: "added", displayId: 2 });

    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(COVER);
    expect(getDisplaysReads(adb)).toBe(2);
  });

  test("a changed secondary display is looked up again", async () => {
    const deviceId = uniqueDevice("changed");
    const { adb, resolver } = setup();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, INNER)),
      stderr: "",
    });
    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);

    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, COVER)),
      stderr: "",
    });
    displayTransitions.notifyAndroidTransition(deviceId, { change: "changed", displayId: 2 });

    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(COVER);
  });

  test("a second physical display appearing ends the cached single-display answer", async () => {
    const deviceId = uniqueDevice("hotplug");
    const { adb, resolver } = setup();
    adb.setCommandResponse("dumpsys SurfaceFlinger", {
      stdout: surfaceFlingerOneDisplay,
      stderr: "",
    });
    adb.setCommandResponse("cmd display get-displays", { stdout: displayList(), stderr: "" });
    // One physical display: plain `screencap`, so no explicit id.
    expect(await resolver.resolve(adb, deviceId)).toBeNull();

    adb.setCommandResponse("dumpsys SurfaceFlinger", {
      stdout: surfaceFlingerTwoDisplays,
      stderr: "",
    });
    displayTransitions.notifyAndroidTransition(deviceId, { change: "added", displayId: 2 });

    expect(await resolver.resolve(adb, deviceId)).toBe(COVER);
  });

  test("a rotation-only change of the default display keeps the cached mapping", async () => {
    const deviceId = uniqueDevice("rotation");
    const { adb, resolver } = setup();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, INNER)),
      stderr: "",
    });
    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);
    displayTransitions.record(deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 100, height: 200 },
    });

    displayTransitions.notifyAndroidTransition(deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:inner",
      width: 200,
      height: 100,
    });

    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);
    expect(getDisplaysReads(adb)).toBe(1);
  });

  test("an event for another device leaves this device's mapping cached", async () => {
    const deviceId = uniqueDevice("mine");
    const otherDeviceId = uniqueDevice("other");
    const { adb, resolver } = setup();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: displayList(secondaryDisplay(2, INNER)),
      stderr: "",
    });
    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);

    displayTransitions.notifyAndroidTransition(otherDeviceId, { change: "removed", displayId: 2 });

    expect(await resolver.resolveLogical(adb, deviceId, 2)).toBe(INNER);
    expect(getDisplaysReads(adb)).toBe(1);
  });
});
