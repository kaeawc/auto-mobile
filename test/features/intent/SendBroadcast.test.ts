import { describe, expect, test } from "bun:test";
import {
  broadcastCommand,
  parseBroadcastOutput,
  SendBroadcast,
} from "../../../src/features/intent/SendBroadcast";
import type { ExecResult } from "../../../src/models";

const APP = "dev.jasonpearson.automobile.playground";

const exec = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

class RecordingAdb {
  calls: string[][] = [];
  constructor(private readonly respond: () => Promise<ExecResult>) {}
  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    return this.respond();
  }
}

describe("broadcastCommand (#14081)", () => {
  test("is one explicit am broadcast, optionally to a user", () => {
    expect(
      broadcastCommand({
        appId: APP,
        intent: { action: "dev.example.TOGGLE", component: ".DebugReceiver" },
        userId: 10,
      }),
    ).toBe(`am broadcast --user 10 -a 'dev.example.TOGGLE' -n '${APP}/.DebugReceiver'`);
  });
});

describe("parseBroadcastOutput", () => {
  test("reads the ordered-broadcast result code and data", () => {
    expect(
      parseBroadcastOutput(
        `Broadcasting: Intent { act=dev.example.TOGGLE flg=0x400000 pkg=${APP} }\nBroadcast completed: result=-1, data="flag on"`,
      ),
    ).toMatchObject({ delivered: true, resultCode: -1, resultData: "flag on" });
    expect(parseBroadcastOutput("Broadcast completed: result=0")).toMatchObject({
      delivered: true,
      resultCode: 0,
    });
  });

  test("a protected system broadcast is a typed failure naming the action", () => {
    const result = parseBroadcastOutput(
      "Exception occurred while executing 'broadcast':\njava.lang.SecurityException: Permission Denial: not allowed to send broadcast android.intent.action.BOOT_COMPLETED from pid=1234, uid=2000",
    );
    expect(result).toMatchObject({ delivered: false, errorCode: "protected_broadcast" });
    if (result.delivered) {
      throw new Error("expected a failure");
    }
    expect(result.error).toContain("android.intent.action.BOOT_COMPLETED is a protected");
  });

  test("other security refusals and silent output are typed too", () => {
    expect(
      parseBroadcastOutput("java.lang.SecurityException: Permission Denial: requires X"),
    ).toMatchObject({ errorCode: "permission_denied" });
    expect(parseBroadcastOutput("Broadcasting: Intent { }")).toMatchObject({
      errorCode: "broadcast_failed",
    });
  });
});

describe("SendBroadcast", () => {
  test("runs the command as one shell argument and parses stdout", async () => {
    const adb = new RecordingAdb(async () => exec("Broadcast completed: result=0"));
    const result = await new SendBroadcast(adb).send({ appId: APP, intent: { action: "A" } });
    expect(adb.calls).toEqual([["shell", `am broadcast -a 'A' -p '${APP}'`]]);
    expect(result).toMatchObject({ delivered: true, resultCode: 0 });
  });

  test("a non-zero am exit is classified from the error message", async () => {
    const adb = new RecordingAdb(async () => {
      throw new Error(
        "adb exited 255: java.lang.SecurityException: Permission Denial: not allowed to send broadcast android.intent.action.BOOT_COMPLETED from pid=1",
      );
    });
    const result = await new SendBroadcast(adb).send({
      appId: APP,
      intent: { action: "android.intent.action.BOOT_COMPLETED" },
    });
    expect(result).toMatchObject({ delivered: false, errorCode: "protected_broadcast" });
  });

  test("cancellation propagates instead of being classified", async () => {
    const controller = new AbortController();
    const adb = new RecordingAdb(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await expect(
      new SendBroadcast(adb).send({ appId: APP, intent: { action: "A" } }, controller.signal),
    ).rejects.toThrow("aborted");
  });
});
