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

/** Answers the installed-package listing itself; `respond` handles the broadcast and receiver query. */
class RecordingAdb {
  calls: string[][] = [];
  constructor(
    private readonly respond: (command: string) => Promise<ExecResult>,
    private readonly packages = `package:android\npackage:${APP}\n`,
  ) {}
  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    const command = args[1] ?? "";
    return command.startsWith("pm list packages") ? exec(this.packages) : this.respond(command);
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
    expect(adb.calls.at(-1)).toEqual(["shell", `am broadcast -a 'A' -p '${APP}'`]);
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

  test("an uninstalled package is not delivered, and nothing is sent (#14740)", async () => {
    const adb = new RecordingAdb(
      async () => exec("Broadcast completed: result=0"),
      "package:android\n",
    );
    const result = await new SendBroadcast(adb).send({
      appId: "com.not.installed",
      intent: { action: "x" },
    });
    expect(result).toMatchObject({ delivered: false, errorCode: "package_not_installed" });
    expect(adb.calls.some((call) => call[1]?.startsWith("am broadcast"))).toBe(false);
  });

  test("an explicit component with no matching receiver is not delivered (#14740)", async () => {
    const adb = new RecordingAdb(async (command) =>
      exec(
        command.startsWith("cmd package query-receivers") ? "" : "Broadcast completed: result=0",
      ),
    );
    const result = await new SendBroadcast(adb).send({
      appId: APP,
      intent: { action: "x", component: ".DoesNotExist" },
    });
    expect(result).toMatchObject({ delivered: false, errorCode: "no_matching_receiver" });
    expect(adb.calls.map((call) => call[1])).toContain(
      `cmd package query-receivers --components -a 'x' -n '${APP}/.DoesNotExist'`,
    );
    expect(adb.calls.some((call) => call[1]?.startsWith("am broadcast"))).toBe(false);
  });

  test("a component that resolves is broadcast; a failing precheck fails open (#14740)", async () => {
    const resolves = new RecordingAdb(async (command) =>
      exec(
        command.startsWith("cmd package query-receivers")
          ? `${APP}/${APP}.NetworkControlContractProbeReceiver\n`
          : "Broadcast completed: result=0",
      ),
    );
    const intent = { action: "x", component: ".NetworkControlContractProbeReceiver" };
    expect(await new SendBroadcast(resolves).send({ appId: APP, intent })).toMatchObject({
      delivered: true,
    });
    const broken = new RecordingAdb(async (command) => {
      if (command.startsWith("cmd package")) {
        throw new Error("cmd: not found");
      }
      return exec("Broadcast completed: result=0");
    });
    expect(await new SendBroadcast(broken).send({ appId: APP, intent })).toMatchObject({
      delivered: true,
    });
  });
});
