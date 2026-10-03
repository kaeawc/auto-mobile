import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  logicalDisplayIdForPanel,
  parseAndroidDisplayInfos,
  parseSurfaceFlingerDisplayIds,
} from "../../../src/utils/android-cmdline-tools/AndroidDisplayParsers";

// fold-displays.txt captures the open fold: inner ON, cover OFF. These parsers
// do not parse device_state; other states are covered by AndroidDisplayInventory.test.ts
// and ObservationDisplay.test.ts. All variants below derive from captured text.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const foldSurfaceFlinger = fixture("fold-surfaceflinger.txt");
const phoneSurfaceFlinger = fixture("phone-surfaceflinger.txt");
const foldDisplays = fixture("fold-displays.txt");
const phoneDisplays = fixture("phone-displays.txt");
const innerLine = foldDisplays.split("\n")[1];
const innerKey = "4619827259835644672";
const surfaceCoverKey = "4619827551948147201";
// The captured logical cover ID differs from the SurfaceFlinger cover ID.
const logicalCoverKey = "4619827259835644673";
const innerInfo = {
  logicalId: "0",
  uniqueId: `local:${innerKey}`,
  type: "INTERNAL",
  sizePx: { width: 2076, height: 2152 },
  hasDisplayInfo: true,
};
const coverInfo = {
  logicalId: "3",
  uniqueId: `local:${logicalCoverKey}`,
  type: "INTERNAL",
  sizePx: { width: 1080, height: 2364 },
  hasDisplayInfo: true,
};

describe("parseSurfaceFlingerDisplayIds", () => {
  test("preserves exact 19-digit physical IDs and capture insertion order", () => {
    const ids = parseSurfaceFlingerDisplayIds(foldSurfaceFlinger);
    expect([...ids]).toEqual([innerKey, surfaceCoverKey]);
    for (const id of ids) {
      expect(id).toHaveLength(19);
      expect(String(Number(id))).not.toBe(id);
      expect(foldSurfaceFlinger).toContain(`Display ${id} (HWC display`);
    }
  });

  test("finds one physical display on the phone and two on the fold", () => {
    expect(parseSurfaceFlingerDisplayIds(phoneSurfaceFlinger)).toEqual(new Set([innerKey]));
    expect(parseSurfaceFlingerDisplayIds(foldSurfaceFlinger).size).toBe(2);
  });

  test("accepts CRLF derived from the captured SurfaceFlinger output", () => {
    // Derived line-ending transformation, not another device capture.
    expect([...parseSurfaceFlingerDisplayIds(foldSurfaceFlinger.replace(/\n/g, "\r\n"))]).toEqual([
      innerKey,
      surfaceCoverKey,
    ]);
  });

  test("returns an empty Set for empty and non-matching display-service output", () => {
    expect(parseSurfaceFlingerDisplayIds("")).toEqual(new Set<string>());
    expect(parseSurfaceFlingerDisplayIds(foldDisplays)).toEqual(new Set<string>());
  });
});

describe("parseAndroidDisplayInfos", () => {
  test("parses both open-fold records and skips the Displays header", () => {
    expect(parseAndroidDisplayInfos(foldDisplays)).toEqual([innerInfo, coverInfo]);
    expect(parseAndroidDisplayInfos(foldDisplays.split("\n")[0])).toEqual([]);
    expect(foldDisplays).toContain("state ON");
    expect(foldDisplays).toContain("state OFF");
    for (const info of parseAndroidDisplayInfos(foldDisplays)) {
      expect(info).not.toHaveProperty("state");
    }
  });

  test("preserves inner and cover identity without reconciling mismatched captures", () => {
    const [inner, cover] = parseAndroidDisplayInfos(foldDisplays);
    expect(inner).toEqual(innerInfo);
    expect(cover).toEqual(coverInfo);
    expect(inner.sizePx!.width * inner.sizePx!.height).toBeGreaterThan(
      cover.sizePx!.width * cover.sizePx!.height,
    );
    const physical = parseSurfaceFlingerDisplayIds(foldSurfaceFlinger);
    expect(physical.has(inner.uniqueId!.slice("local:".length))).toBe(true);
    expect(physical.has(cover.uniqueId!.slice("local:".length))).toBe(false);
  });

  test("parses the single phone record", () => {
    expect(parseAndroidDisplayInfos(phoneDisplays)).toEqual([
      { ...innerInfo, sizePx: { width: 1080, height: 2400 } },
    ]);
  });

  test("accepts CRLF derived from the captured display-service output", () => {
    // Derived line-ending transformation of the real fold capture.
    expect(parseAndroidDisplayInfos(foldDisplays.replace(/\n/g, "\r\n"))).toEqual([
      innerInfo,
      coverInfo,
    ]);
  });

  test("accepts an unquoted uniqueId derived by stripping the captured value quotes", () => {
    // No unquoted ID was captured: remove only the real uniqueId's quotes.
    const unquoted = innerLine.replace(`"local:${innerKey}"`, `local:${innerKey}`);
    expect(unquoted).not.toBe(innerLine);
    expect(parseAndroidDisplayInfos(unquoted)).toEqual([innerInfo]);
  });

  test("marks DisplayInfo absent when its marker is removed from the captured line", () => {
    // Derived by removing the marker; all captured field values remain intact.
    expect(parseAndroidDisplayInfos(innerLine.replace("DisplayInfo{", ""))).toEqual([
      { ...innerInfo, hasDisplayInfo: false },
    ]);
  });

  test("retains sensible partial records at captured header and size truncations", () => {
    // Derived cuts of the real line: incomplete header, header only, before real,
    // and after the width but before the height.
    expect(parseAndroidDisplayInfos(innerLine.slice(0, innerLine.indexOf(":")))).toEqual([]);
    expect(parseAndroidDisplayInfos(innerLine.slice(0, innerLine.indexOf(":") + 1))).toEqual([
      {
        logicalId: "0",
        uniqueId: undefined,
        type: undefined,
        sizePx: undefined,
        hasDisplayInfo: false,
      },
    ]);
    for (const end of [innerLine.indexOf("real"), innerLine.indexOf(" x ") + 3]) {
      expect(parseAndroidDisplayInfos(innerLine.slice(0, end))).toEqual([
        {
          logicalId: "0",
          uniqueId: undefined,
          type: undefined,
          sizePx: undefined,
          hasDisplayInfo: true,
        },
      ]);
    }
  });

  test("does not turn a truncated quoted uniqueId into a panel identity", () => {
    // Derived cuts before the value, after its opening quote, and midway through
    // the physical ID. A partial quoted value cannot establish panel identity.
    const valueStart = innerLine.indexOf(`"local:${innerKey}"`);
    for (const end of [valueStart, valueStart + 1, valueStart + '"local:'.length + 8]) {
      const infos = parseAndroidDisplayInfos(innerLine.slice(0, end));
      expect(infos).toEqual([{ ...innerInfo, uniqueId: undefined }]);
      expect(logicalDisplayIdForPanel(infos, innerKey.slice(0, 8))).toBeUndefined();
    }
  });

  test("returns no records for empty and unrelated captured output", () => {
    expect(parseAndroidDisplayInfos("")).toEqual([]);
    expect(parseAndroidDisplayInfos(foldSurfaceFlinger)).toEqual([]);
  });
});

describe("logicalDisplayIdForPanel", () => {
  test("maps the captured inner and logical cover keys to displays 0 and 3", () => {
    const infos = parseAndroidDisplayInfos(foldDisplays);
    expect(logicalDisplayIdForPanel(infos, innerKey)).toBe(0);
    expect(logicalDisplayIdForPanel(infos, logicalCoverKey)).toBe(3);
  });

  test("returns undefined for unmatched physical cover keys and empty infos", () => {
    expect(
      logicalDisplayIdForPanel(parseAndroidDisplayInfos(foldDisplays), surfaceCoverKey),
    ).toBeUndefined();
    expect(logicalDisplayIdForPanel([], innerKey)).toBeUndefined();
  });

  test("maps a derived virtual prefix without changing the captured physical key", () => {
    // No virtual ID was captured: rewrite only local: to virtual: in the real line.
    const infos = parseAndroidDisplayInfos(innerLine.replace("local:", "virtual:"));
    expect(infos[0].uniqueId).toBe(`virtual:${innerKey}`);
    expect(logicalDisplayIdForPanel(infos, innerKey)).toBe(0);
  });

  test("preserves extra colons in a key derived from both captured panel IDs", () => {
    // Derived uniqueId appends the captured logical cover ID to the inner ID.
    const key = `${innerKey}:${logicalCoverKey}`;
    const infos = parseAndroidDisplayInfos(innerLine.replace(`local:${innerKey}`, `local:${key}`));
    expect(logicalDisplayIdForPanel(infos, key)).toBe(0);
    expect(logicalDisplayIdForPanel(infos, innerKey)).toBeUndefined();
  });

  test("skips undefined uniqueIds in records derived from a header-only line", () => {
    // Derive a record lacking uniqueId by cutting the captured inner line at its header.
    const header = innerLine.slice(0, innerLine.indexOf(":") + 1);
    const infos = parseAndroidDisplayInfos(`${header}\n${foldDisplays}`);
    expect(infos[0].uniqueId).toBeUndefined();
    expect(logicalDisplayIdForPanel(infos, innerKey)).toBe(0);
    expect(logicalDisplayIdForPanel(parseAndroidDisplayInfos(header), innerKey)).toBeUndefined();
  });
});
