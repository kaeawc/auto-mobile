import { describe, expect, test } from "bun:test";
import { parseWorkManagerDiagnostics } from "../../../src/features/backgroundWork/WorkManagerDiagnosticsParser";

// Reconstructed from WorkManager's DiagnosticsWorker (not a device capture): the header row, then
// one tab-separated row per work spec: id, class, job id, state, unique name, tags.
const LOG = [
  "--------- beginning of main",
  "I/WM-DiagnosticsWrkr( 4242): ",
  "I/WM-DiagnosticsWrkr( 4242):  Id \t Class Name\t Job Id\t State\t Unique Name\t Tags\t",
  "I/WM-DiagnosticsWrkr( 4242): 0a1b2c3d-1111-4222-8333-444455556666\t dev.example.playground.work.SyncWorker\t 7\t ENQUEUED\t periodic-sync\t dev.example.playground.work.SyncWorker, sync\t",
  "I/WM-DiagnosticsWrkr( 4242): 1b2c3d4e-2222-4333-8444-555566667777\t dev.example.playground.work.CleanupWorker\t null\t SUCCEEDED\t null\t dev.example.playground.work.CleanupWorker\t",
].join("\n");

describe("parseWorkManagerDiagnostics", () => {
  test("maps work specs to their JobScheduler job ids", () => {
    expect(parseWorkManagerDiagnostics(LOG)).toEqual([
      {
        workSpecId: "0a1b2c3d-1111-4222-8333-444455556666",
        workerClassName: "dev.example.playground.work.SyncWorker",
        systemJobId: 7,
        state: "ENQUEUED",
        uniqueName: "periodic-sync",
        tags: ["dev.example.playground.work.SyncWorker", "sync"],
      },
      {
        workSpecId: "1b2c3d4e-2222-4333-8444-555566667777",
        workerClassName: "dev.example.playground.work.CleanupWorker",
        state: "SUCCEEDED",
        tags: ["dev.example.playground.work.CleanupWorker"],
      },
    ]);
  });

  test("a later row for the same work spec wins, and prefix-less rows parse", () => {
    const row = (state: string) =>
      `0a1b2c3d-1111-4222-8333-444455556666\t a.B\t 3\t ${state}\t null\t a.B\t`;
    expect(parseWorkManagerDiagnostics(`${row("ENQUEUED")}\n${row("RUNNING")}`)).toMatchObject([
      { state: "RUNNING", systemJobId: 3 },
    ]);
  });

  test("log noise and empty output yield no workers", () => {
    expect(parseWorkManagerDiagnostics("")).toEqual([]);
    expect(parseWorkManagerDiagnostics("--------- beginning of main\nI/Foo( 1): hi")).toEqual([]);
  });
});
