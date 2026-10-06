import {
  deferTerminalScreenshot,
  hasPendingTerminalScreenshot,
  runWithPostActionCaptureScope,
} from "../../../src/utils/PostActionCaptureContext";
import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { Explore } from "../../../src/features/navigation/Explore";
import { BootedDevice, Element, ExecResult, ObserveResult } from "../../../src/models";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionManager } from "../../fakes/FakeDeviceSessionManager";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { INTERNAL_NO_DIFF_PARAM } from "../../../src/server/internalToolCall";

// Import extracted functions for testing
import {
  extractNavigationElements,
  getElementKey,
} from "../../../src/features/navigation/ExploreElementExtraction";
import { calculateNavigationScore } from "../../../src/features/navigation/ExploreElementScoring";
import {
  isPermissionDialog,
  isLoginScreen,
  isRatingDialog,
} from "../../../src/features/navigation/ExploreBlockerDetection";
import {
  initializeGraphTraversal,
  getEdgeKey,
  markNodeVisited,
  markEdgeTraversed,
  selectNextEdgeToTraverse,
} from "../../../src/features/navigation/ExploreValidateMode";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ElementParser } from "../../../src/utils/interfaces/ElementParser";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { SwipeOnElement } from "../../../src/features/action/SwipeOnElement";
import {
  pressButtonSchema,
  swipeOnSchema,
  tapAtSchema,
  tapOnSchema,
} from "../../../src/server/interactionTools";
import { LaunchApp } from "../../../src/features/action/LaunchApp";
import { PressButton } from "../../../src/features/action/PressButton";
import { FakeDialogTapAction } from "../../fakes/FakeDialogTapAction";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { registerNavigationTools } from "../../../src/server/navigationTools";
import type { ExploreResult } from "../../../src/features/navigation/ExploreTypes";
import type { ExportedGraph } from "../../../src/utils/interfaces/NavigationGraph";
import { logger } from "../../../src/utils/logger";
import { reportToolDispatched } from "../../../src/utils/ToolDispatchContext";
import { FakeElementParser } from "../../fakes/FakeElementParser";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";

// `dumpsys window windows` output parseable (by Window.parseActiveWindowModern)
// as the launcher being foreground. Used to satisfy home-press verification
// (issue #6147) in tests whose `adb` mock doesn't otherwise implement
// `executeCommand`.
const LAUNCHER_DUMPSYS_STDOUT =
  "Window #0 Window{01234567 u0 com.android.launcher3/com.android.launcher3.Launcher}: mViewVisibility=0x0 isOnScreen=true isVisible=true";

function launcherDumpsysResult(): ExecResult {
  return {
    stdout: LAUNCHER_DUMPSYS_STDOUT,
    stderr: "",
    toString: () => LAUNCHER_DUMPSYS_STDOUT,
    trim: () => LAUNCHER_DUMPSYS_STDOUT.trim(),
    includes: (searchString: string) => LAUNCHER_DUMPSYS_STDOUT.includes(searchString),
  };
}

describe("Explore", () => {
  let explore: Explore;
  let device: BootedDevice;
  let mockAdb: any;
  let mockObserveScreen: any;
  let fakeGraph: FakeNavigationGraphManager;
  let fakeTimer: FakeTimer;
  let elementParser: ElementParser;

  beforeEach(() => {
    fakeGraph = new FakeNavigationGraphManager();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    elementParser = new DefaultElementParser();

    // Create fake device
    device = {
      deviceId: "test-device-123",
      platform: "android",
      source: "local",
    } as BootedDevice;

    // Create mock ADB client
    mockAdb = {
      executeCommand: async (cmd: string) => {
        if (cmd.includes("KEYCODE_BACK")) {
          // Simulate navigation event when back is pressed
          fakeGraph.recordNavigationEvent({
            destination: "PreviousScreen",
            source: "TEST",
            arguments: {},
            metadata: {},
            timestamp: Date.now(),
            sequenceNumber: 0,
            applicationId: "com.test.app",
          });
          return "Back button pressed";
        }
        if (cmd.includes("KEYCODE_HOME")) {
          return "Home button pressed";
        }
        return "";
      },
    } as AdbClient;

    // Create mock ObserveScreen that cycles through different screens
    let observeCallCount = 0;
    mockObserveScreen = {
      execute: async () => {
        observeCallCount++;
        // Alternate between screens to simulate navigation
        if (observeCallCount % 2 === 0) {
          fakeGraph.recordNavigationEvent({
            destination: `Screen${observeCallCount}`,
            source: "TEST",
            arguments: {},
            metadata: {},
            timestamp: Date.now(),
            sequenceNumber: observeCallCount,
            applicationId: "com.test.app",
          });
        }
        return createMockObservation();
      },
      getMostRecentCachedObserveResult: async () => {
        return createMockObservation();
      },
    };
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  function createMockViewHierarchyNode(overrides: any = {}): any {
    const defaults = {
      $: {
        class: "android.widget.Button",
        text: "Button",
        "resource-id": "com.test:id/button",
        clickable: "true",
        enabled: "true",
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      },
    };

    return {
      $: { ...defaults.$, ...overrides },
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    };
  }

  function createMockElement(overrides: Partial<Element> = {}): Element {
    return {
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      clickable: true,
      enabled: true,
      text: "Button",
      class: "android.widget.Button",
      "resource-id": "com.test:id/button",
      ...overrides,
    } as Element;
  }

  function createMockObservation(
    nodes: any[] = [],
    packageName: string = "com.test.app",
  ): ObserveResult {
    const defaultNodes =
      nodes.length > 0
        ? nodes
        : [
            createMockViewHierarchyNode({
              text: "Settings",
              "resource-id": "com.test:id/settings_btn",
            }),
            createMockViewHierarchyNode({
              text: "Profile",
              "resource-id": "com.test:id/profile_btn",
            }),
          ];

    return {
      viewHierarchy: {
        hierarchy: {
          node: defaultNodes,
        },
        packageName,
      },
    } as ObserveResult;
  }

  describe("execute", () => {
    test("omitting maxInteractions stops after the pinned default of 200", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      let observed = 0;
      explore.observeScreen = {
        execute: async () => {
          observed++;
          fakeGraph.setCurrentAppId("com.test.app");
          fakeGraph.setCurrentScreenValue(`Screen${observed}`);
          return createMockObservation([
            createMockViewHierarchyNode({
              text: `Open screen ${observed}`,
              "resource-id": `com.test:id/next_${observed}`,
            }),
          ]);
        },
      } as typeof explore.observeScreen;
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
      try {
        const result = await explore.execute({});
        expect(result.interactionsPerformed).toBe(200);
        expect(result.stopReason).toBe("Reached max interactions limit (200)");
        expect(tap).toHaveBeenCalledTimes(200);
      } finally {
        tap.mockRestore();
      }
    });

    test("does not include permission-denial controls in dry-run interactions", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      (explore as any).observeScreen = {
        execute: async () =>
          createMockObservation([
            createMockViewHierarchyNode({
              text: "Don't allow",
              "resource-id": "com.android.permissioncontroller:id/permission_deny_button",
            }),
            createMockViewHierarchyNode({
              text: "Allow",
              "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
            }),
          ]),
      };

      const result = await explore.execute({ dryRun: true, maxInteractions: 2 });

      expect(result.dryRun).toBe(true);
      expect(result.plannedInteractions.map((interaction) => interaction.target.value)).toEqual([
        "Allow",
      ]);
    });

    for (const mode of ["hybrid", "discover"] as const) {
      test(`should use graph stats instead of exporting the full graph for ${mode} progress node counts`, async () => {
        fakeGraph.recordNavigationEvent({
          destination: "Home",
          source: "TEST",
          arguments: {},
          metadata: {},
          timestamp: fakeTimer.now(),
          sequenceNumber: 1,
          applicationId: "com.test.app",
        });

        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        (explore as any).observeScreen = {
          execute: async () => createMockObservation(),
        };
        (explore as any).performInteraction = async () => {
          fakeGraph.recordNavigationEvent({
            destination: "Settings",
            source: "TEST",
            arguments: {},
            metadata: {},
            timestamp: fakeTimer.now(),
            sequenceNumber: 2,
            applicationId: "com.test.app",
          });
          return true;
        };

        fakeGraph.clearCallHistory();
        const progressMessages: string[] = [];

        const result = await explore.execute(
          {
            maxInteractions: 1,
            timeoutMs: 5000,
            packageName: "com.test.app",
            mode,
          },
          (_current, _total, message) => {
            progressMessages.push(message);
          },
        );

        expect(fakeGraph.getMethodCallCount("getStats")).toBe(1);
        expect(fakeGraph.getMethodCallCount("exportGraph")).toBe(2);
        expect(progressMessages).toContain("Explored 1 new screens (1/1 interactions)");
        expect(result.screensDiscovered).toBe(1);
      });
    }
  });

  describe("root screen recovery", () => {
    const target = "com.test.app";
    const launcher = "com.android.launcher3";
    const rootStop = "No unexplored interactions on the root screen: Login";

    function rootRun(button?: string, initialScreen = "Login", initialForeground = target) {
      fakeGraph.setCurrentAppId(target);
      fakeGraph.addNode({
        screenName: initialScreen,
        firstSeenAt: 0,
        lastSeenAt: 0,
        visitCount: 1,
      });
      fakeGraph.setCurrentScreenValue(initialScreen);
      explore = new Explore(device, null, fakeTimer, fakeGraph);
      const parser = new FakeElementParser();
      const fields = ["Email", "Password"].map((text) =>
        createMockElement({
          text,
          class: "android.widget.EditText",
          "resource-id": `field:${text}`,
        }),
      );
      parser.nextFlattenedElements = fields.map((element, index) => ({ element, index, depth: 0 }));
      if (button) {
        parser.nextFlattenedElements.push({
          element: createMockElement({ text: button, "resource-id": "guest" }),
          index: 2,
          depth: 0,
        });
      }
      Reflect.set(explore, "elementParser", parser);
      let foreground = initialForeground;
      let screen = initialScreen;
      const actions: string[] = [];
      const observe = new FakeObserveScreen();
      observe.setObserveResult(() => {
        fakeGraph.setCurrentScreenValue(foreground === target ? screen : null);
        // Only element lists are faked; no synthetic view-hierarchy tree.
        return { viewHierarchy: { hierarchy: {}, packageName: foreground } } as ObserveResult;
      });
      explore.observeScreen = observe;
      const back = spyOn(PressButton.prototype, "press").mockImplementation(async () => {
        actions.push("back");
        foreground = launcher;
        return { success: true };
      });
      const launch = spyOn(LaunchApp.prototype, "execute").mockImplementation(async () => {
        actions.push("launch");
        foreground = target;
        screen = "Login";
        return { success: true, packageName: target };
      });
      const tap = spyOn(TapOnElement.prototype, "execute").mockImplementation(async (options) => {
        actions.push(`tap:${options.elementId}`);
        return { success: true };
      });
      return {
        parser,
        actions,
        back,
        launch,
        tap,
        setScreen: (value: string) => {
          screen = value;
        },
        setForeground: (value: string) => {
          foreground = value;
        },
        restore: () => {
          back.mockRestore();
          launch.mockRestore();
          tap.mockRestore();
        },
      };
    }

    test("root login with only inputs stops after one Back and relaunch", async () => {
      const run = rootRun();
      try {
        const result = await explore.execute({ packageName: target, timeoutMs: 90000 });
        expect(result.stopReason).toBe(rootStop);
        expect(result.success).toBe(true);
        expect(result.interactionsPerformed).toBe(0);
        expect(result.screensDiscovered).toBe(0);
        expect(result.edgesAdded).toBe(0);
        expect(result.explorationPath).toEqual(["Login"]);
        expect(run.actions).toEqual(["back", "launch"]);
        expect(result.durationMs).toBe(2000);
        expect(fakeTimer.now()).toBe(2000);
        expect(Reflect.get(explore, "consecutiveOutOfAppCount")).toBe(1);
      } finally {
        run.restore();
      }
    });

    for (const button of ["Continue as Guest", "Skip", "Sign up"]) {
      test(`login tries ${button} before any Back and never taps inputs`, async () => {
        const run = rootRun(button);
        try {
          const result = await explore.execute({
            packageName: target,
            maxInteractions: 1,
            timeoutMs: 90000,
          });
          expect(run.actions).toEqual(["tap:guest"]);
          expect(result.interactionsPerformed).toBe(1);
          expect(result.elementSelections?.[0]?.text).toBe(button);
          expect(result.stopReason).toBe("Reached max interactions limit (1)");
          expect(fakeTimer.now()).toBe(0);
        } finally {
          run.restore();
        }
      });
    }

    test("a relaunched root tries its buttons then stops without Back", async () => {
      const run = rootRun("Continue as Guest", "Login", launcher);
      try {
        const result = await explore.execute({ packageName: target, timeoutMs: 90000 });
        expect(run.actions).toEqual(["launch", "tap:guest", "tap:guest"]);
        expect(result.interactionsPerformed).toBe(2);
        expect(result.stopReason).toBe(rootStop);
        expect(result.durationMs).toBe(1000);
      } finally {
        run.restore();
      }
    });

    for (const recovery of ["handoff", "periodic reset"] as const) {
      test(`a ${recovery} relaunch resuming Detail backs out and explores Home's remaining candidate`, async () => {
        const run = rootRun(undefined, "Home");
        const homeElements = ["detail", "remaining"].map((id) =>
          createMockElement({ text: "Open", "resource-id": id }),
        );
        const setElements = (elements: Element[]) => {
          run.parser.nextFlattenedElements = elements.map((element, index) => ({
            element,
            index,
            depth: 0,
          }));
        };
        setElements(homeElements);
        run.tap.mockImplementation(async (options) => {
          run.actions.push(`tap:${options.elementId}`);
          if (options.elementId === "detail") {
            run.setScreen("Detail");
            setElements([createMockElement({ text: "Share", "resource-id": "share" })]);
          } else if (options.elementId === "share") {
            setElements([]);
            if (recovery === "handoff") {
              run.setForeground("com.android.browser");
            }
          }
          return { success: true };
        });
        run.launch.mockImplementation(async () => {
          run.actions.push("launch");
          run.setForeground(target);
          // A warm launch resumes the existing task instead of opening Home.
          run.setScreen("Detail");
          return { success: true, packageName: target };
        });
        run.back.mockImplementation(async (button) => {
          run.actions.push(button);
          if (button === "home") {
            run.setForeground(launcher);
          } else {
            run.setScreen("Home");
            setElements(homeElements.slice(1));
          }
          return { success: true };
        });
        try {
          const result = await explore.execute({
            packageName: target,
            strategy: "depth-first",
            maxInteractions: 3,
            resetToHome: recovery === "periodic reset",
            resetInterval: 2,
          });
          expect(run.actions).toEqual([
            "tap:detail",
            "tap:share",
            ...(recovery === "periodic reset" ? ["home"] : []),
            "launch",
            "back",
            "tap:remaining",
          ]);
          expect(result.stopReason).toBe("Reached max interactions limit (3)");
          expect(result.interactionsPerformed).toBe(3);
          expect(result.explorationPath).toEqual(["Home", "Detail"]);
          expect(Reflect.get(explore, "rootScreens")).toEqual(new Set());
        } finally {
          run.restore();
        }
      });
    }

    test("an initial relaunch landing on a screen with an in-app parent does not mark a root", async () => {
      const run = rootRun(undefined, "Detail", launcher);
      fakeGraph.addEdge({ from: "Home", to: "Detail", timestamp: 0, edgeType: "tool" });
      run.launch.mockImplementation(async () => {
        run.actions.push("launch");
        run.setForeground(target);
        run.setScreen("Detail");
        return { success: true, packageName: target };
      });
      const seams = explore as unknown as {
        enforceTargetApp: (observation: ObserveResult, packageName: string) => Promise<string>;
        handleDeadEnd: () => Promise<void>;
      };
      try {
        await seams.enforceTargetApp(
          { activeWindow: { appId: launcher } } as ObserveResult,
          target,
        );
        await seams.enforceTargetApp({ activeWindow: { appId: target } } as ObserveResult, target);
        await seams.handleDeadEnd();
        expect(run.actions).toEqual(["launch", "back"]);
        expect(Reflect.get(explore, "rootScreens")).toEqual(new Set());
      } finally {
        run.restore();
      }
    });

    test("an initial relaunch landing on a screen reached only by recorded Back edges marks a root", async () => {
      const run = rootRun(undefined, "Home", launcher);
      // The loader yields edgeType "tool" for a recorded Back (never "back"): Back from
      // Detail landing on Home makes Detail a descendant, not an in-app parent.
      fakeGraph.addEdge({
        from: "Detail",
        to: "Home",
        timestamp: 0,
        edgeType: "tool",
        interaction: { toolName: "pressButton", args: { button: "back" }, timestamp: 0 },
      });
      run.launch.mockImplementation(async () => {
        run.actions.push("launch");
        run.setForeground(target);
        run.setScreen("Home");
        return { success: true, packageName: target };
      });
      const seams = explore as unknown as {
        enforceTargetApp: (observation: ObserveResult, packageName: string) => Promise<string>;
        handleDeadEnd: () => Promise<void>;
      };
      try {
        await seams.enforceTargetApp(
          { activeWindow: { appId: launcher } } as ObserveResult,
          target,
        );
        await seams.enforceTargetApp({ activeWindow: { appId: target } } as ObserveResult, target);
        await seams.handleDeadEnd();
        expect(run.actions).toEqual(["launch"]);
        expect(Reflect.get(explore, "rootScreens")).toEqual(new Set(["Home"]));
      } finally {
        run.restore();
      }
    });

    test("a null relaunch screen marks no root and unresolved dead ends still press Back", async () => {
      const run = rootRun(undefined, "Login", launcher);
      const seams = explore as unknown as {
        enforceTargetApp: (observation: ObserveResult, packageName: string) => Promise<string>;
        handleDeadEnd: () => Promise<void>;
      };
      const observation = (packageName: string) =>
        ({ activeWindow: { appId: packageName } }) as ObserveResult;
      try {
        await seams.enforceTargetApp(observation(launcher), target);
        fakeGraph.setCurrentScreenValue(null);
        await seams.enforceTargetApp(observation(target), target);
        await seams.handleDeadEnd();
        // An unresolved Back must not introduce an "unknown" root either.
        await seams.enforceTargetApp(observation(launcher), target);
        await seams.enforceTargetApp(observation(target), target);
        await seams.handleDeadEnd();
        expect(run.actions).toEqual(["launch", "back", "launch", "back"]);
        expect(Reflect.get(explore, "rootScreens")).toEqual(new Set());
        expect(Reflect.get(explore, "stopReason")).toBe("");
      } finally {
        run.restore();
      }
    });

    test("Back leaving a non-root screen recovers once and explores another candidate", async () => {
      const run = rootRun(undefined, "Detail");
      const launch = run.launch.getMockImplementation()!;
      run.launch.mockImplementation(async (...args) => {
        const result = await launch(...args);
        run.parser.nextFlattenedElements!.push({
          element: createMockElement({ text: "Continue as Guest", "resource-id": "guest" }),
          index: 2,
          depth: 0,
        });
        return result;
      });
      try {
        const result = await explore.execute({
          packageName: target,
          maxInteractions: 1,
          timeoutMs: 90000,
        });
        expect(run.actions).toEqual(["back", "launch", "tap:guest"]);
        expect(result.interactionsPerformed).toBe(1);
        expect(result.explorationPath).toEqual(["Detail", "Login"]);
        expect(result.durationMs).toBe(2000);
        expect(Reflect.get(explore, "consecutiveOutOfAppCount")).toBe(0);
      } finally {
        run.restore();
      }
    });

    test("remembers the exiting screen even when relaunch lands elsewhere", async () => {
      const run = rootRun(undefined, "Detail");
      const launch = run.launch.getMockImplementation()!;
      run.launch.mockImplementation(async (...args) => {
        const result = await launch(...args);
        run.parser.nextFlattenedElements!.push({
          element: createMockElement({ text: "Continue as Guest", "resource-id": "guest" }),
          index: 2,
          depth: 0,
        });
        return result;
      });
      const tap = run.tap.getMockImplementation()!;
      run.tap.mockImplementation(async (...args) => {
        const result = await tap(...args);
        run.setScreen("Detail");
        run.parser.nextFlattenedElements!.pop();
        return result;
      });
      try {
        const result = await explore.execute({ packageName: target, timeoutMs: 90000 });
        expect(run.actions).toEqual(["back", "launch", "tap:guest"]);
        expect(result.stopReason).toBe("No unexplored interactions on the root screen: Detail");
        expect(result.interactionsPerformed).toBe(1);
        expect(result.durationMs).toBe(2000);
      } finally {
        run.restore();
      }
    });

    test("target returns alone do not reset the five-attempt recovery bound", async () => {
      const run = rootRun();
      const seams = explore as unknown as {
        enforceTargetApp: (observation: ObserveResult, packageName: string) => Promise<string>;
      };
      const observation = (packageName: string) =>
        ({ activeWindow: { appId: packageName } }) as ObserveResult;
      try {
        for (let attempt = 1; attempt < 5; attempt++) {
          expect(await seams.enforceTargetApp(observation(launcher), target)).toBe("handled");
          expect(await seams.enforceTargetApp(observation(target), target)).toBe("ok");
          expect(Reflect.get(explore, "consecutiveOutOfAppCount")).toBe(attempt);
        }
        expect(await seams.enforceTargetApp(observation(launcher), target)).toBe("stop");
        expect(run.launch).toHaveBeenCalledTimes(5);
        expect(Reflect.get(explore, "stopReason")).toBe(
          "Left target app (com.test.app) without exploration progress after 5 return attempts",
        );
        expect(fakeTimer.now()).toBe(5000);
      } finally {
        run.restore();
      }
    });
  });

  describe("target app recovery and reports", () => {
    function recoverySeams() {
      return explore as unknown as {
        selectNextElement: () => Promise<Element | undefined>;
        performInteraction: () => Promise<boolean>;
        consecutiveOutOfAppCount: number;
        generateReport: (
          initialGraph: ExportedGraph,
          startTime: number,
          cancelled: boolean,
        ) => Promise<ExploreResult>;
      };
    }

    function seedTargetGraph(): ExportedGraph {
      fakeGraph.setCurrentAppId("com.test.app");
      for (const screenName of ["Home", "Settings", "Profile"]) {
        fakeGraph.addNode({ screenName, firstSeenAt: 0, lastSeenAt: 0, visitCount: 1 });
      }
      fakeGraph.addEdge({ from: "Home", to: "Settings", timestamp: 0, edgeType: "tool" });
      fakeGraph.addEdge({ from: "Home", to: "Profile", timestamp: 0, edgeType: "tool" });
      fakeGraph.setCurrentScreenValue("Home");
      return fakeGraph.exportGraph();
    }

    test("reports the target graph after leaving the app and exhausting return attempts", async () => {
      const targetGraph = seedTargetGraph();
      const finalTargetGraph: ExportedGraph = {
        ...targetGraph,
        nodes: [
          ...targetGraph.nodes,
          { screenName: "Detail", firstSeenAt: 0, lastSeenAt: 0, visitCount: 1 },
        ],
        edges: [
          ...targetGraph.edges,
          { from: "Profile", to: "Detail", timestamp: 0, edgeType: "tool" },
        ],
        currentScreen: null,
      };
      const targetExport = spyOn(fakeGraph, "exportGraphForApp").mockResolvedValue(
        finalTargetGraph,
      );
      const launch = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
        success: true,
        packageName: "com.test.app",
      });
      const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => {
          fakeGraph.clearCurrentGraph();
          fakeGraph.setCurrentAppId("com.android.launcher3");
          return createMockObservation([], "com.android.launcher3");
        },
      } as typeof explore.observeScreen;
      try {
        const result = await explore.execute({ packageName: "com.test.app" });
        expect(result.navigationGraph).toEqual(finalTargetGraph);
        expect(result.screensDiscovered).toBe(1);
        expect(result.edgesAdded).toBe(1);
        expect(result.coverage.totalScreens).toBe(4);
        expect(result.success).toBe(true);
        expect(result.cancelled).toBe(false);
        expect(result.stopReason).toBe(
          "Left target app (com.test.app) without exploration progress after 5 return attempts",
        );
        expect(targetExport).toHaveBeenCalledWith(targetGraph.appId);
        expect(launch).toHaveBeenCalledTimes(5);
        expect(back).not.toHaveBeenCalled();
        expect(recoverySeams().consecutiveOutOfAppCount).toBe(5);
      } finally {
        targetExport.mockRestore();
        launch.mockRestore();
        back.mockRestore();
      }
    });

    test("relaunches the target and resets consecutive attempts after returning", async () => {
      seedTargetGraph();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      let foreground = "com.android.launcher3";
      explore.observeScreen = {
        execute: async () => createMockObservation([], foreground),
      } as typeof explore.observeScreen;
      recoverySeams().performInteraction = async () => true;
      const launch = spyOn(LaunchApp.prototype, "execute").mockImplementation(
        async (packageName) => {
          foreground = packageName;
          return { success: true, packageName };
        },
      );
      const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      const controller = new AbortController();
      try {
        const result = await explore.execute(
          { packageName: "com.test.app", maxInteractions: 1 },
          undefined,
          controller.signal,
        );
        expect(result.interactionsPerformed).toBe(1);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(launch.mock.calls[0]?.slice(0, 3)).toEqual(["com.test.app", false, false]);
        expect(launch.mock.calls[0]?.[6]).toBe(controller.signal);
        expect(back).not.toHaveBeenCalled();
        expect(recoverySeams().consecutiveOutOfAppCount).toBe(0);
        expect(result.stopReason).toBe("Reached max interactions limit (1)");
      } finally {
        launch.mockRestore();
        back.mockRestore();
      }
    });

    for (const failure of ["typed failure", "throw"] as const) {
      test(`counts failed target relaunch attempts without throwing (${failure})`, async () => {
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        explore.observeScreen = {
          execute: async () => createMockObservation([], "com.android.launcher3"),
        } as typeof explore.observeScreen;
        const launch = spyOn(LaunchApp.prototype, "execute").mockImplementation(async () => {
          if (failure === "throw") {
            throw new Error("Launch rejected");
          }
          return { success: false, error: "Launch rejected" };
        });
        const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          const result = await explore.execute({ packageName: "com.test.app" });
          expect(launch).toHaveBeenCalledTimes(5);
          expect(back).not.toHaveBeenCalled();
          expect(result.stopReason).toContain(
            "without exploration progress after 5 return attempts",
          );
          expect(recoverySeams().consecutiveOutOfAppCount).toBe(5);
          expect(
            warn.mock.calls.filter(([message]) =>
              message.startsWith("[Explore] Failed to return to target app: Launch rejected"),
            ),
          ).toHaveLength(5);
        } finally {
          launch.mockRestore();
          back.mockRestore();
          warn.mockRestore();
        }
      });
    }

    test("uses Back for an ordinary dead end with no packageName option", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => createMockObservation([], ""),
      } as typeof explore.observeScreen;
      recoverySeams().selectNextElement = async () => undefined;
      const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      const launch = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({ success: true });
      try {
        const result = await explore.execute({ timeoutMs: 1000 });
        expect(back.mock.calls[0][0]).toBe("back");
        expect(launch).not.toHaveBeenCalled();
        expect(result.stopReason).toBe("Reached timeout limit (1000ms)");
      } finally {
        back.mockRestore();
        launch.mockRestore();
      }
    });

    test("a run that only re-traverses known transitions reports no edges added (#10194)", async () => {
      const initialGraph = seedTargetGraph();
      // Re-traversal appends rows to the log; the distinct transitions are unchanged.
      const retraversed = spyOn(fakeGraph, "exportGraphForApp").mockResolvedValue({
        ...initialGraph,
        edges: [...initialGraph.edges, ...initialGraph.edges, ...initialGraph.edges],
      });
      try {
        const result = await recoverySeams().generateReport(initialGraph, fakeTimer.now(), false);
        expect(result.edgesAdded).toBe(0);
      } finally {
        retraversed.mockRestore();
      }
    });

    test("a cancel that lands after the loop's check does not press Back for the dead end (#10151)", async () => {
      const controller = new AbortController();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => {
          controller.abort();
          return createMockObservation([], "");
        },
      } as typeof explore.observeScreen;
      recoverySeams().selectNextElement = async () => undefined;
      const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      try {
        const result = await explore.execute({ timeoutMs: 1000 }, undefined, controller.signal);
        expect(back).not.toHaveBeenCalled();
        expect(result.cancelled).toBe(true);
        expect(result.stopReason).toBe("Operation cancelled");
      } finally {
        back.mockRestore();
      }
    });

    test("forwards the exploration signal into the dead-end Back press (#10151)", async () => {
      const controller = new AbortController();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => createMockObservation([], ""),
      } as typeof explore.observeScreen;
      recoverySeams().selectNextElement = async () => undefined;
      const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      try {
        await explore.execute({ timeoutMs: 1000 }, undefined, controller.signal);
        expect(back).toHaveBeenCalledWith("back", undefined, undefined, controller.signal);
      } finally {
        back.mockRestore();
      }
    });

    test("a cancel during the dead-end Back press is a cancelled run, not a failed recovery (#10151)", async () => {
      const controller = new AbortController();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => createMockObservation([], ""),
      } as typeof explore.observeScreen;
      recoverySeams().selectNextElement = async () => undefined;
      const back = spyOn(PressButton.prototype, "press").mockImplementation(async () => {
        controller.abort();
        throw new Error("Operation cancelled");
      });
      try {
        const result = await explore.execute({ timeoutMs: 1000 }, undefined, controller.signal);
        expect(result.cancelled).toBe(true);
        expect(result.stopReason).toBe("Operation cancelled");
      } finally {
        back.mockRestore();
      }
    });

    for (const appId of ["com.test.app", null]) {
      test(`clamps report counts when the graph shrinks (initial appId ${appId})`, async () => {
        const initialGraph = { ...seedTargetGraph(), appId };
        fakeGraph.clearCurrentGraph();
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        const result = await recoverySeams().generateReport(initialGraph, fakeTimer.now(), false);
        expect(result.screensDiscovered).toBe(0);
        expect(result.edgesAdded).toBe(0);
        expect(result.navigationGraph.appId).toBe("com.test.app");
        expect(fakeGraph.getMethodCallCount("exportGraphForApp")).toBe(appId ? 1 : 0);
      });
    }

    test("keeps a normal in-app report unchanged", async () => {
      seedTargetGraph();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = {
        execute: async () => createMockObservation(),
      } as typeof explore.observeScreen;
      recoverySeams().performInteraction = async () => true;
      const result = await explore.execute({ packageName: "com.test.app", maxInteractions: 1 });
      expect(result).toMatchObject({
        success: true,
        cancelled: false,
        interactionsPerformed: 1,
        screensDiscovered: 0,
        edgesAdded: 0,
        navigationGraph: fakeGraph.exportGraph(),
        coverage: { totalScreens: 3, exploredScreens: 1, percentage: 33.33 },
        explorationPath: ["Home"],
        durationMs: 0,
        stopReason: "Reached max interactions limit (1)",
      });
    });

    for (const leftTarget of [true, false]) {
      test(`tool message ${leftTarget ? "discloses leaving the target app" : "preserves normal completion"}`, async () => {
        const stopReason = leftTarget
          ? "Left target app (com.test.app) without exploration progress after 5 return attempts"
          : "Reached max interactions limit (1)";
        const result: ExploreResult = {
          success: true,
          interactionsPerformed: 1,
          screensDiscovered: 0,
          edgesAdded: 0,
          navigationGraph: seedTargetGraph(),
          explorationPath: ["Home"],
          coverage: { totalScreens: 3, exploredScreens: 1, percentage: 33.33 },
          durationMs: 0,
          stopReason,
        };
        const execute = spyOn(Explore.prototype, "execute").mockResolvedValue(result);
        const manager = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
          fakeGraph as unknown as NavigationGraphManager,
        );
        try {
          registerNavigationTools();
          const registry = ToolRegistry as unknown as {
            tools: Map<
              string,
              {
                deviceAwareHandler: (
                  device: BootedDevice,
                  args: object,
                ) => Promise<{
                  content: Array<{ text: string }>;
                }>;
              }
            >;
          };
          const response = await registry.tools.get("explore")!.deviceAwareHandler(device, {});
          const output = JSON.parse(response.content[0]!.text);
          expect(output.success).toBe(true);
          expect(output.stopReason).toBe(stopReason);
          expect(output.message).toBe(
            leftTarget
              ? `Exploration stopped: ${stopReason}. 1 interactions, 0 new screens discovered, 33.33% coverage`
              : "Exploration completed: 1 interactions, 0 new screens discovered, 33.33% coverage",
          );
        } finally {
          execute.mockRestore();
          manager.mockRestore();
        }
      });
    }
  });

  describe("execute characterization", () => {
    function executionSeams(instance: Explore) {
      return instance as unknown as {
        performInteraction: () => Promise<boolean>;
        resetToHome: () => Promise<void>;
        loopDetection: Map<string, number>;
        previousScreen: string | null;
        consecutiveNoChangeCount: number;
      };
    }

    test("tracks first, unchanged, missing and returning screens only after successful interactions", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      spyOn(explore.observeScreen, "execute").mockResolvedValue(createMockObservation());
      const seams = executionSeams(explore);
      const outcomes = ["A", "A", null, "B", "A", "B", "A"];
      spyOn(seams, "performInteraction").mockImplementation(async () => {
        fakeGraph.setCurrentScreenValue(outcomes.shift() ?? null);
        return true;
      });

      const result = await explore.execute({ maxInteractions: 20 });

      expect(result.interactionsPerformed).toBe(7);
      expect(result.stopReason).toBe("Detected navigation loop on screen: A");
      expect([...seams.loopDetection]).toEqual([
        ["A", 3],
        ["B", 2],
      ]);
      expect(seams.previousScreen).toBe("A");
      expect(result.explorationPath).toEqual(["A", "B"]);
    });

    test("failed interactions retain previous-screen tracking and successful ones reset the no-change streak", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      spyOn(explore.observeScreen, "execute").mockResolvedValue(createMockObservation());
      const seams = executionSeams(explore);
      const outcomes = [true, false, true];
      spyOn(seams, "performInteraction").mockImplementation(async () => {
        const success = outcomes.shift() ?? false;
        fakeGraph.setCurrentScreenValue(success ? "A" : "Ignored");
        return success;
      });

      const result = await explore.execute({ maxInteractions: 2 });

      expect(result.interactionsPerformed).toBe(2);
      expect([...seams.loopDetection]).toEqual([["A", 1]]);
      expect(seams.previousScreen).toBe("A");
      expect(seams.consecutiveNoChangeCount).toBe(0);
    });

    for (const reachesDestination of [true, false]) {
      test(`validation ${reachesDestination ? "success precedes progress and reset" : "failure skips loop accounting, progress and reset"}`, async () => {
        fakeGraph.setCurrentScreenValue("A");
        fakeGraph.addEdge({
          from: "A",
          to: "B",
          timestamp: 0,
          edgeType: "tool",
          interaction: { toolName: "tapOn", args: { text: "Settings" }, timestamp: 0 },
          uiState: { selectedElements: [{ text: "Home tab" }] },
        });
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        spyOn(explore.observeScreen, "execute").mockResolvedValue(createMockObservation());
        const seams = executionSeams(explore);
        const events: string[] = [];
        spyOn(seams, "performInteraction").mockImplementation(async () => {
          events.push("interact");
          fakeGraph.setCurrentScreenValue(reachesDestination ? "B" : "Wrong");
          return true;
        });
        spyOn(seams, "resetToHome").mockImplementation(async () => {
          events.push("reset");
        });
        const stats = spyOn(fakeGraph, "getStats");

        const result = await explore.execute(
          { mode: "validate", maxInteractions: 1, resetToHome: true, resetInterval: 1 },
          async (_current, _total, message) => {
            events.push(message);
            if (message.startsWith("Validating graph:")) {
              expect(explore.graphTraversalState?.traversedEdges.size).toBe(1);
              expect(seams.previousScreen).toBe("B");
            }
          },
        );

        expect(result.interactionsPerformed).toBe(1);
        expect(result.graphTraversal?.edgeValidationResults[0]).toMatchObject({
          actualTo: reachesDestination ? "B" : "Wrong",
          success: reachesDestination,
          matchConfidence: 0.9,
        });
        expect(events).toEqual(
          reachesDestination
            ? [
                "Starting exploration...",
                "interact",
                "Validating graph: 1/1 edges traversed (100%) - 1/1 interactions",
                "reset",
              ]
            : ["Starting exploration...", "interact"],
        );
        expect([...seams.loopDetection]).toEqual(reachesDestination ? [["B", 1]] : []);
        expect(stats).not.toHaveBeenCalled();
      });
    }

    test("a rejected progress callback is wrapped before any periodic reset", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      spyOn(explore.observeScreen, "execute").mockResolvedValue(createMockObservation());
      const seams = executionSeams(explore);
      spyOn(seams, "performInteraction").mockResolvedValue(true);
      const reset = spyOn(seams, "resetToHome").mockResolvedValue(undefined);
      const error = new Error("progress rejected");
      const execution = explore.execute(
        { maxInteractions: 1, resetToHome: true, resetInterval: 1 },
        async (current) => {
          if (current > 0) {
            throw error;
          }
        },
      );
      await expect(execution).rejects.toThrow("Failed to execute exploration");
      await expect(execution).rejects.toThrow("progress rejected");
      expect(reset).not.toHaveBeenCalled();
    });

    test("an already aborted run skips observation and returns a cancelled partial report", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      const observe = spyOn(explore.observeScreen, "execute");
      const controller = new AbortController();
      controller.abort();
      const result = await explore.execute({}, undefined, controller.signal);
      expect(result.cancelled).toBe(true);
      expect(result.interactionsPerformed).toBe(0);
      expect(observe).not.toHaveBeenCalled();
    });
  });

  describe("element selection", () => {
    test("should prioritize navigation elements", async () => {
      const nodes = [
        createMockViewHierarchyNode({
          text: "Settings",
          class: "android.widget.Button",
          "resource-id": "com.test:id/settings_btn",
        }),
        createMockViewHierarchyNode({
          text: "Like",
          class: "android.widget.ImageButton",
          clickable: "true",
        }),
        createMockViewHierarchyNode({
          text: "",
          class: "android.widget.EditText",
          clickable: "true",
        }),
      ];

      const mockObservation = createMockObservation(nodes);

      const navElements = extractNavigationElements(mockObservation.viewHierarchy, elementParser);

      // Should filter out EditText
      expect(navElements.length).toBeLessThan(nodes.length);

      // Should include Settings button
      const hasSettings = navElements.some((el: Element) => el.text === "Settings");
      expect(hasSettings).toBe(true);
    });

    test("should calculate navigation scores correctly", async () => {
      const buttonElement = createMockElement({
        text: "Settings",
        class: "android.widget.Button",
        "resource-id": "com.test:id/settings_btn",
      });
      // Set hierarchyDepth for button (deeper in the hierarchy)
      (buttonElement as any).hierarchyDepth = 8;

      const tabElement = createMockElement({
        text: "Profile",
        class: "android.widget.TabLayout",
        "resource-id": "com.test:id/tab_profile",
      });
      // Set hierarchyDepth for tab (closer to root, should score higher)
      (tabElement as any).hierarchyDepth = 2;

      const buttonScore = calculateNavigationScore(buttonElement);
      const tabScore = calculateNavigationScore(tabElement);

      // Tab should score higher than button due to being closer to root
      // Button: 5 (clickable) + max(0, 25 - 8*2) = 5 + 9 = 14
      // Tab: 5 (clickable) + max(0, 25 - 2*2) = 5 + 21 = 26
      expect(tabScore).toBeGreaterThan(buttonScore);
      expect(buttonScore).toBeGreaterThan(0);
    });

    test("should filter out non-clickable elements", async () => {
      const nodes = [
        createMockViewHierarchyNode({ clickable: "true" }),
        createMockViewHierarchyNode({ clickable: "false" }),
        createMockViewHierarchyNode({ clickable: "true", enabled: "false" }),
      ];

      const mockObservation = createMockObservation(nodes);

      const navElements = extractNavigationElements(mockObservation.viewHierarchy, elementParser);

      // Should only include enabled clickable elements
      expect(navElements.length).toBe(1);
    });
  });

  describe("blocker detection", () => {
    test("should detect permission dialogs", async () => {
      const elements = [
        createMockElement({ text: "Allow" }),
        createMockElement({ text: "While using the app" }),
        createMockElement({ text: "This app needs camera permission" }),
      ];

      const isPermission = isPermissionDialog(elements);

      expect(isPermission).toBe(true);
    });

    // Regression: a deny-only permission dialog (only "Don't allow") cannot be
    // granted and its deny control is deliberately never tapped (issue #6241).
    // The permission fast-path used to discard handlePermissionDialog's `false`
    // and `continue` unconditionally, re-observing the same unchanged dialog
    // forever until the timeout. The no-op must now be counted so the existing
    // stuck-screen accounting stops exploration (partially addresses #6169).
    test("does not loop indefinitely on a deny-only permission dialog", async () => {
      // The deny control must never be tapped: inject a fake tap action and
      // assert it is never invoked (issue #6191 — no more TapOnElement.prototype
      // spy). The blocker handler's post-tap sleep runs on the injected
      // auto-advancing fakeTimer, so the run stays fast without stubbing a
      // module-level timer.
      const fakeTap = new FakeDialogTapAction();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);

      const denyOnlyDialog = createMockObservation([
        createMockViewHierarchyNode({
          class: "android.widget.Button",
          text: "Don't allow",
          "resource-id": "com.android.permissioncontroller:id/permission_deny_button",
          clickable: "true",
        }),
        createMockViewHierarchyNode({
          class: "android.widget.TextView",
          text: "This app needs camera permission",
          clickable: "false",
        }),
      ]);

      let observeCount = 0;
      (explore as any).observeScreen = {
        execute: async () => {
          observeCount++;
          return denyOnlyDialog;
        },
        getMostRecentCachedObserveResult: async () => denyOnlyDialog,
      };

      // maxInteractions and timeout are set generously so the ONLY thing that
      // can terminate the run is the stuck-screen accounting; without the fix
      // this run would spin forever.
      const result = await explore.execute({
        maxInteractions: 1000,
        timeoutMs: 60_000_000,
        packageName: "com.test.app",
      });

      const maxNoChange = (Explore as any).MAX_CONSECUTIVE_NO_CHANGE as number;
      expect(result.stopReason).toContain("stuck");
      // Bounded by the stuck counter, not maxInteractions or the timeout.
      expect(observeCount).toBe(maxNoChange);
      expect(fakeTap.calls).toEqual([]);
    });

    // A grantable permission dialog still taps "Allow" and exploration proceeds.
    test("grants a permission dialog and continues exploring", async () => {
      const fakeTap = new FakeDialogTapAction();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);

      const grantDialog = createMockObservation([
        createMockViewHierarchyNode({
          class: "android.widget.Button",
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
          clickable: "true",
        }),
        createMockViewHierarchyNode({
          class: "android.widget.TextView",
          text: "This app needs camera permission",
          clickable: "false",
        }),
      ]);
      const normalScreen = createMockObservation();

      let observeCount = 0;
      (explore as any).observeScreen = {
        execute: async () => {
          observeCount++;
          return observeCount === 1 ? grantDialog : normalScreen;
        },
        getMostRecentCachedObserveResult: async () => normalScreen,
      };

      // handlePermissionDialog sleeps after a grant; that sleep now runs on the
      // injected auto-advancing fakeTimer (issue #6191), so no defaultTimer stub
      // is needed to keep the test fast.
      // Successful interactions advance the interaction counter so the run ends
      // deterministically at maxInteractions rather than via stuck detection.
      (explore as any).performInteraction = async () => true;

      const result = await explore.execute({
        maxInteractions: 2,
        timeoutMs: 5000,
        packageName: "com.test.app",
      });

      // The "Allow" button was tapped exactly once, via the permission fast-path.
      expect(fakeTap.calls).toHaveLength(1);
      // Exploration continued past the dialog rather than stalling on it.
      expect(result.stopReason).not.toContain("stuck");
      expect(result.interactionsPerformed).toBe(2);
      expect(observeCount).toBeGreaterThan(1);
    });

    // Regression: a grant used to report "continue" without clearing the
    // no-change streak accrued by earlier ungrantable dialogs. In a
    // multi-permission flow, a first prompt that racks up the streak before
    // being granted left it elevated, so a single unrelated no-change
    // observation on the next prompt could immediately trip the stuck-screen
    // stop despite the intervening successful grant.
    test("resets the no-change streak after granting a permission", async () => {
      const fakeTap = new FakeDialogTapAction();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);

      const grantDialog = createMockObservation([
        createMockViewHierarchyNode({
          class: "android.widget.Button",
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
          clickable: "true",
        }),
        createMockViewHierarchyNode({
          class: "android.widget.TextView",
          text: "This app needs camera permission",
          clickable: "false",
        }),
      ]);

      // Simulate a streak accrued by an earlier, unrelated ungrantable dialog.
      (explore as any).consecutiveNoChangeCount = 39;

      const outcome = await (explore as any).handlePermissionDialogFastPath(grantDialog);

      expect(outcome).toBe("continue");
      expect((explore as any).consecutiveNoChangeCount).toBe(0);
      expect(fakeTap.calls).toHaveLength(1);
    });

    test("does not fast-path an unconfirmed permission-like app screen", async () => {
      const fakeTap = new FakeDialogTapAction();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);
      const observation = createMockObservation([
        createMockViewHierarchyNode({ class: "android.widget.TextView", text: "App permissions" }),
        createMockViewHierarchyNode({ text: "OK", "resource-id": "com.example.app:id/ok_button" }),
      ]);

      expect(await (explore as any).handlePermissionDialogFastPath(observation)).toBe("none");
      expect(fakeTap.calls).toEqual([]);
    });

    test("caps taps on a repeatedly appearing confirmed permission dialog", async () => {
      const fakeTap = new FakeDialogTapAction();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);
      const observation = createMockObservation([
        createMockViewHierarchyNode({
          text: "Allow",
          "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
        }),
        createMockViewHierarchyNode({
          class: "android.widget.TextView",
          text: "Allow camera access",
        }),
      ]);

      for (let i = 0; i < 10; i++) {
        await (explore as any).handlePermissionDialogFastPath(observation);
      }

      expect(fakeTap.calls).toHaveLength(3);
    });

    test("should detect login screens", async () => {
      const elements = [
        createMockElement({ text: "Sign in", class: "android.widget.Button" }),
        createMockElement({ text: "", class: "android.widget.EditText" }),
        createMockElement({ text: "Password", class: "android.widget.TextView" }),
      ];

      const isLogin = isLoginScreen(elements);

      expect(isLogin).toBe(true);
    });

    test("should detect rating dialogs", async () => {
      const elements = [
        createMockElement({ text: "Rate this app" }),
        createMockElement({ text: "Not now" }),
        createMockElement({ text: "5 stars" }),
      ];

      const isRating = isRatingDialog(elements);

      expect(isRating).toBe(true);
    });

    test("should not detect regular screens as blockers", async () => {
      const elements = [
        createMockElement({ text: "Home" }),
        createMockElement({ text: "Settings" }),
        createMockElement({ text: "Profile" }),
      ];

      const isPermission = isPermissionDialog(elements);
      const isLogin = isLoginScreen(elements);
      const isRating = isRatingDialog(elements);

      expect(isPermission).toBe(false);
      expect(isLogin).toBe(false);
      expect(isRating).toBe(false);
    });
  });

  describe("performInteraction tap selector", () => {
    // TapOnElement.validateOptions rejects any call carrying more than one
    // selector, so an element with both text and resource-id must reach tapOn
    // with exactly one of them (issue #6121).
    function captureTapOptions(): { calls: unknown[]; restore: () => void } {
      const calls: unknown[] = [];
      const spy = spyOn(TapOnElement.prototype, "execute").mockImplementation(
        async (options: unknown) => {
          calls.push(options);
          return { success: true, action: "tap" } as never;
        },
      );
      return { calls, restore: () => spy.mockRestore() };
    }

    for (const label of ["child text", "grandchild text", "descendant description"]) {
      test(`taps an unlabeled clickable parent using ${label}`, async () => {
        const child = createMockViewHierarchyNode({
          text: label === "descendant description" ? "" : "Skip",
          "content-desc": label === "descendant description" ? "Skip" : "",
          "resource-id": "",
          clickable: "false",
        });
        child.bounds = { left: 20, top: 10, right: 80, bottom: 40 };
        const wrapper = createMockViewHierarchyNode({
          text: "",
          "resource-id": "",
          clickable: "false",
        });
        wrapper.node = [child];
        const parent = createMockViewHierarchyNode({ text: "", class: "", "resource-id": "" });
        parent.node = [label === "child text" ? child : wrapper];
        const observation = createMockObservation([parent]);
        const [candidate] = extractNavigationElements(observation.viewHierarchy!, elementParser);
        const { calls, restore } = captureTapOptions();
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        const perform: (element: Element, observation: ObserveResult) => Promise<boolean> =
          Reflect.get(explore, "performInteraction").bind(explore);
        try {
          expect(await perform(candidate, observation)).toBe(true);
          expect(calls).toEqual([{ text: "Skip", action: "tap" }]);
          const selection = new DefaultElementSelector().selectByText(
            observation.viewHierarchy!,
            "Skip",
          );
          expect(selection.element?.bounds).toEqual(child.bounds);
          const tapOn = new TapOnElement(device, mockAdb, {
            timer: fakeTimer,
            tapStrategy: new FakeTapStrategy(),
          });
          const target = tapOn.resolveTapTargetElement(
            selection.element!,
            observation.viewHierarchy!,
            "tap",
            false,
          );
          expect(target.element.bounds).toEqual(parent.bounds);
          expect(target.element.clickable).toBe("true");
          expect(target.usedParent).toBe(true);
        } finally {
          restore();
        }
      });
    }

    test("taps an unlabeled bounded candidate through tapAt", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      const tap = spyOn(TapAtCoordinate.prototype, "execute").mockResolvedValue({ success: true });
      const { calls, restore } = captureTapOptions();
      const perform: (element: Element, observation: ObserveResult) => Promise<boolean> =
        Reflect.get(explore, "performInteraction").bind(explore);
      try {
        expect(
          await perform(
            createMockElement({ text: "", "resource-id": "", class: "" }),
            createMockObservation(),
          ),
        ).toBe(true);
        expect(tap).toHaveBeenCalledWith({ x: 50, y: 25, action: "tap" }, undefined, undefined);
        expect(calls).toEqual([]);
      } finally {
        tap.mockRestore();
        restore();
      }
    });

    test("skips a candidate without labels or usable bounds with an actionable warning", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const { calls, restore } = captureTapOptions();
      const perform: (element: Element, observation: ObserveResult) => Promise<boolean> =
        Reflect.get(explore, "performInteraction").bind(explore);
      try {
        const element = createMockElement({
          text: "",
          "resource-id": "",
          class: "",
          bounds: { left: 0, top: 0, right: 0, bottom: 0 },
        });
        expect(await perform(element, createMockObservation())).toBe(false);
        expect(calls).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[Explore] Element has no tap target: missing resource-id, text/content-desc (including descendants), and usable bounds; class=<empty>; bounds={"left":0,"top":0,"right":0,"bottom":0}',
        );
      } finally {
        warn.mockRestore();
        restore();
      }
    });

    test("taps an element with both text and resource-id once, by id only", async () => {
      const { calls, restore } = captureTapOptions();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);

      try {
        const success = await (explore as any).performInteraction(
          createMockElement({ text: "Settings", "resource-id": "com.test:id/settings_btn" }),
          createMockObservation(),
        );
        expect(success).toBe(true);
      } finally {
        restore();
      }

      expect(calls).toEqual([{ elementId: "com.test:id/settings_btn", action: "tap" }]);
    });

    test("falls back to text, then content-desc, when no resource-id is present", async () => {
      const { calls, restore } = captureTapOptions();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);

      try {
        await (explore as any).performInteraction(
          createMockElement({ text: "Settings", "resource-id": undefined }),
          createMockObservation(),
        );
        await (explore as any).performInteraction(
          createMockElement({
            text: undefined,
            "resource-id": undefined,
            "content-desc": "Open settings",
          }),
          createMockObservation(),
        );
      } finally {
        restore();
      }

      expect(calls).toEqual([
        { text: "Settings", action: "tap" },
        { text: "Open settings", action: "tap" },
      ]);
    });

    test("disambiguates a resource-id shared by list rows by unique text, else by hierarchy index", async () => {
      // tapOn's default picks the first on-screen match, so a shared row id
      // must not be used alone: unique text wins, and identical rows pin their
      // 0-based occurrence with `index`.
      const rowId = "com.test:id/row_title";
      const row = (text: string, top: number) => ({
        $: {
          class: "android.widget.TextView",
          text,
          "resource-id": rowId,
          clickable: "true",
          enabled: "true",
        },
        bounds: { left: 0, top, right: 100, bottom: top + 50 },
      });
      const observation = createMockObservation([
        row("Alpha", 0),
        row("Beta", 50),
        row("Beta", 100),
      ]);
      const { calls, restore } = captureTapOptions();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);

      try {
        await (explore as any).performInteraction(
          createMockElement({
            text: "Alpha",
            "resource-id": rowId,
            bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          }),
          observation,
        );
        await (explore as any).performInteraction(
          createMockElement({
            text: "Beta",
            "resource-id": rowId,
            bounds: { left: 0, top: 100, right: 100, bottom: 150 },
          }),
          observation,
        );
      } finally {
        restore();
      }

      expect(calls).toEqual([
        { text: "Alpha", action: "tap" },
        { elementId: rowId, index: 2, action: "tap" },
      ]);
    });

    test("counts the occurrence index over tapOn's on-screen matches, skipping off-screen rows", async () => {
      // tapOn drops matches whose center is off screen before applying `index`,
      // so a scrolled-away duplicate row above the target must not shift it.
      const rowId = "com.test:id/row_title";
      const row = (text: string, top: number) => ({
        $: { class: "android.widget.TextView", text, "resource-id": rowId, clickable: "true" },
        bounds: { left: 0, top, right: 100, bottom: top + 50 },
      });
      const observation = {
        viewHierarchy: {
          hierarchy: {
            node: [row("Beta", -100), row("Alpha", 0), row("Beta", 50), row("Beta", 100)],
          },
          packageName: "com.test.app",
          screenWidth: 100,
          screenHeight: 200,
        },
      } as unknown as ObserveResult;
      const { calls, restore } = captureTapOptions();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);

      try {
        await (explore as any).performInteraction(
          createMockElement({
            text: "Beta",
            "resource-id": rowId,
            bounds: { left: 0, top: 100, right: 100, bottom: 150 },
          }),
          observation,
        );
      } finally {
        restore();
      }

      // Visible matches in hierarchy order: Alpha, Beta@50, Beta@100 -> index 2
      // (a raw count over the hierarchy would say 3 and miss the row).
      expect(calls).toEqual([{ elementId: rowId, index: 2, action: "tap" }]);
    });

    test("prefers an exact qualified id over a bare Compose fallback", async () => {
      // The exact qualified match is unique even when a bare Compose id exists.
      const observation = createMockObservation([
        createMockViewHierarchyNode({ text: "Alpha", "resource-id": "com.test:id/row" }),
        createMockViewHierarchyNode({ text: "Beta", "resource-id": "row" }),
      ]);
      const { calls, restore } = captureTapOptions();
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);

      try {
        await (explore as any).performInteraction(
          createMockElement({ text: "Alpha", "resource-id": "com.test:id/row" }),
          observation,
        );
      } finally {
        restore();
      }

      expect(calls).toEqual([{ elementId: "com.test:id/row", action: "tap" }]);
    });
  });

  describe("performInteraction records the replayable tool call (#9989)", () => {
    type Perform = (element: Element, observation: ObserveResult) => Promise<boolean>;
    const rowId = "com.test:id/row_title";

    function perform(): Perform {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      return Reflect.get(explore, "performInteraction").bind(explore);
    }

    function recorded(index = 0): { toolName: string; args: unknown } {
      const [toolName, args] = fakeGraph.getMethodCallArgs("recordToolCall", index) ?? [];
      return { toolName, args };
    }

    async function historySize(): Promise<number> {
      return (await fakeGraph.getStats()).toolCallHistorySize;
    }

    test("a selector tap records tapOn with the public selector form, replayable through the tool schema", async () => {
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
      try {
        expect(
          await perform()(
            createMockElement({ text: "Settings", "resource-id": "com.test:id/settings_btn" }),
            createMockObservation(),
          ),
        ).toBe(true);
      } finally {
        tap.mockRestore();
      }

      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
      const { toolName, args } = recorded();
      expect(toolName).toBe("tapOn");
      expect(args).toEqual({ selector: { elementId: "com.test:id/settings_btn" }, action: "tap" });
      expect(tapOnSchema.safeParse(args).success).toBe(true);
      expect(await historySize()).toBe(1);
    });

    test("a dispatch the tap reports reaches the recorded call (#10196)", async () => {
      const dispatched: number[] = [];
      const record = spyOn(fakeGraph, "recordToolCall").mockImplementation(() =>
        Object.assign(() => {}, { markDispatched: () => dispatched.push(1) }),
      );
      const tap = spyOn(TapOnElement.prototype, "execute").mockImplementation(async () => {
        reportToolDispatched();
        return { success: true };
      });
      try {
        await perform()(
          createMockElement({ text: "Settings", "resource-id": "com.test:id/settings_btn" }),
          createMockObservation(),
        );
      } finally {
        tap.mockRestore();
        record.mockRestore();
      }

      expect(dispatched).toEqual([1]);
    });

    test("a repeated control records the occurrence index beside the selector", async () => {
      const row = (text: string, top: number) => ({
        $: { class: "android.widget.TextView", text, "resource-id": rowId, clickable: "true" },
        bounds: { left: 0, top, right: 100, bottom: top + 50 },
      });
      const observation = {
        viewHierarchy: {
          hierarchy: { node: [row("Beta", 0), row("Beta", 50)] },
          packageName: "com.test.app",
          screenWidth: 100,
          screenHeight: 200,
        },
      } as unknown as ObserveResult;
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
      try {
        await perform()(
          createMockElement({
            text: "Beta",
            "resource-id": rowId,
            bounds: { left: 0, top: 50, right: 100, bottom: 100 },
          }),
          observation,
        );
      } finally {
        tap.mockRestore();
      }

      const { toolName, args } = recorded();
      expect(toolName).toBe("tapOn");
      expect(args).toEqual({ selector: { elementId: rowId }, index: 1, action: "tap" });
      expect(tapOnSchema.safeParse(args).success).toBe(true);
    });

    test("the recorded call becomes the edge interaction navigateTo replays, not a Back press", async () => {
      const event = (destination: string) => ({
        destination,
        source: "TEST" as const,
        arguments: {},
        metadata: {},
        timestamp: 1,
        sequenceNumber: 0,
        applicationId: "com.test.app",
      });
      fakeGraph.recordNavigationEvent(event("Home"));
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
      try {
        await perform()(
          createMockElement({ text: "Settings", "resource-id": "com.test:id/settings_btn" }),
          createMockObservation(),
        );
      } finally {
        tap.mockRestore();
      }
      fakeGraph.recordNavigationEvent(event("Settings"));

      const [edge] = fakeGraph.getEdgesFrom("Home");
      expect(edge.interaction?.toolName).toBe("tapOn");
      expect(edge.interaction?.args).toEqual({
        selector: { elementId: "com.test:id/settings_btn" },
        action: "tap",
      });
    });

    test("a failed tap withdraws its record", async () => {
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({
        success: false,
        error: "not found",
      });
      try {
        expect(await perform()(createMockElement(), createMockObservation())).toBe(false);
      } finally {
        tap.mockRestore();
      }

      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
      expect(await historySize()).toBe(0);
    });

    test("a tap that throws withdraws its record and still reports failure", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const tap = spyOn(TapOnElement.prototype, "execute").mockRejectedValue(new Error("boom"));
      try {
        expect(await perform()(createMockElement(), createMockObservation())).toBe(false);
      } finally {
        tap.mockRestore();
        warn.mockRestore();
      }

      expect(await historySize()).toBe(0);
    });

    test("a coordinate-only tap records tapAt with absolute coordinates the tool schema accepts", async () => {
      const tap = spyOn(TapAtCoordinate.prototype, "execute").mockResolvedValue({ success: true });
      try {
        await perform()(
          createMockElement({ text: "", "resource-id": "", class: "" }),
          createMockObservation(),
        );
      } finally {
        tap.mockRestore();
      }

      const { toolName, args } = recorded();
      expect(toolName).toBe("tapAt");
      expect(args).toEqual({ x: 50, y: 25, action: "tap" });
      expect(tapAtSchema.safeParse(args).success).toBe(true);
      expect(await historySize()).toBe(1);
    });

    test("an element with no tap target records nothing", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await perform()(
          createMockElement({
            text: "",
            "resource-id": "",
            class: "",
            bounds: { left: 0, top: 0, right: 0, bottom: 0 },
          }),
          createMockObservation(),
        );
      } finally {
        warn.mockRestore();
      }

      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(0);
    });

    test("a scrollable container swipe records swipeOn with the container selector", async () => {
      const swipe = spyOn(SwipeOnElement.prototype, "execute").mockResolvedValue({
        success: true,
      } as never);
      try {
        expect(
          await perform()(
            createMockElement({ scrollable: true, "resource-id": "com.test:id/list" }),
            createMockObservation(),
          ),
        ).toBe(true);
      } finally {
        swipe.mockRestore();
      }

      const { toolName, args } = recorded();
      expect(toolName).toBe("swipeOn");
      expect(args).toEqual({
        container: { elementId: "com.test:id/list" },
        direction: "up",
        speed: "slow",
      });
      expect(swipeOnSchema.safeParse(args).success).toBe(true);
      expect(await historySize()).toBe(1);
    });

    describe("a gesture that caused no navigation", () => {
      const navigate = (destination: string) =>
        fakeGraph.recordNavigationEvent({
          destination,
          source: "TEST",
          arguments: {},
          metadata: {},
          timestamp: 1,
          sequenceNumber: 0,
          applicationId: "com.test.app",
        });

      async function swipeWithoutNavigation(): Promise<Explore> {
        navigate("Home");
        const swipe = spyOn(SwipeOnElement.prototype, "execute").mockResolvedValue({
          success: true,
        } as never);
        try {
          await perform()(
            createMockElement({ scrollable: true, "resource-id": "com.test:id/list" }),
            createMockObservation(),
          );
        } finally {
          swipe.mockRestore();
        }
        expect(await historySize()).toBe(1);
        return explore;
      }

      function unrecordedPress(destination: string) {
        return spyOn(PressButton.prototype, "press").mockImplementation(async () => {
          navigate(destination);
          return { success: true };
        });
      }

      test("the dead-end Back edge carries the Back itself, never the withdrawn swipe", async () => {
        const dead = await swipeWithoutNavigation();
        const press = unrecordedPress("Previous");
        try {
          await Reflect.get(dead, "handleDeadEnd").call(dead);
        } finally {
          press.mockRestore();
        }

        // Two records were made (swipe, then Back); the swipe's was withdrawn before the
        // Back was recorded, so the edge the Back created is stamped pressButton back.
        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(2);
        expect(
          fakeGraph
            .getEdgesFrom("Home")
            .map((edge) => [edge.interaction?.toolName, edge.interaction?.args]),
        ).toEqual([["pressButton", { button: "back" }]]);
        // Only the Back's own record is held (the fake does not consume on navigation).
        expect(await historySize()).toBe(1);
      });

      test("is not attributed to resetToHome navigation", async () => {
        const reset = await swipeWithoutNavigation();
        const press = unrecordedPress("Launcher");
        try {
          await Reflect.get(reset, "resetToHome").call(reset);
        } finally {
          press.mockRestore();
        }

        expect(fakeGraph.getEdgesFrom("Home").map((edge) => edge.interaction?.toolName)).toEqual(
          [],
        );
        expect(await historySize()).toBe(0);
      });

      test("is withdrawn when the next action is recorded", async () => {
        await swipeWithoutNavigation();
        const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
        try {
          const next: Perform = Reflect.get(explore, "performInteraction").bind(explore);
          await next(createMockElement({ text: "Settings" }), createMockObservation());
        } finally {
          tap.mockRestore();
        }

        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(2);
        expect(await historySize()).toBe(1);
        navigate("Settings");
        expect(fakeGraph.getEdgesFrom("Home").map((edge) => edge.interaction?.toolName)).toEqual([
          "tapOn",
        ]);
      });
    });

    test("a tap that navigates keeps its edge interaction after explore moves on", async () => {
      const navigate = (destination: string) =>
        fakeGraph.recordNavigationEvent({
          destination,
          source: "TEST",
          arguments: {},
          metadata: {},
          timestamp: 1,
          sequenceNumber: 0,
          applicationId: "com.test.app",
        });
      navigate("Home");
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({ success: true });
      const press = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      try {
        await perform()(
          createMockElement({ text: "Settings", "resource-id": "com.test:id/settings_btn" }),
          createMockObservation(),
        );
        navigate("Settings");
        await Reflect.get(explore, "handleDeadEnd").call(explore);
      } finally {
        tap.mockRestore();
        press.mockRestore();
      }

      const [edge] = fakeGraph.getEdgesFrom("Home");
      expect(edge.interaction?.toolName).toBe("tapOn");
      // The tap's record was withdrawn when the dead end began; only the Back's own
      // record is held (the fake does not consume records on navigation).
      expect(fakeGraph.getMethodCallArgs("recordToolCall", 1)?.[0]).toBe("pressButton");
      expect(await historySize()).toBe(1);
    });

    test("a failed swipe withdraws its record, and a selector-less container records nothing", async () => {
      const swipe = spyOn(SwipeOnElement.prototype, "execute").mockResolvedValue({
        success: false,
      } as never);
      try {
        const run = perform();
        expect(
          await run(
            createMockElement({ scrollable: true, "resource-id": "com.test:id/list" }),
            createMockObservation(),
          ),
        ).toBe(false);
        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
        expect(await historySize()).toBe(0);

        await run(
          createMockElement({ scrollable: true, text: "", "resource-id": "", class: "" }),
          createMockObservation(),
        );
        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
      } finally {
        swipe.mockRestore();
      }
    });
  });

  describe("dead-end Back and blocker taps are recorded as what they are (#9989 follow-up)", () => {
    const event = (destination: string) => ({
      destination,
      source: "TEST" as const,
      arguments: {},
      metadata: {},
      timestamp: 1,
      sequenceNumber: 0,
      applicationId: "com.test.app",
    });

    async function historySize(): Promise<number> {
      return (await fakeGraph.getStats()).toolCallHistorySize;
    }

    function backSeam(): (progress?: undefined, observation?: ObserveResult) => Promise<void> {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      return Reflect.get(explore, "handleDeadEnd").bind(explore);
    }

    test("the dead-end Back records pressButton back, and the edge it creates replays as that Back", async () => {
      const press = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      try {
        fakeGraph.recordNavigationEvent(event("Settings"));
        await backSeam()(undefined, createMockObservation());
        fakeGraph.recordNavigationEvent(event("Home"));
      } finally {
        press.mockRestore();
      }

      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
      const [toolName, args] = fakeGraph.getMethodCallArgs("recordToolCall", 0) ?? [];
      expect(toolName).toBe("pressButton");
      expect(args).toEqual({ button: "back" });
      expect(pressButtonSchema.safeParse(args).success).toBe(true);
      const [edge] = fakeGraph.getEdgesFrom("Settings");
      expect(edge.to).toBe("Home");
      expect(edge.interaction?.toolName).toBe("pressButton");
      expect(edge.interaction?.args).toEqual({ button: "back" });
    });

    test("a Back that fails withdraws its record", async () => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const press = spyOn(PressButton.prototype, "press").mockResolvedValue({
        success: false,
        error: "no keyevent",
      });
      try {
        await backSeam()();
      } finally {
        press.mockRestore();
        warn.mockRestore();
      }

      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(1);
      expect(await historySize()).toBe(0);
      expect(Reflect.get(explore, "stopReason")).toContain("no keyevent");
    });

    test("the iOS dead-end Back records pressButton back and withdraws it when the tool fails", async () => {
      const ios = { deviceId: "ios-1", platform: "ios", source: "local" } as BootedDevice;
      let succeed = true;
      ToolRegistry.register("pressButton", "pressButton", {}, async () =>
        succeed ? { success: true } : { success: false, error: "boom" },
      );
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        explore = new Explore(ios, mockAdb, fakeTimer, fakeGraph);
        const run = Reflect.get(explore, "handleDeadEnd").bind(explore) as () => Promise<void>;
        await run();
        expect(fakeGraph.getMethodCallArgs("recordToolCall", 0)).toEqual([
          "pressButton",
          { button: "back" },
          undefined,
        ]);
        expect(await historySize()).toBe(1);

        succeed = false;
        await run();
        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(2);
        // The first Back caused no navigation, so the next dead end withdraws it
        // (#9989 review); the failed second Back withdraws itself. Nothing is pending.
        expect(await historySize()).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });

    test("a root-screen dead end presses no Back and records nothing", async () => {
      fakeGraph.setCurrentScreenValue("Home");
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      Reflect.get(explore, "rootScreens").add("Home");
      const press = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
      try {
        await (Reflect.get(explore, "handleDeadEnd") as () => Promise<void>).call(explore);
      } finally {
        press.mockRestore();
      }

      expect(press).not.toHaveBeenCalled();
      expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(0);
    });

    // Decision: blocker handling is device/app state interference, not navigation
    // a later navigateTo should replay (a permission prompt is system UI the SDK
    // never reports; a rating prompt appears only sometimes). Recording the tap
    // would leave an unconsumed record that the next navigation event inside the
    // correlation window could be attributed to, so the handlers record nothing.
    const blockerDialogs = {
      permission: () =>
        createMockObservation([
          createMockViewHierarchyNode({
            text: "Allow",
            "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
          }),
          createMockViewHierarchyNode({
            class: "android.widget.TextView",
            text: "This app needs camera permission",
            clickable: "false",
          }),
        ]),
      rating: () =>
        createMockObservation([
          createMockViewHierarchyNode({
            text: "Not now",
            "resource-id": "com.test:id/rating_not_now",
          }),
          createMockViewHierarchyNode({
            class: "android.widget.TextView",
            text: "Rate this app",
            "resource-id": "com.test:id/rating_title",
            clickable: "false",
          }),
        ]),
    };

    for (const kind of ["permission", "rating"] as const) {
      test(`a ${kind} dialog dismissal records no tool call, so no later edge can be attributed to it`, async () => {
        const fakeTap = new FakeDialogTapAction();
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph, undefined, fakeTap.factory);
        const dialog = blockerDialogs[kind]();
        const normal = createMockObservation();
        let observeCount = 0;
        spyOn(explore.observeScreen, "execute").mockImplementation(async () =>
          ++observeCount === 1 ? dialog : normal,
        );
        Reflect.set(explore, "performInteraction", async () => true);

        await explore.execute({ maxInteractions: 1, timeoutMs: 5000, packageName: "com.test.app" });

        expect(fakeTap.calls).toHaveLength(1);
        expect(fakeGraph.getMethodCallCount("recordToolCall")).toBe(0);
        expect(await historySize()).toBe(0);
      });
    }

    describe("validate mode replays a recorded Back", () => {
      const completionReason = "All edges in navigation graph have been traversed";

      function addBackEdge(from: string, to: string): void {
        fakeGraph.addEdge({
          from,
          to,
          edgeType: "tool",
          timestamp: fakeTimer.now(),
          interaction: {
            toolName: "pressButton",
            args: { button: "back" },
            timestamp: fakeTimer.now(),
          },
        });
      }

      function setup(start: string, backLandsOn: string | null, success = true) {
        fakeGraph.setCurrentScreenValue(start);
        explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
        const observation = spyOn(explore.observeScreen, "execute").mockResolvedValue(
          createMockObservation(),
        );
        const tap = spyOn(TapOnElement.prototype, "execute").mockImplementation(async (args) => {
          fakeGraph.setCurrentScreenValue(
            args.elementId === "com.test:id/settings_btn" ? "B" : "C",
          );
          return { success: true, action: "tap", element: createMockElement() };
        });
        const back = spyOn(PressButton.prototype, "press").mockImplementation(async (button) => {
          if (success) {
            fakeGraph.setCurrentScreenValue(backLandsOn);
            return { success: true, button, keyCode: 4 };
          }
          return { success: false, button, error: "keyevent rejected" };
        });
        return {
          tap,
          back,
          restore: () => {
            observation.mockRestore();
            tap.mockRestore();
            back.mockRestore();
          },
        };
      }

      test("presses Back, records it, and validates the screen it lands on", async () => {
        addBackEdge("B", "A");
        const run = setup("B", "A");
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });

          expect(result.stopReason).toBe(completionReason);
          expect(result.graphTraversal?.edgesTraversed).toBe(1);
          expect(result.graphTraversal?.edgeValidationResults[0]).toMatchObject({
            success: true,
            actualTo: "A",
          });
          expect(result.graphTraversal?.edgeValidationResults[0]?.skipped).toBeUndefined();
          expect(run.back).toHaveBeenCalledTimes(1);
          expect(run.tap).not.toHaveBeenCalled();
          expect(fakeGraph.getMethodCallArgs("recordToolCall", 0)?.slice(0, 2)).toEqual([
            "pressButton",
            { button: "back" },
          ]);
          expect(fakeTimer.getSleepHistory()).toEqual([500]);
        } finally {
          run.restore();
        }
      });

      test("validates a tap edge and then the Back edge that returns from it", async () => {
        fakeGraph.addEdge({
          from: "A",
          to: "B",
          edgeType: "tool",
          timestamp: fakeTimer.now(),
          interaction: { toolName: "tapOn", args: { text: "Settings" }, timestamp: 0 },
        });
        addBackEdge("B", "A");
        const run = setup("A", "A");
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });

          expect(result.stopReason).toBe(completionReason);
          expect(result.graphTraversal?.edgesTraversed).toBe(2);
          expect(result.graphTraversal?.edgeValidationResults.every((edge) => edge.success)).toBe(
            true,
          );
          expect(run.tap).toHaveBeenCalledTimes(1);
          expect(run.back).toHaveBeenCalledTimes(1);
          expect(Reflect.get(explore, "consecutiveBackCount")).toBe(0);
        } finally {
          run.restore();
        }
      });

      test("reports divergence when Back lands on a different screen than the recorded one", async () => {
        addBackEdge("B", "A");
        const run = setup("B", "Elsewhere");
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });

          expect(result.stopReason).toContain('Expected to reach "A", but reached "Elsewhere"');
          expect(result.graphTraversal?.edgeValidationResults[0]).toMatchObject({
            success: false,
            actualTo: "Elsewhere",
          });
        } finally {
          run.restore();
        }
      });

      test("a Back that cannot be pressed fails the edge instead of skipping it", async () => {
        addBackEdge("B", "A");
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        const run = setup("B", null, false);
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });

          expect(result.stopReason).toContain("Back press failed for edge B->A");
          expect(result.graphTraversal?.edgeValidationResults[0]).toMatchObject({
            success: false,
            error: "Back press failed",
          });
          expect(result.graphTraversal?.edgeValidationResults[0]?.skipped).toBeUndefined();
        } finally {
          run.restore();
          warn.mockRestore();
        }
      });
    });
  });

  describe("periodic reset to home", () => {
    // resetToHome is gated on interactionCount, which only advances on a
    // successful interaction, so the gate must not re-fire while the count sits
    // on a multiple of resetInterval — including 0 (issue #6126).
    test("resets once per resetInterval successful interactions and never at count 0", async () => {
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      (explore as any).observeScreen = {
        execute: async () => createMockObservation(),
      };
      const outcomes = [false, true, true, false, true];
      const log: string[] = [];
      (explore as any).performInteraction = async () => {
        const success = outcomes.shift() ?? true;
        log.push(success ? "interaction:ok" : "interaction:fail");
        return success;
      };
      (explore as any).resetToHome = async () => {
        log.push("reset");
      };

      const result = await explore.execute({
        maxInteractions: 3,
        timeoutMs: 5000,
        packageName: "com.test.app",
        resetToHome: true,
        resetInterval: 2,
      });

      expect(result.interactionsPerformed).toBe(3);
      expect(log).toEqual([
        "interaction:fail",
        "interaction:ok",
        "interaction:ok",
        "reset",
        "interaction:fail",
        "interaction:ok",
      ]);
    });

    test("relaunches the target app after pressing home on Android", async () => {
      const commands: string[] = [];
      const adb = {
        execute: async (args: string[]) => {
          commands.push(args.join(" "));
          return "";
        },
        // Home-press verification (issue #6147) reads the foreground app via
        // `dumpsys window windows` after dispatch; report the launcher so the
        // ADB keyevent fallback is confirmed to have actually worked.
        executeCommand: async () => launcherDumpsysResult(),
      } as AdbClient;
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const signal = new AbortController().signal;
      // Capture the launch flags too: clearAppData/coldBoot must stay off, and
      // the exploration signal must reach the launch so cancellation is honored.
      const launchSpy = spyOn(LaunchApp.prototype, "execute").mockImplementation(
        async (...args: unknown[]) => {
          commands.push(`launch ${JSON.stringify(args.slice(0, 3))} signal=${args[6] === signal}`);
          return { success: true, packageName: args[0] } as never;
        },
      );
      explore = new Explore(device, adb, fakeTimer, fakeGraph);
      (explore as any).targetPackageName = "com.test.app";

      try {
        await (explore as any).resetToHome(undefined, signal);
      } finally {
        launchSpy.mockRestore();
        ctrlProxySpy.mockRestore();
      }

      expect(commands).toEqual([
        "shell input keyevent 3",
        'launch ["com.test.app",false,false] signal=true',
      ]);
      expect((explore as any).stopReason).toBe("");
    });

    test("forwards the exploration AbortSignal through PressButton into the ADB home dispatch (#6289)", async () => {
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      let dispatchSignal: AbortSignal | undefined;
      const adb = {
        execute: async (_args: string[], options: { signal?: AbortSignal } = {}) => {
          dispatchSignal = options.signal;
          return "";
        },
        // getActive + launcher resolution during home verification read through
        // this; report the launcher so verification passes.
        executeCommand: async () => launcherDumpsysResult(),
      } as unknown as AdbClient;
      const controller = new AbortController();
      explore = new Explore(device, adb, fakeTimer, fakeGraph);
      // No targetPackageName -> no relaunch; keep the test on the press dispatch.

      try {
        await (explore as any).resetToHome(undefined, controller.signal);
      } finally {
        ctrlProxySpy.mockRestore();
      }

      // Explore's signal (not merely a remaining timeout) reached the ADB
      // keyevent dispatch, so a cancelled exploration aborts the home press.
      expect(dispatchSignal).toBe(controller.signal);
      expect((explore as any).stopReason).toBe("");
    });

    test("records a failed relaunch as a terminal partial-report reason", async () => {
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const launchSpy = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({
        success: false,
        packageName: "com.test.app",
        error: "App is not installed",
      } as never);
      const adb = {
        execute: async () => "",
        // Verification (issue #6147) must pass so this test exercises the
        // relaunch failure path, not a home-press verification failure.
        executeCommand: async () => launcherDumpsysResult(),
      } as AdbClient;
      explore = new Explore(device, adb, fakeTimer, fakeGraph);
      (explore as any).targetPackageName = "com.test.app";

      try {
        await (explore as any).resetToHome();
      } finally {
        launchSpy.mockRestore();
        ctrlProxySpy.mockRestore();
      }

      expect((explore as any).stopReason).toBe("Home-screen recovery failed: App is not installed");
    });

    test("relaunches the target app through the internal launchApp tool on iOS", async () => {
      const iOSDevice = {
        deviceId: "ios-simulator-123",
        platform: "ios",
        source: "local",
      } as BootedDevice;
      const calls: Array<{ name: string; args: Record<string, unknown>; signal?: AbortSignal }> =
        [];
      ToolRegistry.register("homeScreen", "homeScreen", {}, async (args) => {
        calls.push({ name: "homeScreen", args });
        return { success: true };
      });
      ToolRegistry.register("launchApp", "launchApp", {}, async (args, _progress, signal) => {
        calls.push({ name: "launchApp", args, signal });
        return { success: true };
      });
      const signal = new AbortController().signal;
      explore = new Explore(iOSDevice, null, fakeTimer, fakeGraph, "session-1");
      (explore as any).targetPackageName = "com.test.app";

      await (explore as any).resetToHome(undefined, signal);

      expect(calls.map((call) => call.name)).toEqual(["homeScreen", "launchApp"]);
      expect(calls[1].args).toEqual({
        appId: "com.test.app",
        platform: "ios",
        deviceId: "ios-simulator-123",
        sessionUuid: "session-1",
        [INTERNAL_NO_DIFF_PARAM]: true,
      });
      expect(calls[1].signal).toBe(signal);
    });
  });

  // Exploration strategies and modes are tested through unit tests
  // Full device integration tests are in JUnitRunner and XCTestRunner

  // Safety features are tested through unit tests
  // Full device integration tests are in JUnitRunner and XCTestRunner

  describe("foreground app enforcement", () => {
    for (const explicitPackage of [false, true]) {
      test(
        explicitPackage
          ? "should relaunch the provided package when navigation leaves app"
          : "should default to initial foreground package when packageName is not provided",
        async () => {
          const launch = spyOn(LaunchApp.prototype, "execute").mockResolvedValue({ success: true });
          const back = spyOn(PressButton.prototype, "press").mockResolvedValue({ success: true });
          explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
          const seams = explore as unknown as { performInteraction: () => Promise<boolean> };
          seams.performInteraction = async () => true;
          let observeCount = 0;
          explore.observeScreen = {
            execute: async () => {
              observeCount++;
              return createMockObservation(
                [],
                !explicitPackage && observeCount === 1 ? "com.test.app" : "com.android.settings",
              );
            },
          } as typeof explore.observeScreen;
          try {
            const result = await explore.execute({
              maxInteractions: 50,
              timeoutMs: 5000,
              ...(explicitPackage ? { packageName: "com.test.app" } : {}),
            });
            expect(result.stopReason).toContain("com.test.app");
            expect(launch).toHaveBeenCalledTimes(5);
            expect(launch.mock.calls.every(([packageName]) => packageName === "com.test.app")).toBe(
              true,
            );
            expect(back).not.toHaveBeenCalled();
          } finally {
            launch.mockRestore();
            back.mockRestore();
          }
        },
      );
    }
  });

  describe("platform-aware recovery", () => {
    for (const platform of ["android", "ios"] as const) {
      for (const recovery of ["back", "home"] as const) {
        test(`${platform} ${recovery} recovery flushes pending pixels before dispatch`, async () => {
          const order: string[] = [];
          let screen = "action";
          const dispatch = async () => {
            order.push(`dispatch-${recovery}`);
            screen = "recovery";
            return { success: true };
          };
          const press = spyOn(PressButton.prototype, "press").mockImplementation(dispatch);
          ToolRegistry.register(
            recovery === "back" ? "pressButton" : "homeScreen",
            "recovery",
            {},
            dispatch,
          );
          const action = createMockObservation();
          action.deviceId = device.deviceId;
          action.observationId = "before-recovery";
          explore = new Explore({ ...device, platform }, mockAdb, fakeTimer, fakeGraph);
          const seams = explore as unknown as {
            handleDeadEnd(): Promise<void>;
            resetToHome(): Promise<void>;
          };
          try {
            await runWithPostActionCaptureScope(undefined, async () => {
              deferTerminalScreenshot(action, async () => {
                order.push(`capture-${screen}`);
              });
              if (recovery === "back") {
                await seams.handleDeadEnd();
              } else {
                await seams.resetToHome();
              }
              expect(order).toEqual(["capture-action", `dispatch-${recovery}`]);
              expect(hasPendingTerminalScreenshot(action)).toBe(false);
            });
            expect(order).toHaveLength(2);
          } finally {
            press.mockRestore();
          }
        });
      }
    }

    test("routes iOS dead-end and home recovery through internal interaction tools without ADB", async () => {
      const iOSDevice = {
        deviceId: "ios-simulator-123",
        platform: "ios",
        source: "local",
      } as BootedDevice;
      const adbCommands: string[] = [];
      const adb = {
        executeCommand: async (command: string) => {
          adbCommands.push(command);
          return "";
        },
      } as AdbClient;
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

      ToolRegistry.register("pressButton", "pressButton", {}, async (args) => {
        calls.push({ name: "pressButton", args });
        return { success: true };
      });
      ToolRegistry.register("homeScreen", "homeScreen", {}, async (args) => {
        calls.push({ name: "homeScreen", args });
        return { success: true };
      });

      explore = new Explore(iOSDevice, adb, fakeTimer, fakeGraph);
      await (explore as any).handleDeadEnd();
      await (explore as any).resetToHome();

      expect(calls).toEqual([
        {
          name: "pressButton",
          args: {
            button: "back",
            platform: "ios",
            deviceId: "ios-simulator-123",
            [INTERNAL_NO_DIFF_PARAM]: true,
          },
        },
        {
          name: "homeScreen",
          args: { platform: "ios", deviceId: "ios-simulator-123", [INTERNAL_NO_DIFF_PARAM]: true },
        },
      ]);
      expect(adbCommands).toEqual([]);
    });

    test("targets the selected iOS device when another iOS simulator is booted", async () => {
      const iosA = {
        deviceId: "ios-simulator-a",
        name: "iPhone A",
        platform: "ios",
      } as BootedDevice;
      const iosB = {
        deviceId: "ios-simulator-b",
        name: "iPhone B",
        platform: "ios",
      } as BootedDevice;
      const sessions = new FakeDeviceSessionManager();
      sessions.setConnectedDevices([iosA, iosB]);
      const registry = ToolRegistry as unknown as { deviceSessionManager: unknown };
      const originalDeviceSessionManager = registry.deviceSessionManager;
      registry.deviceSessionManager = sessions;
      const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
        displayInventory: new FakeDisplayInventoryProvider(),
      });
      const selectedDeviceIds: string[] = [];

      try {
        ToolRegistry.registerDeviceAware(
          "pressButton",
          "pressButton",
          { parse: (args: unknown) => args } as any,
          async (selectedDevice) => {
            selectedDeviceIds.push(selectedDevice.deviceId);
            return { success: true };
          },
        );
        explore = new Explore(iosB, null, fakeTimer, fakeGraph);

        await (explore as any).handleDeadEnd();

        expect(selectedDeviceIds).toEqual([iosB.deviceId]);
      } finally {
        restorePipelineOverrides();
        registry.deviceSessionManager = originalDeviceSessionManager;
      }
    });

    test("uses injected Android recovery dependencies without nested progress", async () => {
      const commands: string[] = [];
      const adb = {
        execute: async (args: string[]) => {
          commands.push(args.join(" "));
          return "";
        },
      } as AdbClient;
      const progressUpdates: Array<{ current: number; total?: number; message?: string }> = [];
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      ToolRegistry.register("pressButton", "pressButton", {}, async () => {
        throw new Error("Android recovery must not use the global tool registry");
      });
      ToolRegistry.register("homeScreen", "homeScreen", {}, async () => {
        throw new Error("Android recovery must not use the global tool registry");
      });
      explore = new Explore(device, adb, fakeTimer, fakeGraph);

      try {
        await (explore as any).handleDeadEnd(
          async (current: number, total?: number, message?: string) => {
            progressUpdates.push({ current, total, message });
          },
        );
        await (explore as any).resetToHome(
          async (current: number, total?: number, message?: string) => {
            progressUpdates.push({ current, total, message });
          },
        );
      } finally {
        ctrlProxySpy.mockRestore();
      }

      expect(commands).toEqual(["shell input keyevent 4", "shell input keyevent 3"]);
      expect(progressUpdates).toEqual([
        { current: 0, total: 1, message: "Dead end detected, navigating back..." },
        { current: 0, total: 1, message: "Resetting to home screen..." },
      ]);
    });

    test("records failed dead-end recovery as a terminal partial-report reason", async () => {
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const adb = {
        execute: async () => {
          throw new Error("Back navigation was rejected");
        },
      } as AdbClient;
      explore = new Explore(device, adb, fakeTimer, fakeGraph);

      try {
        await (explore as any).handleDeadEnd();
      } finally {
        ctrlProxySpy.mockRestore();
      }

      expect((explore as any).stopReason).toBe(
        "Back-navigation recovery failed: Failed to press button: Back navigation was rejected",
      );
    });

    test("records failed home reset as a terminal partial-report reason", async () => {
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const adb = {
        execute: async () => {
          throw new Error("Home navigation was rejected");
        },
      } as AdbClient;
      explore = new Explore(device, adb, fakeTimer, fakeGraph);

      try {
        await (explore as any).resetToHome();
      } finally {
        ctrlProxySpy.mockRestore();
      }

      expect((explore as any).stopReason).toBe(
        "Home-screen recovery failed: Failed to press button: Home navigation was rejected",
      );
    });

    test("returns a partial report when dead-end recovery fails", async () => {
      const ctrlProxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue({
        requestGlobalAction: async () => ({ success: false, error: "unavailable" }),
      } as never);
      const adb = {
        execute: async () => {
          throw new Error("Back navigation was rejected");
        },
      } as AdbClient;
      explore = new Explore(device, adb, fakeTimer, fakeGraph);
      (explore as any).observeScreen = {
        execute: async () => createMockObservation([], "com.test.app"),
      };
      (explore as any).selectNextElement = async () => undefined;

      let result;
      try {
        result = await explore.execute({
          maxInteractions: 1,
          timeoutMs: 5000,
          packageName: "com.test.app",
        });
      } finally {
        ctrlProxySpy.mockRestore();
      }

      expect(result.success).toBe(true);
      expect(result.stopReason).toBe(
        "Back-navigation recovery failed: Failed to press button: Back navigation was rejected",
      );
    });
  });

  describe("element tracking", () => {
    test("should generate unique element keys", async () => {
      const element1 = createMockElement({
        text: "Button",
        "resource-id": "com.test:id/btn",
      });

      const element2 = createMockElement({
        text: "Button",
        "resource-id": "com.test:id/btn",
      });

      const element3 = createMockElement({
        text: "Other",
        "resource-id": "com.test:id/other",
      });

      const key1 = getElementKey(element1);
      const key2 = getElementKey(element2);
      const key3 = getElementKey(element3);

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  describe("graph-based navigation (validate mode)", () => {
    const completionReason = "All edges in navigation graph have been traversed";

    function addValidateEdge(from: string, to: string, text: string): void {
      fakeGraph.addEdge({
        from,
        to,
        edgeType: "tool",
        timestamp: fakeTimer.now(),
        interaction: { toolName: "tapOn", args: { text }, timestamp: fakeTimer.now() },
        // Pre-action state (the active tab); validate must target the interaction, not this.
        uiState: { selectedElements: [{ text: "Home tab" }] },
      });
    }

    function setupValidateRun(options: { returnToA?: boolean; emptyLeaf?: boolean } = {}) {
      fakeGraph.setCurrentScreenValue("A");
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      const backStopReasons: unknown[] = [];
      const observation = spyOn(explore.observeScreen, "execute").mockImplementation(async () => {
        if (options.emptyLeaf && fakeGraph.getCurrentScreen() !== "A") {
          return { viewHierarchy: { hierarchy: { node: [] }, packageName: "com.test.app" } };
        }
        return createMockObservation();
      });
      const tap = spyOn(TapOnElement.prototype, "execute").mockImplementation(async (args) => {
        fakeGraph.setCurrentScreenValue(args.elementId === "com.test:id/profile_btn" ? "C" : "B");
        return { success: true, action: "tap", element: createMockElement() };
      });
      const back = spyOn(PressButton.prototype, "press").mockImplementation(async (button) => {
        expect(button).toBe("back");
        backStopReasons.push(Reflect.get(explore, "stopReason"));
        if (options.returnToA) {
          fakeGraph.setCurrentScreenValue("A");
        }
        return { success: true, button, keyCode: 4 };
      });
      return {
        backStopReasons,
        restore: () => {
          observation.mockRestore();
          tap.mockRestore();
          back.mockRestore();
        },
      };
    }

    for (const emptyLeaf of [false, true]) {
      test(`validate regression: recovers from ${emptyLeaf ? "empty" : "interactive"} leaf to validate both branches`, async () => {
        addValidateEdge("A", "B", "Settings");
        addValidateEdge("A", "C", "Profile");
        const run = setupValidateRun({ returnToA: true, emptyLeaf });
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
          expect(result.graphTraversal?.edgesTraversed).toBe(2);
          expect(result.graphTraversal?.totalEdges).toBe(2);
          expect(result.stopReason).toBe(completionReason);
          expect(result.graphTraversal?.edgeValidationResults.every((edge) => edge.success)).toBe(
            true,
          );
          expect(run.backStopReasons).toEqual([""]);
          expect(fakeGraph.getCurrentScreen()).toBe("C");
          expect(fakeTimer.getSleepHistory()).toEqual([500, 1000, 500]);
        } finally {
          run.restore();
        }
      });
    }

    test("validate regression: reports unreachable pending sources at the existing back limit", async () => {
      addValidateEdge("A", "B", "Settings");
      addValidateEdge("X", "Y", "Profile");
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toContain("Too many consecutive back navigations (5)");
        expect(result.stopReason).toContain("Validated 1 of 2 edges");
        expect(result.stopReason).toContain("1 remain pending");
        expect(result.stopReason).toContain("X->Y");
        expect(result.stopReason).not.toContain(completionReason);
        expect(result.graphTraversal?.edgesTraversed).toBe(1);
        expect(run.backStopReasons).toEqual(["", "", "", "", ""]);
        expect(fakeTimer.getSleepHistory()).toEqual([500, 1000, 1000, 1000, 1000, 1000]);
      } finally {
        run.restore();
      }
    });

    for (const emptyLeaf of [false, true]) {
      test(`validate regression: single edge completes on ${emptyLeaf ? "empty" : "interactive"} leaf without Back`, async () => {
        addValidateEdge("A", "B", "Settings");
        const run = setupValidateRun({ emptyLeaf });
        try {
          const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
          expect(result.graphTraversal?.edgesTraversed).toBe(1);
          expect(result.graphTraversal?.totalEdges).toBe(1);
          expect(result.stopReason).toBe(completionReason);
          expect(run.backStopReasons).toEqual([]);
          expect(fakeTimer.getSleepHistory()).toEqual([500]);
        } finally {
          run.restore();
        }
      });
    }

    test("validate regression: missing element stops without Back and preserves pending summary", async () => {
      addValidateEdge("A", "B", "Missing button");
      addValidateEdge("X", "Y", "Profile");
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toContain("Cannot find element matching edge A->B");
        expect(result.stopReason).toContain("Validated 0 of 2 edges");
        expect(result.stopReason).toContain("1 failed validation");
        expect(result.stopReason).toContain("1 remain pending");
        expect(result.stopReason).toContain("X->Y");
        expect(result.graphTraversal?.edgeValidationResults[0]?.success).toBe(false);
        expect(run.backStopReasons).toEqual([]);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      } finally {
        run.restore();
      }
    });

    function addUnrecordedEdge(from: string, to: string): void {
      fakeGraph.addEdge({
        from,
        to,
        edgeType: "unknown",
        timestamp: fakeTimer.now(),
        uiState: { selectedElements: [{ text: "Settings" }] },
      });
    }

    test("validate regression: an edge with no recorded interaction is skipped, not reported as divergence", async () => {
      addUnrecordedEdge("A", "B");
      addValidateEdge("A", "C", "Profile");
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toBe(completionReason);
        expect(result.stopReason).not.toContain("diverged");
        expect(result.graphTraversal?.edgesTraversed).toBe(1);
        const results = result.graphTraversal?.edgeValidationResults ?? [];
        expect(results.find((edge) => edge.skipped)?.expectedTo).toBe("B");
        expect(results.find((edge) => edge.skipped)?.error).toContain(
          "no interaction was recorded",
        );
        expect(results.find((edge) => !edge.skipped)?.success).toBe(true);
        expect(fakeGraph.getCurrentScreen()).toBe("C");
      } finally {
        run.restore();
      }
    });

    test("validate regression: a graph of only unrecorded edges completes without tapping or Back", async () => {
      addUnrecordedEdge("A", "B");
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toBe(completionReason);
        expect(result.graphTraversal?.edgesTraversed).toBe(0);
        expect(result.graphTraversal?.edgeValidationResults[0]?.skipped).toBe(true);
        expect(result.graphTraversal?.edgeValidationResults[0]?.success).toBe(false);
        expect(run.backStopReasons).toEqual([]);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      } finally {
        run.restore();
      }
    });

    test("validate regression: a skipped edge does not mask a real divergence in the summary", async () => {
      addUnrecordedEdge("A", "B");
      addValidateEdge("A", "C", "Missing button");
      addValidateEdge("X", "Y", "Profile");
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toContain("Cannot find element matching edge A->C");
        expect(result.stopReason).toContain("1 failed validation");
        expect(result.stopReason).toContain("1 skipped (not replayable)");
        expect(result.stopReason).toContain("1 remain pending");
      } finally {
        run.restore();
      }
    });

    test("validate regression: screen with no candidates stops on element divergence without Back", async () => {
      addValidateEdge("A", "B", "Settings");
      const run = setupValidateRun();
      const observation = spyOn(explore.observeScreen, "execute").mockResolvedValue({
        viewHierarchy: { hierarchy: { node: [] }, packageName: "com.test.app" },
      });
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toContain("Cannot find element matching edge A->B");
        expect(result.graphTraversal?.edgeValidationResults[0]?.success).toBe(false);
        expect(run.backStopReasons).toEqual([]);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      } finally {
        observation.mockRestore();
        run.restore();
      }
    });

    test("validate regression: single-screen graph completes without Back", async () => {
      addValidateEdge("A", "A", "Settings");
      const run = setupValidateRun();
      const tap = spyOn(TapOnElement.prototype, "execute").mockResolvedValue({
        success: true,
        action: "tap",
        element: createMockElement(),
      });
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.stopReason).toBe(completionReason);
        expect(result.graphTraversal?.edgesTraversed).toBe(1);
        expect(result.graphTraversal?.totalEdges).toBe(1);
        expect(run.backStopReasons).toEqual([]);
        expect(fakeTimer.getSleepHistory()).toEqual([500]);
      } finally {
        tap.mockRestore();
        run.restore();
      }
    });

    for (const budget of [{ maxInteractions: 1 }, { timeoutMs: 500 }]) {
      test(`validate regression: preserves ${"maxInteractions" in budget ? "interaction" : "time"} budget and reports remaining edges`, async () => {
        addValidateEdge("A", "B", "Settings");
        addValidateEdge("A", "C", "Profile");
        const run = setupValidateRun({ returnToA: true });
        try {
          const result = await explore.execute({
            mode: "validate",
            maxInteractions: 10,
            ...budget,
          });
          expect(result.stopReason).toContain("Reached");
          expect(result.stopReason).toContain("Validated 1 of 2 edges");
          expect(result.stopReason).toContain("1 remain pending");
          expect(result.stopReason).toContain("A->C");
          expect(run.backStopReasons).toEqual([]);
          expect(fakeTimer.getSleepHistory()).toEqual([500]);
        } finally {
          run.restore();
        }
      });
    }

    test("validate regression: empty graph completes without Back", async () => {
      const run = setupValidateRun();
      try {
        const result = await explore.execute({ mode: "validate", maxInteractions: 10 });
        expect(result.graphTraversal?.edgesTraversed).toBe(0);
        expect(result.graphTraversal?.totalEdges).toBe(0);
        expect(result.stopReason).toBe(completionReason);
        expect(run.backStopReasons).toEqual([]);
        expect(fakeTimer.getSleepHistory()).toEqual([]);
      } finally {
        run.restore();
      }
    });

    test("should initialize graph traversal state in validate mode", async () => {
      // Pre-populate the graph with some nodes and edges
      fakeGraph.recordNavigationEvent({
        destination: "Screen1",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 1,
        applicationId: "com.test.app",
      });

      fakeGraph.recordToolCall(
        "tapOn",
        { text: "Button1" },
        {
          selectedElements: [{ text: "Button1", resourceId: "btn1", contentDesc: "" }],
        },
      );

      fakeGraph.recordNavigationEvent({
        destination: "Screen2",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 2,
        applicationId: "com.test.app",
      });

      // Initialize traversal using the extracted function with fakeGraph
      const state = await initializeGraphTraversal(fakeGraph);

      expect(state).toBeDefined();
      expect(state.totalNodesInGraph).toBeGreaterThan(0);
      expect(state.totalEdgesInGraph).toBeGreaterThan(0);
      expect(state.visitedNodes.size).toBe(0);
      expect(state.traversedEdges.size).toBe(0);
    });

    test("should select next edge to traverse", async () => {
      const state = await initializeGraphTraversal(fakeGraph);

      // If there are any pending edges, selectNextEdgeToTraverse should return one
      if (state.pendingEdges.size > 0) {
        const firstEdge = state.pendingEdges.values().next().value!;
        const edge = selectNextEdgeToTraverse(state, firstEdge.from);
        expect(edge).toBeDefined();
        expect(edge).toBe(firstEdge);
      }

      // If there are no edges from current screen, it should return null
      const edge = selectNextEdgeToTraverse(state, "NonExistentScreen");
      expect(edge).toBeNull();
    });

    test("should mark nodes as visited", async () => {
      const state = await initializeGraphTraversal(fakeGraph);

      expect(state.visitedNodes.size).toBe(0);

      markNodeVisited(state, "Screen1");
      expect(state.visitedNodes.size).toBe(1);
      expect(state.visitedNodes.has("Screen1")).toBe(true);

      markNodeVisited(state, "Screen2");
      expect(state.visitedNodes.size).toBe(2);
    });

    test("should mark edges as traversed with validation results", async () => {
      const state = await initializeGraphTraversal(fakeGraph);

      expect(state.traversedEdges.size).toBe(0);

      // Create a mock edge with interaction
      const mockEdge = {
        from: "Screen1",
        to: "Screen2",
        timestamp: Date.now(),
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Submit Button" },
          timestamp: Date.now(),
        },
      };

      markEdgeTraversed(state, mockEdge, "Screen2", true, fakeTimer, undefined, 0.95);

      expect(state.traversedEdges.size).toBe(1);

      // Get the actual edge key generated
      const edgeKey = getEdgeKey(mockEdge);
      expect(state.traversedEdges.has(edgeKey)).toBe(true);

      const validation = state.edgeValidationResults.get(edgeKey);
      expect(validation).toBeDefined();
      expect(validation?.success).toBe(true);
      expect(validation?.expectedTo).toBe("Screen2");
      expect(validation?.actualTo).toBe("Screen2");
      expect(validation?.matchConfidence).toBe(0.95);
    });

    test("should record failed edge validation", async () => {
      const state = await initializeGraphTraversal(fakeGraph);

      // Create a mock edge with interaction
      const mockEdge = {
        from: "Screen1",
        to: "Screen2",
        timestamp: Date.now(),
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Navigate Button" },
          timestamp: Date.now(),
        },
      };

      markEdgeTraversed(state, mockEdge, "Screen3", false, fakeTimer, "Navigation diverged", 0.8);

      const edgeKey = getEdgeKey(mockEdge);
      const validation = state.edgeValidationResults.get(edgeKey);
      expect(validation?.success).toBe(false);
      expect(validation?.expectedTo).toBe("Screen2");
      expect(validation?.actualTo).toBe("Screen3");
      expect(validation?.error).toBe("Navigation diverged");
    });

    test("should generate edge keys correctly", async () => {
      // Create edges with same interaction
      const edge1 = {
        from: "Screen1",
        to: "Screen2",
        timestamp: 1000,
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Button A" },
          timestamp: 1000,
        },
      };

      const edge2 = {
        from: "Screen1",
        to: "Screen2",
        timestamp: 2000, // Different timestamp
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Button A" }, // Same interaction
          timestamp: 2000,
        },
      };

      const edge3 = {
        from: "Screen1",
        to: "Screen2",
        timestamp: 1000,
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Button B" }, // Different interaction
          timestamp: 1000,
        },
      };

      const edge4 = {
        from: "Screen2",
        to: "Screen1",
        timestamp: 1000,
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Button A" },
          timestamp: 1000,
        },
      };

      const key1 = getEdgeKey(edge1);
      const key2 = getEdgeKey(edge2);
      const key3 = getEdgeKey(edge3);
      const key4 = getEdgeKey(edge4);

      // Same interaction = same key (deterministic)
      expect(key1).toBe(key2);
      // Different interaction = different key
      expect(key1).not.toBe(key3);
      // Different screens = different key
      expect(key1).not.toBe(key4);

      // Verify format: from->hash->to
      expect(key1).toMatch(/^Screen1->[a-f0-9]{8}->Screen2$/);
    });

    test("reports complete traversal coverage when every graph node and edge is visited", async () => {
      const mockEdge = {
        from: "Screen1",
        to: "Screen2",
        timestamp: fakeTimer.now(),
        edgeType: "tool" as const,
        interaction: {
          toolName: "tapOn",
          args: { text: "Test Button" },
          timestamp: fakeTimer.now(),
        },
      };
      fakeGraph.addNode({
        screenName: "Screen1",
        firstSeenAt: fakeTimer.now(),
        lastSeenAt: fakeTimer.now(),
        visitCount: 1,
      });
      fakeGraph.addNode({
        screenName: "Screen2",
        firstSeenAt: fakeTimer.now(),
        lastSeenAt: fakeTimer.now(),
        visitCount: 1,
      });
      fakeGraph.addEdge(mockEdge);

      // Inject fakeGraph via constructor
      explore = new Explore(device, mockAdb, fakeTimer, fakeGraph);
      explore.observeScreen = mockObserveScreen;

      // Initialize traversal state on explore instance
      explore.graphTraversalState = await initializeGraphTraversal(fakeGraph);
      const state = explore.graphTraversalState;

      // Validate the edge stored in the graph, as validate mode does.
      markEdgeTraversed(state, mockEdge, "Screen2", true, fakeTimer);
      markNodeVisited(state, "Screen1");
      markNodeVisited(state, "Screen2");

      const initialGraph = await fakeGraph.exportGraph();
      const result = await (explore as any).generateReport(initialGraph, Date.now(), false);

      expect(result.graphTraversal).toBeDefined();
      expect(result.graphTraversal?.nodesVisited).toBe(2);
      expect(result.graphTraversal?.totalNodes).toBe(2);
      expect(result.graphTraversal?.edgesTraversed).toBe(1);
      expect(result.graphTraversal?.totalEdges).toBe(1);
      expect(result.graphTraversal?.edgeValidationResults).toBeDefined();
      expect(result.graphTraversal?.edgeValidationResults.length).toBeGreaterThan(0);
      expect(result.graphTraversal?.coveragePercentage).toBe(100);
    });
  });
});
