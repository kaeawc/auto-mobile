import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { getScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod/v4";
import { ScreenshotJobTracker } from "../../../src/utils/ScreenshotJobTracker";
import {
  setScreenshotFileSystem,
  resetScreenshotFileSystem,
} from "../../../src/server/observationResources";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../src/models/DeviceInfo";
import { FakeTimer } from "../../fakes/FakeTimer";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";

const resolveWithFakeTimer = async <T>(
  promise: Promise<T>,
  timer: FakeTimer,
  stepMs: number = 10,
): Promise<T> => {
  let settled = false;
  let result: T | undefined;
  let error: unknown;

  promise
    .then((value) => {
      settled = true;
      result = value;
    })
    .catch((caught) => {
      settled = true;
      error = caught;
    });

  let steps = 0;
  while (!settled) {
    if (
      timer.getPendingTimeoutCount() > 0 ||
      timer.getPendingIntervalCount() > 0 ||
      timer.getPendingSleepCount() > 0
    ) {
      timer.advanceTime(stepMs);
    }
    await new Promise((resolve) => setImmediate(resolve));
    steps += 1;
    if (steps > 2000) {
      throw new Error("FakeTimer pump exceeded max steps");
    }
  }

  if (error) {
    throw error;
  }
  return result as T;
};

describe("MCP Resources Read", () => {
  let fixture: McpTestFixture;

  beforeAll(async () => {
    // Clear both in-memory and disk caches from previous tests
    RealObserveScreen.clearCache();

    const cacheDir = path.join("/tmp/auto-mobile", "observe_results");
    try {
      const files = await fs.readdir(cacheDir);
      for (const file of files) {
        await fs.unlink(path.join(cacheDir, file));
      }
    } catch {
      // Cache directory might not exist, which is fine
    }

    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterEach(() => {
    RealObserveScreen.clearCache();
    ScreenshotJobTracker.resetTimer();
    resetScreenshotFileSystem();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
  });

  test("reading latest observation without prior observe should return error message", async function () {
    const { client } = fixture.getContext();

    // Send resources/read request
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "automobile:observation/latest",
        },
      },
      readResourceResponseSchema,
    );

    // Verify response structure
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("contents");
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents).toHaveLength(1);

    // Verify content
    const content = result.contents[0];
    expect(content.uri).toBe("automobile:observation/latest");
    expect(content.mimeType).toBe("application/json");
    expect(content.text).toBeDefined();

    // Parse and verify error message
    const data = JSON.parse(content.text!);
    expect(data).toHaveProperty("error");
    expect(data.error).toContain("No observation available");
  });

  test("reading latest screenshot resource", async function () {
    const { client } = fixture.getContext();

    // Send resources/read request
    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional(),
        }),
      ),
    });

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "automobile:observation/latest/screenshot",
        },
      },
      readResourceResponseSchema,
    );

    // Verify response structure
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("contents");
    expect(Array.isArray(result.contents)).toBe(true);
    expect(result.contents).toHaveLength(1);

    // Verify content
    const content = result.contents[0];
    expect(content.uri).toBe("automobile:observation/latest/screenshot");

    // Content can be either an error message (if no screenshot) or actual image data
    if (content.mimeType === "application/json") {
      // No screenshot available
      expect(content.text).toBeDefined();
      const data = JSON.parse(content.text!);
      expect(data).toHaveProperty("error");
      expect(data.error).toContain("No observation available");
    } else {
      // Screenshot available
      expect(content.mimeType).toMatch(/^image\/(png|webp)$/);
      expect(content.blob).toBeDefined();
      expect(content.blob!.length).toBeGreaterThan(0);
    }
  });

  test("reading latest screenshot waits for pending capture when none cached", async function () {
    const { client } = fixture.getContext();
    const fakeTimer = new FakeTimer();
    ScreenshotJobTracker.setTimer(fakeTimer);

    const fakeImageData = Buffer.from("fake screenshot data");
    const screenshotPath = path.join("/tmp/auto-mobile", "screenshots", `screenshot_fake.png`);

    setScreenshotFileSystem({
      stat: async (_p: string) => ({ isFile: () => true }),
      readFile: async (_p: string) => fakeImageData,
    });

    const mockDevice: BootedDevice = {
      deviceId: "test-device",
      name: "Test Device",
      platform: "android",
    };
    const observeScreen = new RealObserveScreen(
      mockDevice,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
    );
    await observeScreen.cacheObserveResult(observeScreen.createBaseResult());

    // Clear any pre-existing screenshot state
    getScreenshotStateStore().clear(mockDevice.deviceId);

    ScreenshotJobTracker.startJob(mockDevice.deviceId, async (signal) => {
      return new Promise((resolve) => {
        const timeoutId = fakeTimer.setTimeout(() => {
          getScreenshotStateStore().update(mockDevice.deviceId, screenshotPath);
          resolve({ success: true, path: screenshotPath });
        }, 25);

        signal.addEventListener(
          "abort",
          () => {
            fakeTimer.clearTimeout(timeoutId);
            resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
          },
          { once: true },
        );
      });
    });

    const readResourceResponseSchema = z.object({
      contents: z.array(
        z.object({
          uri: z.string(),
          mimeType: z.string().optional(),
          text: z.string().optional(),
          blob: z.string().optional(),
        }),
      ),
    });

    const resultPromise = client.request(
      {
        method: "resources/read",
        params: {
          uri: "automobile:observation/latest/screenshot",
        },
      },
      readResourceResponseSchema,
    );
    const result = await resolveWithFakeTimer(resultPromise, fakeTimer, 25);

    const content = result.contents[0];
    expect(content.uri).toBe("automobile:observation/latest/screenshot");
    expect(content.mimeType).toBe("image/png");
    expect(content.blob).toBeDefined();
    expect(content.blob!.length).toBeGreaterThan(0);
  });

  const readResourceResponseSchema = z.object({
    contents: z.array(
      z.object({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string().optional(),
        blob: z.string().optional(),
      }),
    ),
  });

  // Capture the recovery-guidance message a resources/read request rejects with,
  // stripped of the JSON-RPC transport wrapper ("MCP error -32603: ") so the
  // guidance itself can be pinned as one complete string rather than a set of
  // independent substring checks (issue #4659; #4183 item 10 + R5). Asserting
  // the whole message by equality catches a reordered, duplicated, or
  // contradictory rewrite that a `toContain` per line would let through.
  const readResourceGuidance = async (uri: string): Promise<string> => {
    const { client } = fixture.getContext();
    let caught: unknown;
    try {
      await client.request(
        {
          method: "resources/read",
          params: { uri },
        },
        readResourceResponseSchema,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    return (caught as Error).message.replace(/^MCP error -?\d+: /, "");
  };

  test("reading non-existent resource throws the complete not-found guidance", async function () {
    // The registry's "Resource not found" recovery guidance (R5) is the
    // agent-facing hint for a mistyped resource path; pin the entire message so
    // any dropped, reordered, or duplicated pattern line fails the test.
    const guidance = await readResourceGuidance("automobile:observation/invalid");

    expect(guidance).toBe(
      "Resource not found: automobile:observation/invalid\n\n" +
        "Available resource patterns:\n" +
        "  - automobile:devices/booted - List all booted devices\n" +
        "  - automobile:devices/booted/{platform} - List devices by platform (android|ios)\n" +
        "  - automobile:devices/{deviceId}/apps - List apps for a device\n" +
        "  - automobile:apps?deviceId={deviceId} - Query apps with filters\n" +
        "  - automobile:observation/latest - Latest screen observation\n\n" +
        "Use the listApps tool to list apps directly (params: deviceId, type, search, profile; default type=user).",
    );
  });

  test("reading a resource with an unknown URI scheme throws the complete scheme-correction guidance", async function () {
    // A mistyped scheme (here 'automoble') is rewritten to 'automobile:' in the
    // recovery hint; pin the entire message, wording and corrected suggestion.
    const guidance = await readResourceGuidance("automoble:devices/booted");

    expect(guidance).toBe(
      "Unknown URI scheme 'automoble://'. " +
        "AutoMobile resources use the 'automobile:' prefix. " +
        "Try: automobile:devices/booted",
    );
  });
});
