import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BackgroundWork } from "../../../src/features/backgroundWork/BackgroundWork";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "dev.example.playground";
const SYNC_ID = "0a1b2c3d-1111-4222-8333-444455556666";
const jobsDump = readFileSync(
  new URL(
    "../../fixtures/android-jobscheduler/dumpsys-jobscheduler-api29-periodic.txt",
    import.meta.url,
  ),
  "utf8",
);
const diagnosticsLog = [
  "I/WM-DiagnosticsWrkr( 4242):  Id \t Class Name\t Job Id\t State\t Unique Name\t Tags\t",
  `I/WM-DiagnosticsWrkr( 4242): ${SYNC_ID}\t dev.example.playground.work.SyncWorker\t 7\t ENQUEUED\t periodic-sync\t dev.example.playground.work.SyncWorker\t`,
  "I/WM-DiagnosticsWrkr( 4242): 1b2c3d4e-2222-4333-8444-555566667777\t dev.example.playground.work.CleanupWorker\t null\t SUCCEEDED\t null\t dev.example.playground.work.CleanupWorker\t",
].join("\n");

const result = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

function harness() {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1_700_000_000_123);
  adb.setCommandResponse("pm list packages", result(`package:${APP}\n`));
  adb.setCommandResponse("am broadcast", result("Broadcast completed: result=0"));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return { adb, work: new BackgroundWork(adb, { timer }) };
}

describe("BackgroundWork.listJobs", () => {
  test("parses the package-filtered dump with a quoted package", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("dumpsys jobscheduler", result(jobsDump));
    const listed = await work.listJobs(APP);
    expect(listed.ok && listed.jobs.map((job) => job.jobId)).toEqual([7, 12]);
    expect(adb.getExecutedCommands()).toContain(`shell dumpsys jobscheduler '${APP}'`);
  });

  test("names WorkManager jobs from diagnostics already in logcat, and says where from", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("dumpsys jobscheduler", result(jobsDump));
    adb.setCommandResponse("logcat", result(diagnosticsLog));
    const listed = await work.listJobs(APP);
    expect(listed.ok && listed.jobs[0]).toMatchObject({
      jobId: 7,
      workerClass: "dev.example.playground.work.SyncWorker",
      workerClassSource: "diagnostics-log",
    });
    expect(listed.ok && listed.jobs[1].workerClass).toBeUndefined();
  });

  test("unreadable logcat leaves the jobs without worker names", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("dumpsys jobscheduler", result(jobsDump));
    adb.setCommandError("logcat", new Error("logcat unavailable"));
    const listed = await work.listJobs(APP);
    expect(listed.ok && listed.jobs[0].workerClass).toBeUndefined();
  });

  test("a failed dump is a typed failure", async () => {
    const { adb, work } = harness();
    adb.setCommandError("dumpsys jobscheduler", new Error("device offline"));
    expect(await work.listJobs(APP)).toMatchObject({ ok: false, errorCode: "dump_failed" });
  });
});

describe("BackgroundWork.listAlarms", () => {
  test("filters the whole-device dump to the package", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse(
      "dumpsys alarm",
      result(
        readFileSync(
          new URL("../../fixtures/android-alarm/dumpsys-alarm-api29.txt", import.meta.url),
          "utf8",
        ),
      ),
    );
    const listed = await work.listAlarms(APP);
    expect(listed.ok && listed.alarms).toHaveLength(2);
    expect(adb.getExecutedCommands()).toContain("shell dumpsys alarm");
  });
});

describe("BackgroundWork.workManagerDiagnostics", () => {
  test("broadcasts to the package and reads only log lines since the broadcast", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("logcat", result(diagnosticsLog));
    const diagnostics = await work.workManagerDiagnostics(APP);

    expect(diagnostics.ok && diagnostics.workers.map((worker) => worker.systemJobId)).toEqual([
      7,
      undefined,
    ]);
    const commands = adb.getExecutedCommands();
    expect(commands).toContain(
      `shell am broadcast -a 'androidx.work.diagnostics.REQUEST_DIAGNOSTICS' -p '${APP}'`,
    );
    expect(commands.find((command) => command.includes("logcat"))).toBe(
      "shell logcat -d -v brief -T '1700000000.123' -s WM-DiagnosticsWrkr:I DiagnosticsWrkr:I",
    );
  });

  test("polls in fake time and reports no workers when nothing is logged", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("logcat", result(""));
    const diagnostics = await work.workManagerDiagnostics(APP);
    expect(diagnostics).toMatchObject({ ok: true, workers: [] });
    expect(
      adb.getExecutedCommands().filter((command) => command.includes("logcat")).length,
    ).toBeGreaterThan(5);
  });

  test("an app that is not installed is a typed failure without a broadcast", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("pm list packages", result("package:other.app\n"));
    expect(await work.workManagerDiagnostics(APP)).toMatchObject({
      ok: false,
      errorCode: "diagnostics_failed",
    });
    expect(adb.getExecutedCommands().some((command) => command.includes("am broadcast"))).toBe(
      false,
    );
  });
});

describe("BackgroundWork.runJob", () => {
  test("runs a job by id, quoting the package", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("cmd jobscheduler run", result("Running job"));
    const run = await work.runJob(APP, { target: { jobId: 7 }, force: false });
    expect(run).toMatchObject({ ok: true, ran: true, jobId: 7, forced: false });
    expect(adb.getExecutedCommands()).toEqual([`shell cmd jobscheduler run '${APP}' 7`]);
  });

  test("force and user are passed through", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("cmd jobscheduler run", result("Running job [FORCED]"));
    const run = await work.runJob(APP, { target: { jobId: 7 }, force: true, userId: 10 });
    expect(run).toMatchObject({ ok: true, forced: true });
    expect(adb.getExecutedCommands()).toEqual([`shell cmd jobscheduler run -f -u 10 '${APP}' 7`]);
  });

  test("a worker class name resolves to its job through fresh diagnostics", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("logcat", result(diagnosticsLog));
    adb.setCommandResponse("cmd jobscheduler run", result("Running job [FORCED]"));
    const run = await work.runJob(APP, { target: { worker: "SyncWorker" }, force: true });
    expect(run).toMatchObject({
      ok: true,
      jobId: 7,
      worker: { workerClassName: "dev.example.playground.work.SyncWorker" },
    });
    expect(adb.getExecutedCommands().at(-1)).toBe(`shell cmd jobscheduler run -f '${APP}' 7`);
  });

  test.each([
    ["NoSuchWorker", "worker_not_found"],
    ["dev.example.playground.work.CleanupWorker", "worker_not_scheduled"],
  ])("worker %s is %s and runs nothing", async (worker, errorCode) => {
    const { adb, work } = harness();
    adb.setCommandResponse("logcat", result(diagnosticsLog));
    expect(await work.runJob(APP, { target: { worker }, force: false })).toMatchObject({
      ok: false,
      errorCode,
    });
    expect(adb.getExecutedCommands().some((command) => command.includes("jobscheduler run"))).toBe(
      false,
    );
  });

  test("two scheduled jobs for one worker name are ambiguous", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse(
      "logcat",
      result(
        [
          `${SYNC_ID}\t a.SyncWorker\t 7\t ENQUEUED\t null\t a.SyncWorker\t`,
          `1b2c3d4e-2222-4333-8444-555566667777\t b.SyncWorker\t 8\t ENQUEUED\t null\t b.SyncWorker\t`,
        ].join("\n"),
      ),
    );
    expect(
      await work.runJob(APP, { target: { worker: "SyncWorker" }, force: false }),
    ).toMatchObject({ ok: false, errorCode: "ambiguous_worker" });
  });

  test("a refusal is a typed failure carrying the raw output", async () => {
    const { adb, work } = harness();
    adb.setCommandResponse("cmd jobscheduler run", result("Job 99 not found"));
    expect(await work.runJob(APP, { target: { jobId: 99 }, force: false })).toMatchObject({
      ok: false,
      errorCode: "job_not_found",
      output: "Job 99 not found",
    });
  });

  test("a non-zero exit is classified from its message", async () => {
    const { adb, work } = harness();
    adb.setCommandError("cmd jobscheduler run", new Error("Job is not ready; use -f to force"));
    expect(await work.runJob(APP, { target: { jobId: 7 }, force: false })).toMatchObject({
      ok: false,
      errorCode: "job_not_ready",
    });
  });

  test("an aborted signal throws instead of reporting a failure", async () => {
    const { adb, work } = harness();
    adb.setCommandError("cmd jobscheduler run", new Error("cancelled"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      work.runJob(APP, { target: { jobId: 7 }, force: false }, controller.signal),
    ).rejects.toThrow();
  });
});
