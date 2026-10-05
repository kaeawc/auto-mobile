import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { describe, expect, spyOn, test } from "bun:test";
import { supplementAndroidHierarchy } from "../../../src/features/action/AndroidHierarchyFallback";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { logger } from "../../../src/utils/logger";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

const path = "/data/local/tmp/automobile-hierarchy-test.xml";
const xml = (body: string) => `<?xml version="1.0"?><hierarchy rotation="0">${body}</hierarchy>`;
const node = (text: string, bounds = "[0,0][100,100]", id = "com.test:id/row") =>
  `<node package="com.test" class="android.widget.Button" resource-id="${id}" text="${text}" bounds="${bounds}" clickable="true"/>`;
class ControlledCleanupAdb extends FakeAdbClient {
  readonly cleanup = Promise.withResolvers<void>();
  cleanupStarted = false;
  cleanupCompleted = false;

  constructor(private readonly onDump: () => void = () => {}) {
    super();
  }

  override async execute(args: string[], options?: AdbExecuteOptions) {
    const result = await super.execute(args, options);
    if (args.join(" ") === `shell uiautomator dump ${path}`) {
      this.onDump();
    }
    if (args.join(" ") === `shell rm -f ${path}`) {
      this.cleanupStarted = true;
      await this.cleanup.promise;
      this.cleanupCompleted = true;
    }
    return result;
  }
}

function fixture(
  contents = xml(node("Missing")),
  adb = new FakeAdbClient(),
  timer = new FakeTimer(),
) {
  adb.setForegroundApp({ packageName: "com.test", userId: 0 });
  adb.setCommandResult(`shell cat ${path}`, contents);
  const original: ViewHierarchyResult = {
    hierarchy: {
      node: {
        $: { package: "com.android.systemui", class: "Bar", "view-id": "native" },
        bounds: { left: 0, top: 0, right: 100, bottom: 10 },
      },
    },
    packageName: "com.test",
    ctrlProxyIncomplete: true,
    fresh: true,
    frameContext: "native-frame",
    receivedAt: 10,
  };
  const run = (signal?: AbortSignal) =>
    supplementAndroidHierarchy(
      original,
      { adb, timer, idGenerator: new FakeIdGenerator(["test"]) },
      1000,
      signal,
    );
  return { adb, timer, original, run };
}
describe("Android hierarchy fallback", () => {
  test.each(["null_root", "discarded_windows", "extraction_error", undefined] as const)(
    "logs the incomplete reason when the dump is taken: %s",
    async (reason) => {
      const { run, original, adb } = fixture();
      original.ctrlProxyIncompleteReason = reason;
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await run();
        expect(adb.wasCommandExecuted(`shell uiautomator dump ${path}`)).toBe(true);
        expect(warn).toHaveBeenCalledWith(
          `[HierarchyFallback] Supplementing incomplete CtrlProxy hierarchy (ctrlProxyIncompleteReason=${reason ?? "unknown"})`,
        );
      } finally {
        warn.mockRestore();
      }
    },
  );
  test("adds missing app content without native IDs or false frame verification", async () => {
    const { run, original, adb } = fixture();
    const result = await run();
    const elements = new DefaultElementParser().flattenViewHierarchy(result).map((x) => x.element);
    expect(elements.find((x) => x.text === "Missing")).toMatchObject({
      "resource-id": "com.test:id/row",
      "hierarchy-source": "uiautomator",
    });
    expect(elements.find((x) => x.text === "Missing")?.["view-id"]).toBeUndefined();
    expect(elements.find((x) => x.class === "Bar")?.["view-id"]).toBe("native");
    expect(result.frameContext).toBeUndefined();
    expect(result.fresh).toBe(false);
    expect(result.ctrlProxyIncomplete).toBe(true);
    expect(result.sources).toEqual(["control-proxy", "uiautomator"]);
    expect(original.frameContext).toBe("native-frame");
    expect(adb.wasCommandExecuted(`shell rm -f ${path}`)).toBe(true);
    const cleanup = adb.getLastCommandCall();
    expect(cleanup?.timeoutMs).toBeGreaterThanOrEqual(1000);
    expect(cleanup?.noRetry).toBe(true);
  });
  test("returns immediately when the dump consumes the deadline, with cleanup still pending", async () => {
    const timer = new FakeTimer();
    const adb = new ControlledCleanupAdb(() => timer.advanceTime(1000));
    const { run, original } = fixture(undefined, adb, timer);
    let returned = false;
    const result = run().then((value) => {
      returned = true;
      return value;
    });
    try {
      await drainUntil(() => returned, { description: "deadline-exhausted result" });
      expect(await result).toBe(original);
      expect(timer.now()).toBe(1000);
      expect(adb.cleanupStarted).toBe(true);
      expect(adb.cleanupCompleted).toBe(false);
      expect(adb.wasCommandExecuted(`shell cat ${path}`)).toBe(false);
      expect(adb.getLastCommandCall()?.timeoutMs).toBe(1500);
      expect(adb.getLastCommandCall()?.noRetry).toBe(true);
    } finally {
      adb.cleanup.resolve();
      await result;
    }
  });
  test("cleanup failure preserves the supplemented result", async () => {
    const { run, adb } = fixture();
    adb.setCommandError(`shell rm -f ${path}`, new Error("cleanup denied"));
    const result = await run();
    expect(result.sources).toEqual(["control-proxy", "uiautomator"]);
    expect(
      new DefaultElementParser()
        .flattenViewHierarchy(result)
        .some((x) => x.element.text === "Missing"),
    ).toBe(true);
    expect(adb.wasCommandExecuted(`shell rm -f ${path}`)).toBe(true);
  });
  test("rejects cancellation during a dump before cleanup resolves", async () => {
    const controller = new AbortController();
    const adb = new ControlledCleanupAdb(() => controller.abort());
    const { run, timer } = fixture(undefined, adb);
    let rejected = false;
    const result = run(controller.signal).catch((error: unknown) => {
      rejected = true;
      return error;
    });
    try {
      await drainUntil(() => rejected, { description: "dump cancellation" });
      expect(await result).toMatchObject({ message: "Operation cancelled" });
      expect(adb.cleanupStarted).toBe(true);
      expect(adb.cleanupCompleted).toBe(false);
      expect(timer.now()).toBe(0);
      expect(adb.wasCommandExecuted(`shell cat ${path}`)).toBe(false);
      const cleanup = adb.getLastCommandCall();
      expect(cleanup?.signal).toBeDefined();
      expect(cleanup?.signal?.aborted).toBe(false);
      expect(cleanup?.signal).not.toBe(controller.signal);
      expect(cleanup?.noRetry).toBe(true);
      expect(cleanup?.timeoutMs).toBe(1500);
    } finally {
      adb.cleanup.resolve();
      await result;
    }
  });
  test("awaits in-budget cleanup before returning", async () => {
    const adb = new ControlledCleanupAdb();
    const { run, timer } = fixture(undefined, adb);
    let returned = false;
    const result = run().then((value) => {
      returned = true;
      return value;
    });
    try {
      await drainUntil(() => adb.cleanupStarted, { description: "cleanup dispatch" });
      await drainMicrotasks(30);
      expect(returned).toBe(false);
      expect(adb.cleanupCompleted).toBe(false);
      adb.cleanup.resolve();
      expect((await result).sources).toContain("uiautomator");
      expect(adb.cleanupCompleted).toBe(true);
      expect(timer.now()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      adb.cleanup.resolve();
      await result;
    }
  });
  test("stops awaiting slow cleanup at the remaining request deadline", async () => {
    const timer = new FakeTimer();
    const adb = new ControlledCleanupAdb(() => timer.advanceTime(400));
    const { run } = fixture(undefined, adb, timer);
    let returned = false;
    const result = run().then((value) => {
      returned = true;
      return value;
    });
    try {
      await drainUntil(() => adb.cleanupStarted, { description: "slow cleanup dispatch" });
      timer.advanceTime(599);
      await drainMicrotasks(30);
      expect(returned).toBe(false);
      timer.advanceTime(1);
      await drainUntil(() => returned, { description: "cleanup wait deadline" });
      expect((await result).sources).toContain("uiautomator");
      expect(timer.now()).toBe(1000);
      expect(adb.cleanupCompleted).toBe(false);
      expect(adb.getLastCommandCall()?.timeoutMs).toBe(1500);
      expect(adb.getLastCommandCall()?.signal?.aborted).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      adb.cleanup.resolve();
      await result;
    }
  });
  test("consumes and logs a detached cleanup rejection after returning", async () => {
    const timer = new FakeTimer();
    const adb = new ControlledCleanupAdb(() => timer.advanceTime(1000));
    const { run, original } = fixture(undefined, adb, timer);
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    let returned = false;
    const result = run().then((value) => {
      returned = true;
      return value;
    });
    try {
      await drainUntil(() => returned, { description: "result before cleanup rejection" });
      expect(await result).toBe(original);
      expect(adb.cleanupCompleted).toBe(false);
      const failure = new Error("late cleanup failure");
      adb.cleanup.reject(failure);
      await drainUntil(() => debug.mock.calls.some((call) => call[1] === failure), {
        description: "detached rejection log",
      });
      expect(debug).toHaveBeenCalledWith(
        "[HierarchyFallback] Could not remove temporary dump",
        failure,
      );
      await drainMicrotasks(30);
    } finally {
      adb.cleanup.resolve();
      await result;
      debug.mockRestore();
    }
  });
  test("cancellation during cleanup stops waiting without aborting removal", async () => {
    const controller = new AbortController();
    const adb = new ControlledCleanupAdb();
    const { run, timer } = fixture(undefined, adb);
    let rejected = false;
    const result = run(controller.signal).catch((error: unknown) => {
      rejected = true;
      return error;
    });
    try {
      await drainUntil(() => adb.cleanupStarted, { description: "cleanup before cancellation" });
      controller.abort();
      await drainUntil(() => rejected, { description: "cancellation during cleanup" });
      expect(await result).toMatchObject({ message: "Operation cancelled" });
      expect(adb.cleanupCompleted).toBe(false);
      expect(adb.getLastCommandCall()?.signal?.aborted).toBe(false);
      expect(timer.now()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      adb.cleanup.resolve();
      await result;
    }
  });
  test("deduplicates matching native nodes but retains repeated IDs at other bounds", async () => {
    const { original, run } = fixture(xml(node("Same") + node("Other", "[0,100][100,200]")));
    original.hierarchy = {
      node: {
        $: {
          package: "com.test",
          class: "android.widget.Button",
          "resource-id": "com.test:id/row",
          text: "Same",
          "view-id": "native-row",
        },
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      },
    };
    const result = await run();
    const elements = new DefaultElementParser().flattenViewHierarchy(result).map((x) => x.element);
    expect(elements).toHaveLength(2);
    expect(elements.find((x) => x.text === "Same")?.["view-id"]).toBe("native-row");
    expect(elements.find((x) => x.text === "Other")?.bounds.top).toBe(100);
  });
  test.each(["", "not xml", xml(node("Other").replaceAll("com.test", "com.other"))])(
    "keeps incomplete data for unusable or different-app dumps: %s",
    async (contents) => {
      const { run, original } = fixture(contents);
      expect(await run()).toBe(original);
    },
  );
  test("does not read stale XML after a failed dump", async () => {
    const { run, original, adb } = fixture();
    adb.setCommandError(`shell uiautomator dump ${path}`, new Error("dump failed"));
    expect(await run()).toBe(original);
    expect(adb.wasCommandExecuted(`shell cat ${path}`)).toBe(false);
  });
  test("propagates caller cancellation", async () => {
    const { run } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toThrow();
  });
  test("skips fallback after the shared deadline", async () => {
    const { adb, timer, original } = fixture();
    expect(
      await supplementAndroidHierarchy(
        original,
        { adb, timer, idGenerator: new FakeIdGenerator(["test"]) },
        0,
      ),
    ).toBe(original);
    expect(adb.wasCommandExecuted(`shell uiautomator dump ${path}`)).toBe(false);
  });
});

describe("fallback foreground ownership", () => {
  test("resolves a withheld app root from the foreground probe", async () => {
    const { original, run } = fixture();
    delete original.packageName;
    const result = await run();
    expect(result.packageName).toBe("com.test");
    expect(result.sources).toContain("uiautomator");
  });
  test("rejects a known different foreground app", async () => {
    const { original, run, adb } = fixture();
    adb.setForegroundApp({ packageName: "com.other", userId: 0 });
    expect(await run()).toBe(original);
    expect(adb.wasCommandExecuted(`shell uiautomator dump ${path}`)).toBe(false);
  });
  test("rejects an app switch during the dump", async () => {
    class SwitchingAdb extends FakeAdbClient {
      private calls = 0;
      override async getForegroundApp() {
        return { packageName: ++this.calls === 1 ? "com.test" : "com.other", userId: 0 };
      }
    }
    const { original, timer } = fixture();
    const adb = new SwitchingAdb();
    adb.setCommandResult(`shell cat ${path}`, xml(node("Missing")));
    expect(
      await supplementAndroidHierarchy(
        original,
        { adb, timer, idGenerator: new FakeIdGenerator(["test"]) },
        1000,
      ),
    ).toBe(original);
  });
  test("promotes missing descendants of a duplicate wrapper", async () => {
    const { original, run } = fixture(
      xml(
        '<node package="com.test" class="Frame" resource-id="root" bounds="[0,0][100,100]">' +
          node("Missing") +
          "</node>",
      ),
    );
    original.hierarchy = {
      node: {
        $: { package: "com.test", class: "Frame", "resource-id": "root", "view-id": "native-root" },
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      },
    };
    const elements = new DefaultElementParser()
      .flattenViewHierarchy(await run())
      .map((x) => x.element);
    expect(elements).toHaveLength(2);
    expect(elements.find((x) => x.text === "Missing")).toBeDefined();
    expect(elements.find((x) => x.class === "Frame")?.["view-id"]).toBe("native-root");
  });
});

describe("fallback native identity inventory", () => {
  test("retains a native window-only node instead of an XML duplicate", async () => {
    const { original, run } = fixture(xml(node("Same")));
    original.windows = [
      {
        id: 1,
        type: 1,
        hierarchy: {
          $: {},
          node: [
            {
              $: {
                package: "com.test",
                class: "android.widget.Button",
                "resource-id": "com.test:id/row",
                text: "Same",
                "view-id": "native-window",
              },
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            },
          ],
        },
      },
    ];
    expect(await run()).toBe(original);
    const elements = new DefaultElementParser()
      .flattenViewHierarchy(original, { includeWindows: true })
      .map((x) => x.element);
    expect(elements.find((x) => x.text === "Same")?.["view-id"]).toBe("native-window");
  });
});

describe("fallback capture identity boundaries", () => {
  test("deduplicates id-less nodes with omitted native attributes and reordered bounds", async () => {
    const { original, run } = fixture(xml(node("Same", "[0,0][100,100]", "")));
    original.hierarchy = {
      node: {
        $: {
          package: "com.test",
          class: "android.widget.Button",
          text: "Same",
          "view-id": "native-idless",
        },
        bounds: { bottom: 100, right: 100, top: 0, left: 0 },
      },
    };
    expect(await run()).toBe(original);
  });
  test("rejects a same-package user switch", async () => {
    class SwitchingUserAdb extends FakeAdbClient {
      private calls = 0;
      override async getForegroundApp() {
        return { packageName: "com.test", userId: this.calls++ };
      }
    }
    const { original, timer } = fixture();
    const adb = new SwitchingUserAdb();
    adb.setCommandResult(`shell cat ${path}`, xml(node("Missing")));
    expect(
      await supplementAndroidHierarchy(
        original,
        { adb, timer, idGenerator: new FakeIdGenerator(["test"]) },
        1000,
      ),
    ).toBe(original);
  });
});
