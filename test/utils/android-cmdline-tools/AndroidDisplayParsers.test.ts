import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  logicalDisplayIdForPanel,
  parseAndroidDisplayInfos,
  parseSurfaceFlingerDisplayIds,
  parseTopFocusedDisplayId,
} from "../../../src/utils/android-cmdline-tools/AndroidDisplayParsers";

// The older fold-displays.txt uses cmd display get-displays syntax (inner ON,
// cover OFF), but its provenance is undocumented. Its cover ID is not corroborated
// by any real capture in the consistent pair below. Derived variants are labeled.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const foldSurfaceFlinger = fixture("fold-surfaceflinger.txt");
const phoneSurfaceFlinger = fixture("phone-surfaceflinger.txt");
const foldDisplays = fixture("fold-displays.txt");
const phoneDisplays = fixture("phone-displays.txt");
const innerLine = foldDisplays.split("\n")[1];
const innerKey = "4619827259835644672";
const surfaceCoverKey = "4619827551948147201";
// The old cover ID is not corroborated by the consistent capture: its cover
// uniqueId and SurfaceFlinger ID are both surfaceCoverKey in either posture.
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

const captureSuffixes = [
  "displays",
  "surfaceflinger",
  "surfaceflinger-full",
  "device-state",
  "print-state",
  "hinge-angle0",
  "captured-at",
];
// Read all 15 captured files once, including the complete SurfaceFlinger dumps.
const consistentCaptures = new Map(
  [
    "fold-print-states.txt",
    ...["open", "closed"].flatMap((posture) =>
      captureSuffixes.map((suffix) => `fold-${posture}-${suffix}.txt`),
    ),
  ].map((name) => [name, fixture(join("fold-pixel10pf-api36", name))]),
);
const capturedPostures = ["open", "closed"].map((posture) => ({
  posture,
  displays: consistentCaptures.get(`fold-${posture}-displays.txt`)!,
  surfaceFlinger: consistentCaptures.get(`fold-${posture}-surfaceflinger.txt`)!,
  surfaceFlingerFull: consistentCaptures.get(`fold-${posture}-surfaceflinger-full.txt`)!,
  deviceState: consistentCaptures.get(`fold-${posture}-device-state.txt`)!,
  printState: consistentCaptures.get(`fold-${posture}-print-state.txt`)!,
}));

// Test-only extraction of these dumpsys text fields, not a get-displays parser.
// AndroidDisplayInventory's device-record parser is private and does not expose
// logical blocks; match the captured block/field structure with standard RegExp.
function capturedPhysicalPanels(output: string) {
  return [
    ...output.matchAll(/^  DisplayDeviceInfo\{[^\n]*?uniqueId="local:(\d+)", (\d+) x (\d+),/gm),
  ].map((match) => ({
    key: match[1],
    sizePx: { width: Number(match[2]), height: Number(match[3]) },
  }));
}

function capturedLogicalDisplays(output: string) {
  // Four-space fields and two-space blank lines stay inside their Display N block.
  return [...output.matchAll(/^  Display (\d+):\n((?: {4}[^\n]*\n| {2}\n)*)/gm)].map((match) => {
    const block = match[2];
    const baseInfo = /^    mBaseDisplayInfo=DisplayInfo\{([^\n]*)/m.exec(block)?.[1] ?? "";
    const size = /\breal (\d+) x (\d+)\b/.exec(baseInfo);
    return {
      logicalId: match[1],
      primaryKey: /^    mPrimaryDisplayDevice=[^\n]*\(local:(\d+)\)$/m.exec(block)?.[1],
      enabled: /^    mIsEnabled=(true|false)$/m.exec(block)?.[1],
      baseLogicalId: /\bdisplayId (\d+),/.exec(baseInfo)?.[1],
      uniqueId: /\buniqueId "local:(\d+)"/.exec(baseInfo)?.[1],
      sizePx: size ? { width: Number(size[1]), height: Number(size[2]) } : undefined,
    };
  });
}

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

  test("preserves old fixture identity without reconciling uncorroborated cover IDs", () => {
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
    // Derived line-ending transformation of the older fixture.
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
    // Derived cuts of the older fixture line: incomplete header, header only, before real,
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
    // Documented undefined: fold-displays.txt's ...673 cover is not corroborated
    // by the consistent pair (...201 throughout); its provenance is undocumented.
    // Real cover mapping still needs cmd display get-displays in both postures:
    // the new dumpsys display captures cannot exercise logicalDisplayIdForPanel.
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

describe("consistent Pixel 10 Pro Fold capture (API 36)", () => {
  for (const capture of capturedPostures) {
    test(`${capture.posture}: preserves both exact 19-digit SurfaceFlinger IDs in order`, () => {
      const ids = [...parseSurfaceFlingerDisplayIds(capture.surfaceFlinger)];
      expect(ids).toEqual([innerKey, surfaceCoverKey]);
      for (const id of ids) {
        expect(id).toHaveLength(19);
        expect(capture.surfaceFlinger).toContain(id);
      }
    });

    test(`${capture.posture}: full SurfaceFlinger dump returns the same two IDs`, () => {
      // Repeated display/color/layer sections are deduplicated by the parser's Set.
      expect([...parseSurfaceFlingerDisplayIds(capture.surfaceFlingerFull)]).toEqual([
        innerKey,
        surfaceCoverKey,
      ]);
    });

    test(`${capture.posture}: device and logical physical IDs agree with SurfaceFlinger`, () => {
      const physical = capturedPhysicalPanels(capture.displays);
      expect(physical).toEqual([
        { key: innerKey, sizePx: { width: 2076, height: 2152 } },
        { key: surfaceCoverKey, sizePx: { width: 1080, height: 2364 } },
      ]);
      const ids = parseSurfaceFlingerDisplayIds(capture.surfaceFlinger);
      expect(new Set(physical.map((panel) => panel.key))).toEqual(ids);
      const logical = capturedLogicalDisplays(capture.displays);
      expect(logical).toHaveLength(2);
      expect(new Set(logical.map((display) => display.primaryKey))).toEqual(ids);
      expect(new Set(logical.map((display) => display.uniqueId))).toEqual(ids);
      for (const display of logical) {
        expect(display.baseLogicalId).toBe(display.logicalId);
        expect(display.uniqueId).toBe(display.primaryKey);
        expect(display.sizePx).toEqual(
          physical.find((panel) => panel.key === display.primaryKey)?.sizePx,
        );
      }
    });

    test(`${capture.posture}: dumpsys display is outside the get-displays parser contract`, () => {
      // No cmd display get-displays capture exists for this consistent pair.
      // These real dumps have Display N / mBaseDisplayInfo, not Display id N.
      // Follow up with get-displays in both postures to test real cover mapping.
      expect(capture.displays).not.toMatch(/^\s*Display id \d+:/m);
      expect(parseAndroidDisplayInfos(capture.displays)).toEqual([]);
    });
  }

  test("open: inner backs enabled display 0; cover backs disabled display 3", () => {
    expect(capturedLogicalDisplays(capturedPostures[0].displays)).toEqual([
      {
        logicalId: "0",
        primaryKey: innerKey,
        enabled: "true",
        baseLogicalId: "0",
        uniqueId: innerKey,
        sizePx: { width: 2076, height: 2152 },
      },
      {
        logicalId: "3",
        primaryKey: surfaceCoverKey,
        enabled: "false",
        baseLogicalId: "3",
        uniqueId: surfaceCoverKey,
        sizePx: { width: 1080, height: 2364 },
      },
    ]);
  });

  test("closed: cover backs enabled display 0; inner backs disabled display 1", () => {
    expect(capturedLogicalDisplays(capturedPostures[1].displays)).toEqual([
      {
        logicalId: "0",
        primaryKey: surfaceCoverKey,
        enabled: "true",
        baseLogicalId: "0",
        uniqueId: surfaceCoverKey,
        sizePx: { width: 1080, height: 2364 },
      },
      {
        logicalId: "1",
        primaryKey: innerKey,
        enabled: "false",
        baseLogicalId: "1",
        uniqueId: innerKey,
        sizePx: { width: 2076, height: 2152 },
      },
    ]);
  });

  test("device state confirms OPENED 2 and CLOSED 0 in the paired captures", () => {
    expect(capturedPostures[0].deviceState).toContain("DeviceState{identifier=2, name='OPENED'");
    expect(capturedPostures[0].printState).toBe("2\n");
    expect(capturedPostures[1].deviceState).toContain("DeviceState{identifier=0, name='CLOSED'");
    expect(capturedPostures[1].printState).toBe("0\n");
  });

  test("older SurfaceFlinger capture is byte-identical to the consistent open capture", () => {
    expect(Buffer.from(foldSurfaceFlinger)).toEqual(
      Buffer.from(capturedPostures[0].surfaceFlinger),
    );
    expect(capturedPostures[0].surfaceFlinger).toBe(capturedPostures[1].surfaceFlinger);
  });

  test("older cover ID is absent from every consistent capture and physical ID set", () => {
    const [inner, cover] = parseAndroidDisplayInfos(foldDisplays);
    expect(cover.uniqueId).toBe(`local:${logicalCoverKey}`);
    expect(inner.uniqueId).toBe(`local:${innerKey}`);
    for (const text of consistentCaptures.values()) {
      expect(text).not.toContain(logicalCoverKey);
    }
    for (const capture of capturedPostures) {
      expect(capture.displays).toContain(inner.uniqueId!);
      for (const text of [foldSurfaceFlinger, capture.surfaceFlinger, capture.surfaceFlingerFull]) {
        const ids = parseSurfaceFlingerDisplayIds(text);
        expect(ids.has(logicalCoverKey)).toBe(false);
        expect(ids.has(innerKey)).toBe(true);
      }
    }
  });
});

describe("parseTopFocusedDisplayId", () => {
  const focusFixture = (name: string): string =>
    readFileSync(join(import.meta.dir, "../../fixtures/android-focus-multidisplay", name), "utf8");
  test("reads the captured top focused display", () => {
    expect(
      parseTopFocusedDisplayId(focusFixture("fold-overlay-focus-inner-window-focus.txt")),
    ).toBe(0);
    expect(
      parseTopFocusedDisplayId(focusFixture("fold-overlay-focus-overlay-window-focus.txt")),
    ).toBe(7);
  });
  test("is undefined when absent", () => {
    expect(parseTopFocusedDisplayId("")).toBeUndefined();
  });
});
