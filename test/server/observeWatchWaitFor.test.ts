import { describe, expect, test } from "bun:test";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import type { TvosHierarchy } from "../../src/features/tvos/TvosHierarchy";
import { ActionableError, type BootedDevice, type ObserveResult } from "../../src/models";
import type { ObserveArgs } from "../../src/server/observeTools";
import { observeWatch, type WatchScreenshotSource } from "../../src/server/observeWatch";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { evaluateStepExpectations } from "../../src/utils/plan/StepExpectationEvaluator";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeTvosRunnerClient } from "../fakes/FakeTvosRunnerClient";
import b01 from "../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-b01.json";

// observe.waitFor on an Apple TV runner polls the runner hierarchy host-side, so executePlan
// step expectations (an internal observe with waitFor) evaluate on tvOS (#17309).

const appleTv: BootedDevice = {
  name: "Apple TV 4K",
  deviceId: "6B1F3C2E-0000-4000-8000-0000000F7309",
  platform: "tvos",
};

function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

const screenshots: WatchScreenshotSource = { capture: async () => pngOfSize(1920, 1080) };

/** The B01 capture with the `last` label reading `text`. */
function withLastLabel(text: string): unknown {
  return JSON.parse(JSON.stringify(b01.data).replace('"text":"last: none"', `"text":"${text}"`));
}

/** Serves `before` for the first `changeAfter` hierarchy reads, then `after`. */
class ChangingTvosRunner extends FakeTvosRunnerClient {
  reads = 0;
  private readonly later: FakeTvosRunnerClient;
  constructor(before: unknown, after: unknown, changeAfter: number) {
    super(before);
    this.later = new FakeTvosRunnerClient(after);
    this.changeAfter = changeAfter;
  }
  private readonly changeAfter: number;
  override async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    this.reads++;
    const tree = await super.hierarchy(signal);
    return this.reads > this.changeAfter ? this.later.tree : tree;
  }
}

function arrange(runner: FakeTvosRunnerClient) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_700_000_000_000);
  timer.enableAutoAdvance();
  const unregister = tvosRunners.register(appleTv.deviceId, runner);
  const observe = (args: ObserveArgs) =>
    observeWatch(appleTv, args, undefined, {
      screenshots,
      timer,
      idGenerator: new CountingIdGenerator("tv-wait"),
      fileWriter: new FakeScreenshotFileWriter(),
      pathProtection: new FakeScreenshotPathProtection(timer),
      cacheDir: () => "/cache/screenshots",
    });
  return { observe, unregister };
}

const lastIs = (text: string) => ({ elementId: "last", text, textMatch: "exact" as const });

describe("observe waitFor with the tvOS runner", () => {
  test("polls the runner hierarchy until the element matches", async () => {
    const runner = new ChangingTvosRunner(b01.data, withLastLabel("last: B01"), 2);
    const { observe, unregister } = arrange(runner);
    try {
      const response = await observe({ waitFor: { ...lastIs("last: B01"), timeout: 2000 } });
      const result = getStructuredPayload<ObserveResult & Record<string, unknown>>(response)!;
      expect(response.isError).toBeUndefined();
      expect(result).toMatchObject({ matched: true, awaitTimeout: false, polls: 3 });
      expect(result.awaitedElement).toMatchObject({ "resource-id": "last", text: "last: B01" });
      expect(runner.reads).toBe(3);
      expect(observeToolResultSchema.safeParse(result).success).toBe(true);
    } finally {
      unregister();
    }
  });

  test("an unmet waitFor times out with the last observation", async () => {
    const runner = new ChangingTvosRunner(b01.data, b01.data, 0);
    const { observe, unregister } = arrange(runner);
    try {
      const response = await observe({ waitFor: { ...lastIs("last: B01"), timeout: 300 } });
      const result = getStructuredPayload<ObserveResult & Record<string, unknown>>(response)!;
      expect(response.isError).toBe(true);
      expect(result).toMatchObject({ awaitTimeout: true, timedOut: true, awaitDuration: 300 });
      expect(result.focusedElement?.["resource-id"]).toBe("B01");
    } finally {
      unregister();
    }
  });

  test("absent waits for the element to disappear", async () => {
    const runner = new ChangingTvosRunner(b01.data, b01.data, 0);
    const { observe, unregister } = arrange(runner);
    try {
      const response = await observe({ waitFor: { absent: { elementId: "gone" } } });
      const result = getStructuredPayload<Record<string, unknown>>(response)!;
      expect(result).toMatchObject({ matched: true, awaitTimeout: false, polls: 1 });
    } finally {
      unregister();
    }
  });

  test("contentDescription matches an accessibility label the runner reports as text", async () => {
    const runner = new ChangingTvosRunner(b01.data, b01.data, 0);
    const { observe, unregister } = arrange(runner);
    try {
      const present = getStructuredPayload<Record<string, unknown>>(
        await observe({ waitFor: { contentDescription: "B01", timeout: 200 } }),
      )!;
      expect(present).toMatchObject({ matched: true, awaitTimeout: false, polls: 1 });
      const absent = getStructuredPayload<Record<string, unknown>>(
        await observe({ waitFor: { absent: { contentDescription: "B01" }, timeout: 200 } }),
      )!;
      expect(absent).toMatchObject({ matched: false, awaitTimeout: true });
    } finally {
      unregister();
    }
  });

  test("refuses waitFor fields that read device state, naming them", async () => {
    const { observe, unregister } = arrange(new FakeTvosRunnerClient());
    try {
      const error = await observe({
        waitFor: { activeWindow: { appId: "dev.example" } },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("does not support: waitFor.activeWindow");
    } finally {
      unregister();
    }
  });
});

describe("executePlan step expectations on tvOS", () => {
  const expectation = { type: "textEquals", selector: { elementId: "last" }, text: "last: B01" };

  test("a textEquals expectation passes once the runner shows the text", async () => {
    const runner = new ChangingTvosRunner(b01.data, withLastLabel("last: B01"), 1);
    const { observe, unregister } = arrange(runner);
    try {
      const outcome = await evaluateStepExpectations([expectation], (waitFor) =>
        observe({ waitFor: waitFor as ObserveArgs["waitFor"] }),
      );
      expect(outcome).toEqual({ status: "passed" });
    } finally {
      unregister();
    }
  });

  test("an unmet expectation fails as not satisfied, not as an observe refusal", async () => {
    const runner = new ChangingTvosRunner(b01.data, b01.data, 0);
    const { observe, unregister } = arrange(runner);
    try {
      const outcome = await evaluateStepExpectations(
        [{ ...expectation, timeoutMs: 200 }],
        (waitFor) => observe({ waitFor: waitFor as ObserveArgs["waitFor"] }),
      );
      expect(outcome.status).toBe("failed");
      const error = outcome.status === "failed" ? outcome.error : "";
      expect(error).toContain("not satisfied after 200ms");
      expect(error).not.toContain("does not support");
    } finally {
      unregister();
    }
  });
});
