import { describe, expect, test } from "bun:test";
import {
  DHU_DEFAULT_SIZE_PX,
  parseDhuConfigResolution,
  readHeadUnitInventoryEntry,
  withHeadUnitEntries,
  type HeadUnitInventoryDeps,
} from "../../../src/features/androidAuto/HeadUnitInventory";
import type { DesktopHeadUnitConsole } from "../../../src/features/androidAuto/DesktopHeadUnit";
import { listDevicesOutputSchema } from "../../../src/features/deviceLifecycle/core/toolSchemas";

function dhuConsole(panel?: DesktopHeadUnitConsole["panel"]): DesktopHeadUnitConsole {
  return {
    sendCommand: () => undefined,
    isRunning: () => true,
    hasVideoFocus: () => true,
    ...(panel ? { panel } : {}),
  };
}

function deps(
  consoles: Record<string, DesktopHeadUnitConsole>,
  files: Record<string, string>,
): HeadUnitInventoryDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    consoleFor: (deviceId) => consoles[deviceId],
    readConfig: async (configPath) => {
      reads.push(configPath);
      const text = files[configPath];
      if (text === undefined) {
        throw new Error(`ENOENT: ${configPath}`);
      }
      return text;
    },
  };
}

describe("parseDhuConfigResolution", () => {
  test("reads a named resolution from [general]", () => {
    expect(parseDhuConfigResolution("[general]\nresolution = 720p\ndpi = 160\n")).toEqual({
      width: 1280,
      height: 720,
    });
  });

  test("reads WIDTHxHEIGHT and ignores comments and other sections", () => {
    const text = [
      "; head unit",
      "[cluster]",
      "resolution = 400x240",
      "[general]",
      "# resolution = 480p",
      "resolution=1920x1080",
    ].join("\r\n");
    expect(parseDhuConfigResolution(text)).toEqual({ width: 1920, height: 1080 });
  });

  test("null without a general resolution, undefined for an unknown value", () => {
    expect(parseDhuConfigResolution("[general]\ntouch = true\n")).toBeNull();
    expect(parseDhuConfigResolution("[general]\nresolution = huge\n")).toBeUndefined();
  });

  test("inherited object keys are not named resolutions", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(parseDhuConfigResolution(`[general]\nresolution = ${name}\n`)).toBeUndefined();
    }
  });
});

describe("readHeadUnitInventoryEntry", () => {
  test("reports the daemon's DHU with its console, config and size", async () => {
    const fake = deps(
      { "emulator-5554": dhuConsole({ instance: "dhu-2", configPath: "/dhu/default_720p.ini" }) },
      { "/dhu/default_720p.ini": "[general]\nresolution = 720p\n" },
    );
    expect(await readHeadUnitInventoryEntry("emulator-5554", fake)).toEqual({
      display: "headUnit",
      role: "projected",
      projectedBy: "androidAuto",
      console: "dhu-2",
      configPath: "/dhu/default_720p.ini",
      sizePx: { width: 1280, height: 720 },
    });
  });

  test("a config without a resolution gets the DHU default size", async () => {
    const fake = deps(
      { "emulator-5554": dhuConsole({ instance: "dhu-1", configPath: "/dhu/default.ini" }) },
      { "/dhu/default.ini": "[general]\n" },
    );
    expect((await readHeadUnitInventoryEntry("emulator-5554", fake))?.sizePx).toEqual(
      DHU_DEFAULT_SIZE_PX,
    );
  });

  test("an unreadable config keeps the entry without a size", async () => {
    const fake = deps(
      { "emulator-5554": dhuConsole({ instance: "dhu-1", configPath: "/gone.ini" }) },
      {},
    );
    const entry = await readHeadUnitInventoryEntry("emulator-5554", fake);
    expect(entry).toMatchObject({ console: "dhu-1", configPath: "/gone.ini" });
    expect(entry?.sizePx).toBeUndefined();
  });

  test("no DHU, or a console with no panel, reports nothing and reads no file", async () => {
    const fake = deps({ "emulator-5556": dhuConsole() }, {});
    expect(await readHeadUnitInventoryEntry("emulator-5554", fake)).toBeUndefined();
    expect(await readHeadUnitInventoryEntry("emulator-5556", fake)).toBeUndefined();
    expect(fake.reads).toEqual([]);
  });
});

describe("withHeadUnitEntries", () => {
  test("adds headUnit only to the Android entry whose phone projects", async () => {
    const entries = [
      { platform: "android", runtime: { deviceId: "emulator-5554" } },
      { platform: "android", runtime: { deviceId: "emulator-5556" } },
      { platform: "ios", runtime: { deviceId: "emulator-5554" } },
      { platform: "android", runtime: { deviceId: null } },
    ];
    const asked: string[] = [];
    const listed = await withHeadUnitEntries(entries, async (deviceId) => {
      asked.push(deviceId);
      return deviceId === "emulator-5554"
        ? { display: "headUnit", role: "projected", projectedBy: "androidAuto", console: "dhu-1" }
        : undefined;
    });
    expect(asked).toEqual(["emulator-5554", "emulator-5556"]);
    expect(listed.map((entry) => entry.headUnit?.console)).toEqual([
      "dhu-1",
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("the listDevices output schema accepts the entry and refuses unknown fields", () => {
    const headUnit = {
      display: "headUnit",
      role: "projected",
      projectedBy: "androidAuto",
      console: "dhu-1",
      configPath: "/dhu/default_720p.ini",
      sizePx: { width: 1280, height: 720 },
    };
    const headUnitShape = listDevicesOutputSchema.shape.devices.element.shape.headUnit;
    expect(headUnitShape.safeParse(headUnit).success).toBe(true);
    expect(headUnitShape.safeParse({ ...headUnit, pid: 1 }).success).toBe(false);
  });
});
