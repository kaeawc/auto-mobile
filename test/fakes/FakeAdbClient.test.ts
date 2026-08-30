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
});
