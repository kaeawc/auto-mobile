import { describe, expect, test } from "bun:test";
import { parseDevicectlDisplayInfo } from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { parseDevicectlFailureEnvelope } from "../../../src/utils/ios-cmdline-tools/devicectlFailureEnvelope";
import { FakeLogger } from "../../fakes/FakeLogger";
import { loadDevicectlListFixture } from "../../helpers/devicectlListFixtures";

describe("captured devicectl display info", () => {
  test("captured non-Duo simulator lists the exact display and envelope metadata", () => {
    const capture = loadDevicectlListFixture("info-displays-booted-simulator.json");
    const log = new FakeLogger();
    expect(parseDevicectlDisplayInfo(capture, log)).toEqual({
      kind: "ok",
      commandType: "devicectl.device.info.displays",
      jsonVersion: 5,
      version: "651.13.4",
      backlightState: "activeOn",
      orientation: {
        currentDeviceNonFlatOrientation: "portrait",
        currentDeviceOrientation: "unknown",
        currentDeviceOrientationLocked: false,
      },
      displays: [
        {
          uniqueId: "D93C043F-5B46-4213-B7A6-B6D082A5FAEE",
          displayId: 1,
          name: "LCD",
          primary: true,
          typeKind: "integrated",
          bounds: { origin: { x: 0, y: 0 }, size: { width: 1206, height: 2622 } },
          nativeSize: { width: 1206, height: 2622 },
          physicalSize: { width: 2.621739149093628, height: 5.699999809265137 },
          pointScale: 3,
          currentOrientation: "rot0",
          nativeOrientation: "rot0",
          backlightState: "activeOn",
          chromeIdentifier: "com.apple.dt.devicekit.chrome.phone11",
          framebufferMaskIdentifier: "4E5532ED-1470-47D1-BDF4-7AA90C26957A",
        },
      ],
    });
    expect(log.messages).toEqual([]);
  });

  test("captured unrelated lockstate 1001 is command-failed with shared structured failure metadata", () => {
    const capture = loadDevicectlListFixture("info-lockstate-booted-simulator-1001.json");
    const log = new FakeLogger();
    const parsed = parseDevicectlDisplayInfo(capture, log);
    expect(parsed).toMatchObject({
      kind: "failed",
      reason: "command-failed",
      coreDeviceError: {
        domain: "com.apple.dt.CoreDeviceError",
        code: 1001,
        kind: "capability-unsupported",
        capabilityFeatureId: "com.apple.coredevice.feature.getlockstate",
      },
    });
    if (parsed.kind !== "failed") {
      throw new Error("Expected captured failure");
    }
    expect(parsed.coreDeviceError).toEqual(parseDevicectlFailureEnvelope(JSON.parse(capture)));
    expect(parsed.message.length).toBeGreaterThan(0);
    expect(log.at("warn")).toHaveLength(1);
    expect(log.at("warn")[0].message).toContain(parsed.message);
  });
});

interface DerivedDisplayCapture {
  info: Record<string, unknown>;
  result: {
    displays: Record<string, unknown>[];
    [key: string]: unknown;
  };
}

/** DERIVED in memory from the non-Duo capture, never additional device evidence. */
function loadDerivedCapture(): DerivedDisplayCapture {
  return JSON.parse(loadDevicectlListFixture("info-displays-booted-simulator.json"));
}

describe("DERIVED in-memory mutations of captured display info", () => {
  test("DERIVED unknown fields at every level are ignored", () => {
    const derived = loadDerivedCapture();
    const log = new FakeLogger();
    Object.assign(derived, { extra: "ignored" });
    Object.assign(derived.info, { extra: "ignored" });
    Object.assign(derived.result, { extra: "ignored" });
    Object.assign(derived.result.orientation!, { extra: "ignored" });
    Object.assign(derived.result.displays[0], { extra: "ignored" });
    expect(parseDevicectlDisplayInfo(JSON.stringify(derived), log)).toStrictEqual(
      parseDevicectlDisplayInfo(
        loadDevicectlListFixture("info-displays-booted-simulator.json"),
        log,
      ),
    );
    expect(log.messages).toEqual([]);
  });

  test("DERIVED second display is retained in input order without selecting a primary panel", () => {
    const derived = loadDerivedCapture();
    derived.result.displays.push({
      ...derived.result.displays[0],
      uniqueId: "derived-second-display",
      displayId: 2,
      primary: false,
    });
    const log = new FakeLogger();
    const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") {
      throw new Error("Expected derived display listing");
    }
    expect(
      parsed.displays.map(({ uniqueId, displayId, primary }) => ({ uniqueId, displayId, primary })),
    ).toEqual([
      { uniqueId: "D93C043F-5B46-4213-B7A6-B6D082A5FAEE", displayId: 1, primary: true },
      { uniqueId: "derived-second-display", displayId: 2, primary: false },
    ]);
    expect(log.messages).toEqual([]);
  });

  test("DERIVED empty displays is a valid empty listing", () => {
    const derived = loadDerivedCapture();
    derived.result.displays = [];
    const log = new FakeLogger();
    expect(parseDevicectlDisplayInfo(JSON.stringify(derived), log)).toMatchObject({
      kind: "ok",
      displays: [],
    });
    expect(log.messages).toEqual([]);
  });

  test("DERIVED missing optional display and top-level fields are tolerated", () => {
    const derived = loadDerivedCapture();
    derived.result.displays = [{ uniqueId: "D93C043F-5B46-4213-B7A6-B6D082A5FAEE", displayId: 1 }];
    delete derived.result.backlightState;
    delete derived.result.orientation;
    delete derived.info.jsonVersion;
    delete derived.info.version;
    const log = new FakeLogger();
    const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") {
      throw new Error("Expected derived display listing");
    }
    for (const [field, value] of Object.entries(parsed.displays[0])) {
      if (field !== "uniqueId" && field !== "displayId") {
        expect(value).toBeUndefined();
      }
    }
    expect(parsed.backlightState).toBeUndefined();
    expect(parsed.orientation).toBeUndefined();
    expect(parsed.jsonVersion).toBeUndefined();
    expect(parsed.version).toBeUndefined();
    expect(log.messages).toEqual([]);
  });

  for (const [field, value] of [
    ["pointScale", "3"],
    ["pointScale", 1e400],
    ["primary", "true"],
    ["name", 1],
    ["backlightState", {}],
    ["currentOrientation", false],
    ["nativeOrientation", []],
    ["chromeIdentifier", null],
    ["framebufferMaskIdentifier", 1],
    ["nativeSize", [1206, "2622"]],
    ["physicalSize", [1]],
    ["bounds", [0, 0, 1206, 2622]],
    [
      "bounds",
      [
        [0, "0"],
        [1206, 2622],
      ],
    ],
    ["type", "integrated"],
    ["type", {}],
    ["type", { integrated: {}, external: {} }],
    ["type", { integrated: null }],
  ] as const) {
    test(`DERIVED malformed optional ${field} = ${JSON.stringify(value)} is undefined`, () => {
      const derived = loadDerivedCapture();
      derived.result.displays[0][field] = value;
      const log = new FakeLogger();
      const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") {
        throw new Error("Expected derived display listing");
      }
      const displayField = field === "type" ? "typeKind" : field;
      expect(parsed.displays[0][displayField]).toBeUndefined();
      expect(log.messages).toEqual([]);
    });
  }

  test("DERIVED malformed optional metadata and orientation members are undefined", () => {
    const derived = loadDerivedCapture();
    Object.assign(derived.info, { jsonVersion: "5", version: 651 });
    Object.assign(derived.result, {
      backlightState: false,
      orientation: {
        currentDeviceNonFlatOrientation: 1,
        currentDeviceOrientation: [],
        currentDeviceOrientationLocked: "false",
      },
    });
    const log = new FakeLogger();
    const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") {
      throw new Error("Expected derived display listing");
    }
    expect(parsed.jsonVersion).toBeUndefined();
    expect(parsed.version).toBeUndefined();
    expect(parsed.backlightState).toBeUndefined();
    expect(parsed.orientation?.currentDeviceNonFlatOrientation).toBeUndefined();
    expect(parsed.orientation?.currentDeviceOrientation).toBeUndefined();
    expect(parsed.orientation?.currentDeviceOrientationLocked).toBeUndefined();
    derived.result.orientation = "portrait";
    const badBlock = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
    expect(badBlock.kind).toBe("ok");
    if (badBlock.kind !== "ok") {
      throw new Error("Expected derived display listing");
    }
    expect(badBlock.orientation).toBeUndefined();
    expect(log.messages).toEqual([]);
  });

  const badShapes: Array<[string, (capture: DerivedDisplayCapture) => void]> = [
    [
      "missing info",
      (capture) => {
        Reflect.deleteProperty(capture, "info");
      },
    ],
    [
      "missing outcome",
      (capture) => {
        delete capture.info.outcome;
      },
    ],
    [
      "non-string outcome",
      (capture) => {
        capture.info.outcome = 1;
      },
    ],
    [
      "wrong command type",
      (capture) => {
        capture.info.commandType = "devicectl.device.info.apps";
      },
    ],
    [
      "missing command type",
      (capture) => {
        delete capture.info.commandType;
      },
    ],
    [
      "missing result",
      (capture) => {
        Reflect.deleteProperty(capture, "result");
      },
    ],
    [
      "non-object result",
      (capture) => {
        Object.assign(capture, { result: null });
      },
    ],
    [
      "missing displays",
      (capture) => {
        Reflect.deleteProperty(capture.result, "displays");
      },
    ],
    [
      "non-array displays",
      (capture) => {
        Object.assign(capture.result, { displays: {} });
      },
    ],
    [
      "non-object display",
      (capture) => {
        Object.assign(capture.result.displays, { 0: null });
      },
    ],
    [
      "missing uniqueId",
      (capture) => {
        delete capture.result.displays[0].uniqueId;
      },
    ],
    [
      "empty uniqueId",
      (capture) => {
        capture.result.displays[0].uniqueId = "";
      },
    ],
    [
      "non-string uniqueId",
      (capture) => {
        capture.result.displays[0].uniqueId = 1;
      },
    ],
    [
      "missing displayId",
      (capture) => {
        delete capture.result.displays[0].displayId;
      },
    ],
    [
      "non-number displayId",
      (capture) => {
        capture.result.displays[0].displayId = "1";
      },
    ],
    [
      "non-finite displayId",
      (capture) => {
        capture.result.displays[0].displayId = 1e400;
      },
    ],
    [
      "invalid second display",
      (capture) => {
        capture.result.displays.push({ displayId: 2 });
      },
    ],
  ];
  for (const [name, mutate] of badShapes) {
    test(`DERIVED ${name} rejects the whole listing and warns`, () => {
      const derived = loadDerivedCapture();
      mutate(derived);
      const log = new FakeLogger();
      const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
      expect(parsed).toMatchObject({ kind: "failed", reason: "unexpected-shape" });
      if (parsed.kind !== "failed") {
        throw new Error("Expected derived failure");
      }
      expect(parsed.message.length).toBeGreaterThan(0);
      expect(log.at("warn")).toHaveLength(1);
      expect(log.at("warn")[0].message).toContain(parsed.message);
    });
  }

  test("DERIVED failed outcome without an error envelope still returns a logged command failure", () => {
    const derived = loadDerivedCapture();
    derived.info.outcome = "failed";
    const log = new FakeLogger();
    const parsed = parseDevicectlDisplayInfo(JSON.stringify(derived), log);
    expect(parsed).toMatchObject({ kind: "failed", reason: "command-failed" });
    if (parsed.kind !== "failed") {
      throw new Error("Expected derived failure");
    }
    expect(parsed.coreDeviceError).toBeUndefined();
    expect(log.at("warn")).toHaveLength(1);
    expect(log.at("warn")[0].message).toContain(parsed.message);
  });
});

describe("invalid display info text inputs (not captures)", () => {
  for (const [input, reason] of [
    ["not JSON", "invalid-json"],
    ["", "invalid-json"],
    ["[]", "unexpected-shape"],
    ["null", "unexpected-shape"],
    ["1", "unexpected-shape"],
  ] as const) {
    test(`invalid text ${JSON.stringify(input)} returns ${reason} and warns`, () => {
      const log = new FakeLogger();
      const parsed = parseDevicectlDisplayInfo(input, log);
      expect(parsed).toMatchObject({ kind: "failed", reason });
      if (parsed.kind !== "failed") {
        throw new Error("Expected text failure");
      }
      expect(parsed.message.length).toBeGreaterThan(0);
      expect(log.at("warn")).toHaveLength(1);
      expect(log.at("warn")[0].message).toContain(parsed.message);
      if (reason === "invalid-json") {
        expect(log.at("warn")[0].args[0]).toBeInstanceOf(SyntaxError);
      }
    });
  }
});
