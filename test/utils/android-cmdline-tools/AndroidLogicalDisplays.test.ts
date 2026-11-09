import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readAndroidLogicalDisplays } from "../../../src/utils/android-cmdline-tools/AndroidLogicalDisplays";
import { parseAndroidDisplayInfos } from "../../../src/utils/android-cmdline-tools/AndroidDisplayParsers";
import { DUMPSYS_MAX_BUFFER } from "../../../src/utils/android-cmdline-tools/dumpsysLimits";
import { createExecResult } from "../../../src/utils/execResult";
import {
  aaosAdb,
  aaosDevice,
  aaosGetDisplays,
  aaosVirtualKey,
} from "../../helpers/aaosMultidisplay";

const panels = aaosDevice.displays!.panels;
const foldDisplays = readFileSync(
  new URL("../../fixtures/android-display/fold-displays.txt", import.meta.url),
  "utf8",
);
const closedFoldDump = readFileSync(
  new URL(
    "../../fixtures/android-display/fold-pixel10pf-api36/fold-closed-displays.txt",
    import.meta.url,
  ),
  "utf8",
);

describe("readAndroidLogicalDisplays", () => {
  test("supplements only missing inventory secondary panels, keeping display zero intact", async () => {
    const adb = aaosAdb();
    const controller = new AbortController();
    const infos = await readAndroidLogicalDisplays(adb, panels, controller.signal);
    expect(infos.map((info) => info.logicalId)).toEqual(["0", "2", "3", "4"]);
    expect(infos[0]).toEqual(parseAndroidDisplayInfos(aaosGetDisplays)[0]);
    expect(adb.getCommandCalls()).toEqual([
      {
        command: "shell cmd display get-displays",
        timeoutMs: 2000,
        noRetry: true,
        signal: controller.signal,
      },
      {
        command: "shell dumpsys display",
        timeoutMs: 2000,
        noRetry: true,
        maxBuffer: DUMPSYS_MAX_BUFFER,
        signal: controller.signal,
      },
    ]);
  });

  test("get-displays wins when another panel occupies the same logical id", async () => {
    const adb = aaosAdb();
    // The existing fold capture reports logical 3 for a physical cover, while the AAOS dump
    // reports logical 3 for ClusterDisplay. The primary list must win that conflict.
    adb.setCommandResponse("cmd display get-displays", createExecResult(foldDisplays, ""));
    const primary = parseAndroidDisplayInfos(foldDisplays);
    const infos = await readAndroidLogicalDisplays(adb, panels);
    expect(infos.slice(0, primary.length)).toEqual(primary);
    expect(infos.filter((info) => info.logicalId === "3")).toEqual(
      primary.filter((info) => info.logicalId === "3"),
    );
    expect(infos.find((info) => info.logicalId === "4")?.uniqueId).toBe(aaosVirtualKey);
  });

  test("does not add panels absent from the supplied inventory", async () => {
    const infos = await readAndroidLogicalDisplays(aaosAdb(), [panels[0], panels[3]]);
    expect(infos.map((info) => info.logicalId)).toEqual(["0", "4"]);
  });

  test("a secondary panel already reported by get-displays needs no dumpsys read", async () => {
    const adb = aaosAdb();
    await readAndroidLogicalDisplays(adb, [{ ...panels[0], role: "cluster" }]);
    expect(adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
  });

  test("physical-only inventory needs no dumpsys read", async () => {
    const adb = aaosAdb();
    await readAndroidLogicalDisplays(adb, [{ ...panels[1], role: "cover" }, panels[0]]);
    expect(adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
  });

  test("a disabled fold panel stays absent even when supplementation is needed", async () => {
    const adb = aaosAdb();
    // The captured closed fold has the AAOS center's uniqueId on disabled logical 1.
    adb.setCommandResponse("cmd display get-displays", createExecResult("", ""));
    adb.setCommandResponse("dumpsys display", createExecResult(closedFoldDump, ""));
    expect(await readAndroidLogicalDisplays(adb, [{ ...panels[0], role: "cluster" }])).toEqual([]);
  });

  test("supplementation never supplies logical zero when the primary list is empty", async () => {
    const adb = aaosAdb();
    adb.setCommandResponse("cmd display get-displays", createExecResult("", ""));
    const infos = await readAndroidLogicalDisplays(adb, [
      { ...panels[0], role: "cluster" },
      panels[3],
    ]);
    expect(infos.map((info) => info.logicalId)).toEqual(["4"]);
  });

  test("an optional dumpsys failure retains the primary list", async () => {
    const adb = aaosAdb();
    adb.setCommandError("dumpsys display", new Error("display service unavailable"));
    expect(await readAndroidLogicalDisplays(adb, panels)).toEqual(
      parseAndroidDisplayInfos(aaosGetDisplays),
    );
  });

  test("abort after the primary list prevents the optional read", async () => {
    const adb = aaosAdb();
    const controller = new AbortController();
    adb.abortAfterCommand("cmd display get-displays", controller);
    await expect(readAndroidLogicalDisplays(adb, panels, controller.signal)).rejects.toThrow();
    expect(adb.getExecutedCommands()).toEqual(["shell cmd display get-displays"]);
  });

  test("abort during supplementation is never swallowed", async () => {
    const adb = aaosAdb();
    const controller = new AbortController();
    adb.abortAfterCommand("dumpsys display", controller);
    await expect(readAndroidLogicalDisplays(adb, panels, controller.signal)).rejects.toThrow();
  });

  test("AbortError without an aborted signal is never swallowed", async () => {
    const adb = aaosAdb();
    const error = new Error("display read aborted");
    error.name = "AbortError";
    adb.setCommandError("dumpsys display", error);
    await expect(readAndroidLogicalDisplays(adb, panels)).rejects.toThrow(error);
  });
});
