import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import {
  iosAgentHidesPrototypeForCapture,
  prototypeHiderFromConnections,
} from "../../../src/features/prototype/ios/iosCapturePrototypeHider";
import { SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY } from "../../../src/features/prototype/ios/iosPrototypeTransport";
import type { PrototypeAgentClient } from "../../../src/features/prototype/ios/prototypeAgentClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeTimer } from "../../fakes/FakeTimer";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { iosDevice } from "./takeScreenshotTestHelpers";

// A 1x1-header PNG: enough for the header-size read and the unencoded PNG path.
const PNG = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG, 0);
PNG.writeUInt32BE(13, 8);
PNG.write("IHDR", 12, "ascii");
PNG.writeUInt32BE(320, 16);
PNG.writeUInt32BE(640, 20);

const DEVICE_ID = "ios-hide-prototype";

function agent(capabilities: string[]): FakePrototypeAgentClient {
  return new FakePrototypeAgentClient({ agentVersion: "t", protocolVersion: 1, capabilities });
}

const HIDE_CAPS = [
  "hide_for_capture",
  "restore_after_capture",
  SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
];

describe("iOS screenshot with the prototype hidden (#9305)", () => {
  const originalGetInstance = IOSCtrlProxyClient.getInstance;
  let captures: string[];
  let captureFails: boolean;

  beforeEach(() => {
    captures = [];
    captureFails = false;
    IOSCtrlProxyClient.getInstance = (() => ({
      ensureConnected: async () => true,
      requestScreenshot: async () => {
        captures.push("capture");
        if (captureFails) {
          throw new Error("simctl screenshot failed");
        }
        return { success: true, data: PNG.toString("base64") };
      },
    })) as typeof IOSCtrlProxyClient.getInstance;
  });

  afterEach(() => {
    IOSCtrlProxyClient.getInstance = originalGetInstance;
  });

  function screenshotWith(client: PrototypeAgentClient | undefined): TakeScreenshot {
    return new TakeScreenshot(
      iosDevice(DEVICE_ID),
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      new FakeTimer(),
      new CountingIdGenerator("capture"),
      new FakeScreenshotFileWriter(),
      undefined,
      undefined,
      undefined,
      false,
      { iosPrototypeHider: prototypeHiderFromConnections({ get: () => client }) },
    );
  }

  test("capability present: hides around the capture, restores, and reports the prototype hidden", async () => {
    const prototype = agent(HIDE_CAPS);
    prototype.queueReplies({ hidden: true, token: 1 }, { restored: true });
    const result = await screenshotWith(prototype).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(true);
    expect(result.prototypesHidden).toBe(true);
    expect(prototype.requests[0]?.body.deadlineMs).toBe(11000);
    expect(prototype.requests[1]?.body).toEqual({ token: 1 });
    expect(prototype.requests.map((request) => request.type)).toEqual([
      "hide_for_capture",
      "restore_after_capture",
    ]);
    expect(captures).toEqual(["capture"]);
  });

  test("a hide that found nothing visible still returns the image as hidden", async () => {
    const prototype = agent(HIDE_CAPS);
    prototype.queueReplies({ hidden: false, token: 1 }, { restored: true });
    const result = await screenshotWith(prototype).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(true);
    expect(result.prototypesHidden).toBe(true);
  });

  test("hidePrototypes not requested: the agent is never asked", async () => {
    const prototype = agent(HIDE_CAPS);
    const result = await screenshotWith(prototype).execute({ format: "png" });

    expect(result.success).toBe(true);
    expect(result.prototypesHidden).toBeUndefined();
    expect(prototype.requests).toEqual([]);
  });

  test("capture throws: the restore is still sent and the failure is reported", async () => {
    captureFails = true;
    const prototype = agent(HIDE_CAPS);
    const result = await screenshotWith(prototype).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("simctl screenshot failed");
    expect(prototype.requests.map((request) => request.type)).toEqual([
      "hide_for_capture",
      "restore_after_capture",
    ]);
  });

  test("a hide the agent never confirmed fails the capture instead of showing the prototype", async () => {
    const prototype = agent(HIDE_CAPS);
    prototype.queueReplies(new Error("no answer"));
    const result = await screenshotWith(prototype).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not confirm");
    expect(result.prototypesHidden).toBeUndefined();
  });

  test("a hold that expired mid-capture (restored:false) fails the capture", async () => {
    const prototype = agent(HIDE_CAPS);
    prototype.queueReplies({ hidden: true, token: 1 }, { restored: false });
    const result = await screenshotWith(prototype).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("could not confirm");
    expect(result.prototypesHidden).toBeUndefined();
  });

  test("overlapping captures both succeed, each restoring its own token", async () => {
    const prototype = agent(HIDE_CAPS);
    prototype.queueReplies(
      { hidden: true, token: 1 },
      { hidden: true, token: 2 },
      { restored: true },
      { restored: true },
    );
    const screenshot = screenshotWith(prototype);
    const [a, b] = await Promise.all([
      screenshot.execute({ format: "png", hidePrototypes: true }),
      screenshot.execute({ format: "png", hidePrototypes: true }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const restores = prototype.requests.filter((r) => r.type === "restore_after_capture");
    expect(restores.map((r) => r.body.token).sort()).toEqual([1, 2]);
  });

  test("agent gone by capture time fails rather than capturing the prototype", async () => {
    const result = await screenshotWith(undefined).execute({ format: "png", hidePrototypes: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer connected");
    expect(captures).toEqual([]);
  });
});

describe("iosAgentHidesPrototypeForCapture (#9305)", () => {
  const resolverFor = (client: PrototypeAgentClient | undefined) =>
    prototypeHiderFromConnections({ get: () => client });

  test("true only for a connected agent advertising the capability", () => {
    expect(iosAgentHidesPrototypeForCapture(DEVICE_ID, resolverFor(agent(HIDE_CAPS)))).toBe(true);
  });

  test("false when the agent does not advertise it", () => {
    expect(
      iosAgentHidesPrototypeForCapture(DEVICE_ID, resolverFor(agent(["show_prototype"]))),
    ).toBe(false);
  });

  test("false when no agent is connected", () => {
    expect(iosAgentHidesPrototypeForCapture(DEVICE_ID, resolverFor(undefined))).toBe(false);
  });
});
