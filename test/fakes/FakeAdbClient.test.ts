import { describe, expect, test } from "bun:test";
import { FakeAdbClient } from "./FakeAdbClient";

describe("FakeAdbClient", () => {
  test("clears recorded spawned processes on reset", async () => {
    const adb = new FakeAdbClient();

    await adb.spawn(["shell", "screenrecord", "/sdcard/capture.mp4"]);
    expect(adb.getSpawnedProcesses()).toHaveLength(1);

    adb.reset();

    expect(adb.getSpawnedProcesses()).toEqual([]);
  });

  test("does not expose a process for a rejected spawn", async () => {
    const adb = new FakeAdbClient();
    adb.setSpawnRejection("screenrecord", new Error("spawn rejected"));

    await expect(adb.spawn(["shell", "screenrecord", "/sdcard/capture.mp4"])).rejects.toThrow(
      "spawn rejected",
    );

    expect(adb.getSpawnedProcesses()).toEqual([]);
  });
  test("delivers exit and error to listeners attached after a spawn from a real turn", async () => {
    const adb = new FakeAdbClient();
    adb.setSpawnExit("screenrecord", 7);
    adb.setSpawnError("pull", new Error("adb missing"));
    const observed = await new Promise<string[]>((resolve) => {
      setImmediate(async () => {
        const events: string[] = [];
        const exited = await adb.spawn(["shell", "screenrecord", "/sdcard/capture.mp4"]);
        const exit = new Promise<void>((done) =>
          exited.once("exit", (code) => {
            events.push(`exit ${code}`);
            done();
          }),
        );
        const failed = await adb.spawn(["pull", "/sdcard/capture.mp4"]);
        const error = new Promise<void>((done) =>
          failed.once("error", (cause: Error) => {
            events.push(`error ${cause.message}`);
            done();
          }),
        );
        await Promise.all([exit, error]);
        resolve(events);
      });
    });

    expect(observed).toEqual(["exit 7", "error adb missing"]);
  });
});
