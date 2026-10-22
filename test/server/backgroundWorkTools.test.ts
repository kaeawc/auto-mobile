import { describe, expect, test } from "bun:test";
import {
  backgroundWorkActionName,
  backgroundWorkSchema,
  createBackgroundWorkHandler,
  isBackgroundWorkRead,
  type BackgroundWorkArgs,
} from "../../src/server/backgroundWorkTools";
import { backgroundWorkResultSchema } from "../../src/server/backgroundWorkToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerBackgroundWorkTools } from "../../src/server/backgroundWorkTools";
import type { BootedDevice, ExecResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { toolIsError, toolStructured } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const IOS: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM" };
const APP = "dev.example.playground";

const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

const JOBS = `Registered 1 jobs:
  JOB #u0a123/7: 4e5f6a7 ${APP}/androidx.work.impl.background.systemjob.SystemJobService
    Source: uid=u0a123 user=0 pkg=${APP}
    JobInfo:
      Service: ${APP}/androidx.work.impl.background.systemjob.SystemJobService
      PERIODIC: interval=+15m0s0ms flex=+15m0s0ms
    Required constraints: BATTERY_NOT_LOW
    Run time: earliest=+1m0s0ms, latest=+16m0s0ms, original latest=+16m0s0ms
`;

function handlerWith(configure: (adb: FakeAdbExecutor) => void) {
  const adb = new FakeAdbExecutor();
  configure(adb);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { adb, handler: createBackgroundWorkHandler(() => adb, { timer }) };
}

const parseArgs = (args: unknown): BackgroundWorkArgs => backgroundWorkSchema.parse(args);

describe("backgroundWork tool (#14090)", () => {
  test("list reports jobs and conforms to the output schema", async () => {
    const { handler } = handlerWith((adb) =>
      adb.setCommandResponse("dumpsys jobscheduler", result(JOBS)),
    );
    const response = await handler(ANDROID, { appId: APP, action: "list" } as BackgroundWorkArgs);
    expect(toolIsError(response)).toBe(false);
    expect(backgroundWorkResultSchema.parse(toolStructured(response))).toMatchObject({
      status: "ok",
      action: "list",
      jobs: [{ jobId: 7, workManager: true, periodic: true }],
    });
  });

  test("runJob reports what happened and that it cannot be undone", async () => {
    const { handler, adb } = handlerWith((fake) =>
      fake.setCommandResponse("cmd jobscheduler run", result("Running job [FORCED]")),
    );
    const response = await handler(ANDROID, {
      appId: APP,
      action: { runJob: { jobId: 7, force: true } },
    } as BackgroundWorkArgs);
    expect(backgroundWorkResultSchema.parse(toolStructured(response))).toMatchObject({
      status: "ok",
      action: "runJob",
      ran: true,
      jobId: 7,
      forced: true,
    });
    expect(String(toolStructured(response).note)).toContain("cannot be undone");
    expect(adb.getExecutedCommands()).toEqual([`shell cmd jobscheduler run -f '${APP}' 7`]);
  });

  test("a refused job is an isError result with a typed code", async () => {
    const { handler } = handlerWith((adb) =>
      adb.setCommandResponse("cmd jobscheduler run", result("Job 9 not found")),
    );
    const response = await handler(ANDROID, {
      appId: APP,
      action: { runJob: { jobId: 9 } },
    } as BackgroundWorkArgs);
    expect(toolIsError(response)).toBe(true);
    expect(backgroundWorkResultSchema.parse(toolStructured(response))).toMatchObject({
      status: "failed",
      success: false,
      errorCode: "job_not_found",
    });
  });

  test("iOS is a typed unsupported result", async () => {
    const { handler } = handlerWith(() => {});
    const response = await handler(IOS, { appId: APP, action: "list" } as BackgroundWorkArgs);
    expect(backgroundWorkResultSchema.parse(toolStructured(response))).toMatchObject({
      status: "unsupported",
      success: false,
    });
  });

  test("an empty diagnostics result explains itself", async () => {
    const { handler } = handlerWith((adb) => {
      adb.setCommandResponse("pm list packages", result(`package:${APP}`));
      adb.setCommandResponse("am broadcast", result("Broadcast completed: result=0"));
      adb.setCommandResponse("logcat", result("WM-DiagnosticsWrkr row\n"));
    });
    const response = await handler(ANDROID, {
      appId: APP,
      action: { workManagerDiagnostics: true },
    } as BackgroundWorkArgs);
    expect(toolStructured(response)).toMatchObject({ status: "ok", workers: [] });
  });
});

describe("backgroundWork registration and classification", () => {
  test("registers with the documented input contract", () => {
    ToolRegistry.clearTools();
    registerBackgroundWorkTools();
    expect(parseArgs({ appId: APP, action: "list" })).toMatchObject({ action: "list" });
    expect(parseArgs({ appId: APP, action: { listAlarms: true } })).toBeTruthy();
    expect(
      parseArgs({ appId: APP, action: { runJob: { worker: "SyncWorker", force: true } } }),
    ).toBeTruthy();
    for (const bad of [
      { appId: "notapackage", action: "list" },
      { appId: "a.b;reboot", action: "list" },
      { appId: APP, action: "reboot" },
      { appId: APP, action: { runJob: {} } },
      { appId: APP, action: { runJob: { jobId: 1, worker: "W" } } },
      { appId: APP, action: { runJob: { jobId: 1.5 } } },
      { appId: APP, action: { runJob: { jobId: -1 } } },
      { appId: APP, action: { runJob: { jobId: "7" } } },
      { appId: APP, action: { runJob: { jobId: 1, extra: true } } },
      { appId: APP, action: { listAlarms: false } },
      { appId: APP, action: "list", unknown: true },
    ]) {
      expect(backgroundWorkSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("only list and listAlarms are reads", () => {
    expect(isBackgroundWorkRead({ action: "list" })).toBe(true);
    expect(isBackgroundWorkRead({ action: { listAlarms: true } })).toBe(true);
    expect(isBackgroundWorkRead({ action: { runJob: { jobId: 1 } } })).toBe(false);
    expect(isBackgroundWorkRead({ action: { workManagerDiagnostics: true } })).toBe(false);
    expect(isBackgroundWorkRead({})).toBe(false);
  });

  test("action names", () => {
    expect(backgroundWorkActionName("list")).toBe("list");
    expect(backgroundWorkActionName({ runJob: { jobId: 1 } })).toBe("runJob");
    expect(backgroundWorkActionName({ workManagerDiagnostics: true })).toBe(
      "workManagerDiagnostics",
    );
    expect(backgroundWorkActionName({ listAlarms: true })).toBe("listAlarms");
  });
});
