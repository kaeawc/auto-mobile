import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import type { DaemonContext } from "../../../src/daemon/daemonContext";
import { DaemonState } from "../../../src/daemon/daemonState";
import { prepareTargetDisplayAction } from "../../../src/features/action/TargetDisplayAction";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";

const inner = "4619827259835644672";
const cover = "4619827551948147201";
const openedDisplays = readFileSync(
  new URL("../../fixtures/android-fold-displays/fold-open-get-displays.txt", import.meta.url),
  "utf8",
);

const device: BootedDevice = {
  deviceId: "fold-daemon-context",
  name: "am-fold-pixel10pf",
  platform: "android",
  apiLevel: 36,
  displays: {
    panels: [
      { key: inner, role: "inner", sizePx: { width: 2076, height: 2152 } },
      { key: cover, role: "cover", sizePx: { width: 1080, height: 2364 } },
    ],
    postures: ["closed", "opened"],
  },
};

const observation = {
  display: { key: inner, role: "inner", posture: "opened", generation: 7 },
  displayRevision: 41,
  screenSize: { width: 2076, height: 2152 },
} as ObserveResult;

describe("prepareTargetDisplayAction daemon context", () => {
  test("the default rendered reader and the caller revision re-read use the injected context", async () => {
    DaemonState.getInstance().reset();
    const revisionReads: string[] = [];
    const daemon: DaemonContext = {
      renderedDisplaySessions: () => ({
        getSessionForDevice: () => "injected-session",
        getLastRenderedDisplayKey: () => inner,
        getLastRenderedDisplayGeneration: () => 7,
        getLastRenderedDisplayRevision: (sessionId) => {
          revisionReads.push(sessionId);
          return 41;
        },
      }),
      sessionManager: () => undefined,
      devicePool: () => undefined,
    };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", { stdout: openedDisplays, stderr: "" });
    const observe = new FakeObserveScreen();
    observe.setObserveResult(observation);

    const prepared = await prepareTargetDisplayAction(
      device,
      "inner",
      observe,
      adb,
      undefined,
      undefined,
      new FakeDisplayTransitionReader(),
      daemon,
    );

    expect(prepared.observation.display.key).toBe(inner);
    // Once via the default reader, once via the caller-revision re-read.
    expect(revisionReads).toEqual(["injected-session", "injected-session"]);
  });
});
