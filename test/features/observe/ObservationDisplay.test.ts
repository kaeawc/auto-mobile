import { wireHierarchyFrom } from "../../helpers/androidHierarchyConverter";
import { createAndroidHierarchyConverter } from "../../helpers/androidHierarchyConverter";
import { convertIosHierarchy } from "../../helpers/iosHierarchyConverter";
import { parseAndroidDeviceDisplays } from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { panelKeyForFingerprint } from "../../../src/models/DisplayPanel";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidDisplayReadError } from "../../../src/features/observe/AndroidDisplayReadError";
import {
  ObservedAndroidDisplayCache,
  observedAndroidDisplay,
  observedIosDisplay,
} from "../../../src/features/observe/ObservationDisplay";
import {
  DisplayTransitionTracker,
  displayTransitions,
} from "../../../src/features/observe/DisplayTransition";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";

import type { AccessibilityHierarchy } from "../../../src/features/observe/android/types";
import { makeViewHierarchyCtrlProxy } from "../../helpers/androidViewHierarchyClient";
import type { XCTestHierarchy } from "../../../src/features/observe/ios/types";
import { GetBackStack } from "../../../src/features/observe/GetBackStack";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import {
  runWithSelectedDisplayPin,
  displayPinFailure,
} from "../../../src/features/observe/SessionDisplayContext";
import { ActionableError } from "../../../src/models/ActionableError";
import { PinnedDisplayUnavailableError } from "../../../src/models/PinnedDisplayError";
import { logger } from "../../../src/utils/logger";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { createExecResult } from "../../../src/utils/execResult";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const ios: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "simulator" };

describe("Android observe disconnected fold panels", () => {
  const inner = "4619827259835644672";
  const cover = "4619827551948147201";
  const device: BootedDevice = {
    ...android,
    deviceId: "observe-disconnected-fold",
    displays: {
      panels: [
        { key: inner, role: "inner", sizePx: { width: 2076, height: 2152 } },
        { key: cover, role: "cover", sizePx: { width: 1080, height: 2364 } },
      ],
      postures: ["closed", "opened"],
    },
  };
  const captures = {
    opened: readFileSync(
      new URL("../../fixtures/android-fold-displays/fold-open-get-displays.txt", import.meta.url),
      "utf8",
    ),
    closed: readFileSync(
      new URL("../../fixtures/android-fold-displays/fold-closed-get-displays.txt", import.meta.url),
      "utf8",
    ),
  };
  const message = (
    key: string,
    role: string,
    connectedKey: string,
    connectedRole: string,
    posture: string,
  ) =>
    `Display "${key}" (${role}) is not connected in the current posture. Connected panels: ${connectedKey} (${connectedRole}). Target a connected panel, omit display, or use display: "active"; to make this panel available, change the device posture with setPosture {posture: "${posture}"}.`;
  async function observe(posture: keyof typeof captures, display: string) {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(captures[posture], ""));
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(adb),
      { viewHierarchy: new FakeViewHierarchy(), cacheStore: new FakeObserveCacheStore(timer) },
      { timer },
    );
    try {
      return await screen.execute({ display, skipScreenshot: true, skipBackStack: true });
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  }

  test("opened observe cover uses the action message and only the connected inner", async () => {
    await expect(observe("opened", "cover")).rejects.toThrow(
      message(cover, "cover", inner, "inner", "closed"),
    );
  });

  test("closed pinned inner carries the connected cover and posture and pin remedies", async () => {
    const error = await runWithSelectedDisplayPin(
      { pin: "inner", inventory: device.displays },
      () => observe("closed", "inner"),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PinnedDisplayUnavailableError);
    expect(error).toHaveProperty(
      "message",
      message(inner, "inner", cover, "cover", "opened") +
        " Clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or select another display explicitly.",
    );
    expect(error).toHaveProperty("details", {
      pin: "inner",
      availablePanels: [{ key: cover, role: "cover" }],
    });
  });

  test.each(["opened", "closed"] as const)(
    "connected %s panel resolves to logical zero",
    async (posture) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cmd display get-displays", createExecResult(captures[posture], ""));
      expect(
        await new ObservedAndroidDisplayCache(new FakeTimer()).logicalIdForPanel(
          device,
          adb,
          posture === "opened" ? inner : cover,
        ),
      ).toBe(0);
    },
  );
});

describe("Android display-list read failures", () => {
  const device: BootedDevice = {
    ...android,
    deviceId: "display-read-failure",
    displays: {
      panels: [
        { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
        { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
      ],
      postures: ["opened", "closed"],
    },
  };
  const coverDisplay =
    'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}';
  const innerDisplay =
    'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}';

  beforeEach(() => ObservedAndroidDisplayCache.release(device.deviceId));
  afterEach(() => ObservedAndroidDisplayCache.release(device.deviceId));

  test("a failed first read is retried immediately instead of caching the fallback", async () => {
    const timer = new FakeTimer();
    const cache = new ObservedAndroidDisplayCache(timer);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(coverDisplay, ""));
    const read = spyOn(adb, "executeCommand").mockImplementationOnce(() => {
      throw new Error("first read failed synchronously");
    });
    try {
      expect((await cache.resolve(device, adb)).display).toMatchObject({
        key: "0",
        role: "unknown",
      });
      expect((await cache.resolve(device, adb)).display).toMatchObject({
        key: "cover",
        role: "cover",
      });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  });

  test("a failed first read does not become the last-known display", async () => {
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new Error("timeout"));
    expect((await cache.resolve(device, adb)).display.key).toBe("0");
    // clear() preserves last-known state, so a changed inventory exposes a stored fallback.
    ObservedAndroidDisplayCache.clear(device.deviceId);
    const singlePanel = {
      ...device,
      displays: { ...device.displays!, panels: [device.displays!.panels[1]] },
    };
    expect((await cache.resolve(singlePanel, adb)).display.key).toBe("cover");
    expect(adb.getExecutedCommands()).toHaveLength(2);
  });

  test.each(["expired", "forced"] as const)(
    "a failed %s read retains the previous value but the next call retries immediately",
    async (mode) => {
      const timer = new FakeTimer();
      const cache = new ObservedAndroidDisplayCache(timer);
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cmd display get-displays", createExecResult(coverDisplay, ""));
      const previous = await cache.resolve(device, adb);
      timer.advanceTime(mode === "expired" ? 5_000 : 1_000);
      const read = spyOn(adb, "executeCommand").mockRejectedValueOnce(new Error("timeout"));
      try {
        const failed = await cache.resolve(device, adb, undefined, mode === "forced");
        expect(failed).toEqual(previous);
        expect(failed).not.toBe(previous);
        expect(failed.display).not.toBe(previous.display);
        adb.setCommandResponse("cmd display get-displays", createExecResult(innerDisplay, ""));
        expect((await cache.resolve(device, adb)).display.key).toBe("inner");
        expect(read).toHaveBeenCalledTimes(2);
      } finally {
        read.mockRestore();
      }
    },
  );

  test("a successful display read is cached until exactly five seconds", async () => {
    const timer = new FakeTimer();
    const cache = new ObservedAndroidDisplayCache(timer);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(coverDisplay, ""));
    expect((await cache.resolve(device, adb)).display.key).toBe("cover");
    adb.setCommandResponse("cmd display get-displays", createExecResult(innerDisplay, ""));
    timer.advanceTime(4_999);
    expect((await cache.resolve(device, adb)).display.key).toBe("cover");
    expect(adb.getExecutedCommands()).toHaveLength(1);
    timer.advanceTime(1);
    expect((await cache.resolve(device, adb)).display.key).toBe("inner");
    expect(adb.getExecutedCommands()).toHaveLength(2);
  });

  test("a read-only failed probe preserves the owner's cache and its expiry", async () => {
    const timer = new FakeTimer();
    const owner = new ObservedAndroidDisplayCache(timer);
    const observer = new ObservedAndroidDisplayCache(timer, true);
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(coverDisplay, ""));
    const previous = await owner.resolve(device, adb);
    timer.advanceTime(1_000);
    const read = spyOn(adb, "executeCommand").mockRejectedValueOnce(new Error("timeout"));
    try {
      expect(await observer.resolve(device, adb, undefined, true)).toEqual(previous);
      adb.setCommandResponse("cmd display get-displays", createExecResult(innerDisplay, ""));
      expect(await owner.resolve(device, adb)).toEqual(previous);
      expect(read).toHaveBeenCalledTimes(1);
      timer.advanceTime(4_000);
      expect((await owner.resolve(device, adb)).display.key).toBe("inner");
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
    }
  });

  test("no-panel discovery keeps its default display without a shell read", async () => {
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    const adb = new FakeAdbExecutor();
    adb.setDefaultError(new Error("must not probe"));
    const singleScreen = { ...device, displays: undefined };
    const first = await cache.resolve(singleScreen, adb);
    expect(first).toEqual({
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      logicalId: 0,
    });
    expect(await cache.resolve(singleScreen, adb)).toEqual(first);
    expect(await cache.resolve(singleScreen, adb, undefined, true)).toEqual(first);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("a failed read rejects panel selection with a retryable ActionableError", async () => {
    const adb = new FakeAdbExecutor();
    const timeout = new Error("timeout");
    adb.setCommandError("cmd display get-displays", timeout);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const error = await new ObservedAndroidDisplayCache(new FakeTimer())
        .logicalIdForPanel(device, adb, "inner")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toBeInstanceOf(AndroidDisplayReadError);
      expect(error).not.toBeInstanceOf(DisplaySelectionError);
      expect(error).toHaveProperty(
        "message",
        expect.stringMatching(/display list.*could not be read/i),
      );
      expect(error).toHaveProperty("message", expect.stringContaining("timeout"));
      expect(error).toHaveProperty("message", expect.stringMatching(/retry/i));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("timeout"), timeout);
      expect(adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([coverDisplay, ""])(
    "a successful display list lacking the requested panel still rejects with DisplaySelectionError: %s",
    async (stdout) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cmd display get-displays", createExecResult(stdout, ""));
      const error = await new ObservedAndroidDisplayCache(new FakeTimer())
        .logicalIdForPanel(device, adb, "inner")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(DisplaySelectionError);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining(
          'Display "inner" (inner) is not connected in the current posture. Connected panels:',
        ),
      );
    },
  );

  test.each(["signal", "command"] as const)(
    "panel selection propagates cancellation from the %s",
    async (source) => {
      const adb = new FakeAdbExecutor();
      const controller = new AbortController();
      const cancellation = new DOMException("cancelled", "AbortError");
      if (source === "signal") {
        controller.abort(cancellation);
      } else {
        adb.setCommandError("cmd display get-displays", cancellation);
      }
      const error = await new ObservedAndroidDisplayCache(new FakeTimer())
        .logicalIdForPanel(device, adb, "inner", controller.signal)
        .catch((error: unknown) => error);
      expect(error).toBe(cancellation);
      expect(error).toHaveProperty("name", "AbortError");
      expect(error).not.toBeInstanceOf(ActionableError);
      expect(error).not.toBeInstanceOf(DisplaySelectionError);
    },
  );

  test("a failed display-list read keeps its error inside a selected display pin", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new Error("timeout"));
    const error = await new ObservedAndroidDisplayCache(new FakeTimer())
      .logicalIdForPanel(device, adb, "inner")
      .catch((error: unknown) => error);
    runWithSelectedDisplayPin({ pin: "inner", inventory: device.displays }, () => {
      const failure = displayPinFailure(error);
      expect(failure).not.toBeInstanceOf(PinnedDisplayUnavailableError);
      expect(failure).toBe(error);
    });
  });

  test("a genuinely absent panel is converted to PinnedDisplayUnavailableError", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", createExecResult(coverDisplay, ""));
    const error = await new ObservedAndroidDisplayCache(new FakeTimer())
      .logicalIdForPanel(device, adb, "inner")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DisplaySelectionError);
    runWithSelectedDisplayPin({ pin: "inner", inventory: device.displays }, () => {
      const failure = displayPinFailure(error);
      expect(failure).toBeInstanceOf(PinnedDisplayUnavailableError);
      expect(failure).toHaveProperty("cause", error);
    });
  });

  test("a failed hierarchy panel probe returns undefined", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new Error("timeout"));
    expect(
      await new ObservedAndroidDisplayCache(new FakeTimer()).panelForLogicalId(device, adb, 0),
    ).toBeUndefined();
  });

  test("a failed observation read without a previous panel keeps the empty-list fallback", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new Error("timeout"));
    expect(await observedAndroidDisplay(device, adb)).toEqual({
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      logicalId: 0,
      panelKeysByLogicalId: {},
    });
  });
});

describe("observation display stamp", () => {
  test("Android posture uses committed state when the base state differs", async () => {
    const fixture = (name: string): string =>
      readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(fixture("foldpf-print-states.txt"), ""),
    );
    adb.setCommandResponse(
      "shell cmd device_state state",
      createExecResult(fixture("foldpf-6-fold-from-closed-base-while-override-state.txt"), ""),
    );
    const device: BootedDevice = {
      ...android,
      deviceId: "foldpf-committed-posture",
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["closed", "opened", "rear_display"],
      },
    };
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    try {
      expect(await cache.posture(device, adb)).toBe("rear_display");
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
    }
  });

  test("Android observe carries the forwarded raw capture through the real converter", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const device = { ...android, deviceId: "android-sequence" };
    const raw: AccessibilityHierarchy = {
      updatedAt: 1,
      packageName: "com.test.app",
      captureSequence: 23,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    };
    const converter = createAndroidHierarchyConverter();
    const client = makeViewHierarchyCtrlProxy({
      getAccessibilityHierarchy: async () => converter.convertToViewHierarchyResult(raw),
    });
    const hierarchy = new ViewHierarchy(device, new FakeAdbClientFactory(adb), client, {
      timer,
      observeAccessibilityManagerFactory: () => ({
        isAccessibilityServiceHealthy: async () => false,
        rebindIfUnhealthy: async () => false,
        waitForAccessibilityServiceBinding: async () => "unhealthy",
      }),
    });
    try {
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
        { timer },
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipRecompositionTracking: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      });
      expect(result.viewHierarchy?.captureSequence).toBe(23);
      expect(result.display.generation).toBe(0);
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("iOS observe carries the forwarded raw capture through normalization", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const device = { ...ios, deviceId: "ios-sequence" };
    const raw: XCTestHierarchy = {
      updatedAt: 1,
      packageName: "com.test.app",
      captureSequence: 31,
      hierarchy: { text: "Ready", bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
    };
    const fakeClient = {
      convertToViewHierarchyResult: convertIosHierarchy,
      getLatestHierarchy: async () => ({ hierarchy: raw, fresh: true, updatedAt: 1 }),
    };
    const getInstance = spyOnIosClientInstance(fakeClient);
    try {
      const hierarchy = new ViewHierarchy(device, new FakeAdbClientFactory(adb), undefined, {
        timer,
      });
      const screen = new RealObserveScreen(
        device,
        new FakeAdbClientFactory(adb),
        { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
        { timer },
      );
      const result = await screen.execute({
        skipScreenshot: true,
        skipBackStack: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      });
      expect(result.viewHierarchy?.captureSequence).toBe(31);
      expect(result.display.generation).toBe(0);
    } finally {
      getInstance.mockRestore();
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("two Android multi-panel observations reuse the live display binding", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cmd display get-displays",
      createExecResult(
        'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}',
        "",
      ),
    );
    const device: BootedDevice = {
      ...android,
      deviceId: "foldable-cache",
      displays: {
        panels: [
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
        ],
        postures: ["closed", "opened"],
      },
    };
    const hierarchy = new FakeViewHierarchy();
    hierarchy.configureHierarchy({
      hierarchy: { node: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } },
      updatedAt: 1,
    });
    try {
      const options = {
        skipScreenshot: true,
        skipBackStack: true,
        skipRecompositionTracking: true,
        skipPerformanceAudit: true,
        skipAccessibilityAudit: true,
      };
      for (let index = 0; index < 2; index++) {
        const screen = new RealObserveScreen(
          device,
          new FakeAdbClientFactory(adb),
          { viewHierarchy: hierarchy, cacheStore: new FakeObserveCacheStore(timer) },
          { timer },
        );
        await screen.execute(options);
      }
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("cmd display get-displays")),
      ).toHaveLength(1);
    } finally {
      displayTransitions.reset(device.deviceId);
      resetObserveCacheStore();
    }
  });

  test("an empty or failed lookup retains the last panel until the next successful read", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      ...android,
      deviceId: "display-lookup-gap",
      displays: {
        panels: [
          { key: "inner", role: "inner", sizePx: { width: 200, height: 200 } },
          { key: "cover", role: "cover", sizePx: { width: 100, height: 100 } },
        ],
        postures: ["opened", "closed"],
      },
    };
    const outputs = [
      'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
      "",
      "",
      'Display id 0: DisplayInfo{uniqueId "local:inner" type INTERNAL, real 200 x 200}',
    ];
    let reads = 0;
    const transitions: string[] = [];
    const tracker = new DisplayTransitionTracker((_deviceId, reason) => transitions.push(reason));
    const adb = {
      executeCommand: async () => {
        const index = reads++;
        if (index === 1) {
          throw new Error("lookup failed");
        }
        return createExecResult(outputs[index] ?? "", "");
      },
    } satisfies AdbCommandRunner;
    const cache = new ObservedAndroidDisplayCache(timer);
    try {
      const first = await cache.resolve(device, adb);
      const failed = await cache.resolve(device, adb, undefined, true);
      const empty = await cache.resolve(device, adb, undefined, true);
      const recovered = await cache.resolve(device, adb, undefined, true);
      for (const resolved of [first, failed, empty, recovered]) {
        tracker.checkIdentity(device.deviceId, resolved.display);
        tracker.record(device.deviceId, {
          display: resolved.display,
          screenSize: { width: 200, height: 200 },
        });
      }
      expect([
        first.display.key,
        failed.display.key,
        empty.display.key,
        recovered.display.key,
      ]).toEqual(["inner", "inner", "inner", "inner"]);
      expect(reads).toBe(4);
      expect(transitions).toEqual([]);
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
    }
  });

  test("an aborted Android display lookup is propagated", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cmd display get-displays", new DOMException("cancelled", "AbortError"));
    const device: BootedDevice = {
      ...android,
      displays: {
        panels: [{ key: "cover", role: "cover", sizePx: { width: 100, height: 100 } }],
        postures: ["closed"],
      },
    };
    await expect(observedAndroidDisplay(device, adb)).rejects.toHaveProperty("name", "AbortError");
  });
  test("Android single display uses stable default when inventory is absent", async () => {
    const resolved = await observedAndroidDisplay(android, new FakeAdbExecutor());
    expect(resolved).toEqual({
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      logicalId: 0,
    });
  });

  test("Android foldable stamps display 0's physical panel and scopes its active window", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cmd display get-displays",
      createExecResult(
        [
          'Display id 0: DisplayInfo{uniqueId "local:cover-physical" type INTERNAL, real 1080 x 2364}',
          'Display id 3: DisplayInfo{uniqueId "local:inner-physical" type INTERNAL, real 2076 x 2152}',
        ].join("\n"),
        "",
      ),
    );
    adb.setCommandResponse(
      "dumpsys activity activities",
      createExecResult(
        [
          "Display #0 (activities from top to bottom):",
          "  topResumedActivity=ActivityRecord{abc u0 com.cover/.Main t1}",
          "Display #3 (activities from top to bottom):",
          "  topResumedActivity=ActivityRecord{def u0 com.inner/.Main t2}",
        ].join("\n"),
        "",
      ),
    );
    const device: BootedDevice = {
      ...android,
      displays: {
        panels: [
          { key: "inner-physical", role: "inner", sizePx: { width: 2076, height: 2152 } },
          { key: "cover-physical", role: "cover", sizePx: { width: 1080, height: 2364 } },
        ],
        postures: ["closed", "opened"],
      },
    };
    const resolved = await observedAndroidDisplay(device, adb);
    expect(resolved.display).toEqual({
      key: "cover-physical",
      role: "cover",
      posture: "unknown",
      generation: 0,
    });
    expect(resolved.logicalId).toBe(0);
    const stack = await new GetBackStack(
      device,
      new FakeAdbClientFactory(adb),
      new FakeTimer(),
    ).execute(undefined, undefined, resolved.logicalId);
    expect(stack.currentActivity?.name).toBe("com.cover.Main");
  });

  test("iOS single display uses stable default and a neutral generation placeholder", () => {
    expect(observedIosDisplay(ios, { captureSequence: 17 } as ViewHierarchyResult)).toEqual({
      key: "0",
      role: "unknown",
      posture: "unknown",
      generation: 0,
    });
  });

  test("an unknown iOS panel preserves remembered posture until a resolved mismatch", () => {
    const device: BootedDevice = {
      ...ios,
      deviceId: "34C35F33-224C-4E74-B8C0-668FF03E49F5",
      displays: simulatorDeviceDisplays(
        parseSimulatorDisplays(loadDuoEnumerate()),
        "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
      ),
    };
    const inner = { pixelWidth: 2007, pixelHeight: 2853 };
    try {
      ObservedAndroidDisplayCache.rememberIosPosture(device.deviceId, {
        ...observedIosDisplay(device, inner),
        posture: "half_opened",
      });
      expect(observedIosDisplay(device, undefined).posture).toBe("unknown");
      expect(observedIosDisplay(device, inner).posture).toBe("half_opened");
      expect(observedIosDisplay(device, { pixelWidth: 1398, pixelHeight: 2034 }).posture).toBe(
        "closed",
      );
      expect(observedIosDisplay(device, inner).posture).toBe("opened");
    } finally {
      ObservedAndroidDisplayCache.release(device.deviceId);
    }
  });

  test("folded iPhone Duo selects the live cover panel by runner pixel size", () => {
    const device: BootedDevice = {
      ...ios,
      displays: simulatorDeviceDisplays(
        parseSimulatorDisplays(loadDuoEnumerate()),
        "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
      ),
    };
    expect(
      observedIosDisplay(device, {
        pixelWidth: 1398,
        pixelHeight: 2034,
        captureSequence: 41,
      } as ViewHierarchyResult),
    ).toEqual({
      key: "primary",
      role: "cover",
      posture: "closed",
      generation: 0,
    });
    expect(observedIosDisplay(device, { pixelWidth: 2007, pixelHeight: 2853 })).toMatchObject({
      key: "primary-1",
      role: "inner",
      posture: "opened",
    });
  });
});

const fingerprintInventory = parseAndroidDeviceDisplays(
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-open-surfaceflinger.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-open-displays.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-print-states.txt",
      import.meta.url,
    ),
    "utf8",
  ),
)!;

describe("panel fingerprint routing", () => {
  const fold = { ...android, deviceId: "fingerprint-routing", displays: fingerprintInventory };
  const coverSize = { width: 1080, height: 2364 };
  test("resolves a native cover size without probing and gives unique id precedence", async () => {
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    const adb = new FakeAdbExecutor();
    const cover = await cache.panelForLogicalId(fold, adb, 0, {
      identity: { panelFingerprint: coverSize },
      allowProbe: false,
    });
    expect(cover?.key).toBe("4619827551948147201");
    const inner = await cache.panelForLogicalId(fold, adb, 0, {
      identity: { panelUniqueId: "local:4619827259835644672", panelFingerprint: coverSize },
      allowProbe: false,
    });
    expect(inner?.key).toBe("4619827259835644672");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  const displayList = readFileSync(
    new URL("../../fixtures/android-fold-displays/fold-open-get-displays.txt", import.meta.url),
    "utf8",
  );
  test("unresolved fingerprints preserve both the cached map and probe fallback", async () => {
    const cache = new ObservedAndroidDisplayCache(new FakeTimer());
    let index = 0;
    for (const panels of [
      fingerprintInventory.panels,
      [],
      undefined,
      fingerprintInventory.panels.map((p) => ({ ...p, sizePx: coverSize })),
    ]) {
      for (const size of [
        coverSize,
        { width: 2364, height: 1080 },
        { width: 1920, height: 1080 },
      ]) {
        if (panels === fingerprintInventory.panels && size === coverSize) {
          continue;
        }
        const candidate = {
          ...fold,
          deviceId: `fingerprint-fallback-${index++}`,
          displays: panels ? { ...fingerprintInventory, panels } : undefined,
        };
        const adb = new FakeAdbExecutor();
        adb.setCommandResponse("cmd display get-displays", createExecResult(displayList, ""));
        try {
          expect(
            await cache.panelForLogicalId(candidate, adb, 0, {
              identity: { panelFingerprint: size },
              allowProbe: false,
            }),
          ).toBeUndefined();
          expect(adb.getExecutedCommands()).toEqual([]);
          const expected = panels?.find((p) => p.key === "4619827259835644672");
          expect(
            await cache.panelForLogicalId(candidate, adb, 0, {
              identity: { panelFingerprint: size },
            }),
          ).toEqual(expected);
          expect(adb.getExecutedCommands()).toHaveLength(1);
          await cache.resolve(candidate, adb);
          const reads = adb.getExecutedCommands().length;
          expect(
            await cache.panelForLogicalId(candidate, adb, 0, {
              identity: { panelFingerprint: size },
              allowProbe: false,
            }),
          ).toEqual(expected);
          expect(adb.getExecutedCommands()).toHaveLength(reads);
        } finally {
          ObservedAndroidDisplayCache.release(candidate.deviceId);
        }
      }
    }
  });
});

const closedFingerprintInventory = parseAndroidDeviceDisplays(
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-closed-surfaceflinger.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-closed-displays.txt",
      import.meta.url,
    ),
    "utf8",
  ),
  readFileSync(
    new URL(
      "../../fixtures/android-display/fold-pixel10pf-api36/fold-print-states.txt",
      import.meta.url,
    ),
    "utf8",
  ),
)!;

test("exact fingerprint matching rejects ambiguous, missing, swapped and external sizes", () => {
  const size = { width: 1080, height: 2364 };
  for (const inventory of [fingerprintInventory, closedFingerprintInventory]) {
    expect(panelKeyForFingerprint(inventory.panels, size)).toBe("4619827551948147201");
    expect(panelKeyForFingerprint(inventory.panels, { width: 2076, height: 2152 })).toBe(
      "4619827259835644672",
    );
  }
  for (const panels of [
    undefined,
    [],
    fingerprintInventory.panels.map((p) => ({ ...p, sizePx: size })),
  ]) {
    expect(panelKeyForFingerprint(panels, size)).toBeUndefined();
  }
  expect(
    panelKeyForFingerprint(fingerprintInventory.panels, { width: 2364, height: 1080 }),
  ).toBeUndefined();
  expect(
    panelKeyForFingerprint(fingerprintInventory.panels, { width: 1920, height: 1080 }),
  ).toBeUndefined();
  expect(panelKeyForFingerprint(fingerprintInventory.panels, undefined)).toBeUndefined();
});

test("both CtrlProxy hierarchy conversion routes retain the top-level fingerprint", () => {
  const converter = createAndroidHierarchyConverter();
  for (const hierarchy of [undefined, { className: "android.view.View", children: [] }]) {
    const wire = wireHierarchyFrom({
      updatedAt: 1,
      packageName: "example",
      hierarchy,
      displayId: 4,
      panelFingerprint: { width: 1080, height: 2364 },
    });
    expect(converter.convertToViewHierarchyResult(wire).panelFingerprint).toEqual(
      wire.panelFingerprint,
    );
  }
});

test("both CtrlProxy hierarchy conversion routes drop malformed fingerprints", () => {
  const converter = createAndroidHierarchyConverter();
  for (const hierarchy of [undefined, { className: "android.view.View", children: [] }]) {
    for (const panelFingerprint of [
      null,
      "1080x2364",
      { width: "1080", height: 2364 },
      { width: 1080, height: "2364" },
      { width: 0, height: 2364 },
      { width: 1080, height: 0 },
      { width: -1, height: 2364 },
      { width: 1080, height: -1 },
      { width: 1080.5, height: 2364 },
      { width: 1080, height: 2364.5 },
      { width: 1080 },
      { height: 2364 },
    ]) {
      const wire = wireHierarchyFrom({ updatedAt: 1, packageName: "example", hierarchy });
      // Object.assign models malformed wire data outside the typed producer contract.
      Object.assign(wire, { panelFingerprint });
      expect(converter.convertToViewHierarchyResult(wire).panelFingerprint).toBeUndefined();
    }
  }
});
