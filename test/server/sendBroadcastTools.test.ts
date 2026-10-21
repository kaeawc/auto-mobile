import { describe, expect, test } from "bun:test";
import {
  createSendBroadcastHandler,
  type SendBroadcastArgs,
} from "../../src/server/sendBroadcastTools";
import { sendBroadcastResultSchema } from "../../src/server/sendBroadcastToolOutputSchemas";
import type { BootedDevice, ExecResult } from "../../src/models";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM" };

interface ToolResult {
  structuredContent: unknown;
  isError?: true;
}

function adbReturning(broadcastOutput: string) {
  return () => ({
    execute: async (args: string[]): Promise<ExecResult> => {
      const stdout = args[1]?.startsWith("pm list packages")
        ? "package:com.example\n"
        : broadcastOutput;
      return {
        stdout,
        stderr: "",
        toString: () => stdout,
        trim: () => stdout.trim(),
        includes: (value: string) => stdout.includes(value),
      };
    },
  });
}

const args = (extra: Partial<SendBroadcastArgs> = {}): SendBroadcastArgs =>
  ({
    appId: "com.example",
    intent: { action: "com.example.TOGGLE" },
    ...extra,
  }) as SendBroadcastArgs;

describe("sendBroadcast tool (#14081)", () => {
  test("a delivered broadcast reports its result code", async () => {
    const result = (await createSendBroadcastHandler(
      adbReturning('Broadcast completed: result=1, data="ok"'),
    )(ANDROID, args())) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(sendBroadcastResultSchema.parse(result.structuredContent)).toMatchObject({
      status: "delivered",
      resultCode: 1,
      resultData: "ok",
    });
  });

  test("waitForResult false leaves the result code out", async () => {
    const result = (await createSendBroadcastHandler(adbReturning("Broadcast completed: result=1"))(
      ANDROID,
      args({ waitForResult: false }),
    )) as ToolResult;
    expect(sendBroadcastResultSchema.parse(result.structuredContent).resultCode).toBeUndefined();
  });

  test("a protected broadcast is an isError result with a typed code", async () => {
    const result = (await createSendBroadcastHandler(
      adbReturning(
        "Permission Denial: not allowed to send broadcast android.intent.action.BOOT_COMPLETED from pid=1",
      ),
    )(ANDROID, args())) as ToolResult;
    expect(result.isError).toBe(true);
    expect(sendBroadcastResultSchema.parse(result.structuredContent)).toMatchObject({
      errorCode: "protected_broadcast",
    });
  });

  test("iOS is a typed unsupported result", async () => {
    const result = (await createSendBroadcastHandler(adbReturning(""))(IOS, args())) as ToolResult;
    expect(sendBroadcastResultSchema.parse(result.structuredContent)).toMatchObject({
      status: "unsupported",
      success: false,
    });
  });
});
