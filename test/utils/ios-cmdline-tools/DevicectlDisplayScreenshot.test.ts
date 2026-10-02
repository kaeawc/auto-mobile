import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import type { CoreDeviceCapabilityResult } from "../../../src/utils/ios-cmdline-tools/CoreDeviceCapabilityProbe";
import {
  buildDevicectlDisplayScreenshotArgs,
  chooseSimulatorPanelScreenshotTransport,
} from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayScreenshot";
import { FakeSimulatorDisplayScreenshotCapture } from "../../fakes/FakeSimulatorDisplayScreenshotCapture";

const captureHelp = readFileSync(
  join(process.cwd(), "test/fixtures/ios-devicectl/capture-screenshot-help.txt"),
  "utf8",
);
const unsupportedCapabilities: CoreDeviceCapabilityResult[] = [
  { kind: "unsupported", reason: "Screenshot capability is unsupported" },
  { kind: "unavailable", reason: "CoreDevice version is unavailable" },
  { kind: "blocked", warning: "Selected developer directory is older than installed CoreDevice" },
  {
    kind: "notBooted",
    error: new ActionableError(
      "Simulator sim-1 is shut down. Boot it before running capture screenshot.",
    ),
  },
  { kind: "failed", message: "Screenshot capability check failed" },
];
const capabilities: CoreDeviceCapabilityResult[] = [
  { kind: "supported" },
  ...unsupportedCapabilities,
];

describe("buildDevicectlDisplayScreenshotArgs", () => {
  test("builds exact xcrun argv for the primary display", () => {
    expect(
      buildDevicectlDisplayScreenshotArgs({
        deviceId: "sim-1",
        destination: "/tmp/screen shot.png",
      }),
    ).toEqual([
      "devicectl",
      "device",
      "capture",
      "screenshot",
      "--device",
      "sim-1",
      "--destination",
      "/tmp/screen shot.png",
    ]);
  });

  test("builds exact xcrun argv with a display unique ID and a case-insensitive PNG extension", () => {
    expect(
      buildDevicectlDisplayScreenshotArgs({
        deviceId: "sim-1",
        destination: "/tmp/panel.PNG",
        displayUniqueId: "outer-display-id",
      }),
    ).toEqual([
      "devicectl",
      "device",
      "capture",
      "screenshot",
      "--device",
      "sim-1",
      "--destination",
      "/tmp/panel.PNG",
      "--display-unique-id",
      "outer-display-id",
    ]);
  });

  test.each(["", "-", "--device"])("rejects invalid device ID %j", (deviceId) => {
    expect(() =>
      buildDevicectlDisplayScreenshotArgs({ deviceId, destination: "/tmp/panel.png" }),
    ).toThrow(ActionableError);
  });

  test.each(["", "-", "--quiet"])("rejects invalid display unique ID %j", (displayUniqueId) => {
    expect(() =>
      buildDevicectlDisplayScreenshotArgs({
        deviceId: "sim-1",
        destination: "/tmp/panel.png",
        displayUniqueId,
      }),
    ).toThrow(ActionableError);
  });

  test.each(["", "/tmp/panel", "/tmp/panel.jpg", "/tmp/panel.png.bak", "/tmp/panel.png/"])(
    "rejects a destination without a PNG extension: %j",
    (destination) => {
      expect(() => buildDevicectlDisplayScreenshotArgs({ deviceId: "sim-1", destination })).toThrow(
        ActionableError,
      );
    },
  );

  test("anchors every emitted flag to the captured screenshot help", () => {
    const usage = captureHelp.split("\n").find((line) => line.startsWith("USAGE:"));
    expect(usage).toBeDefined();
    for (const flag of ["--device", "--destination", "--display-unique-id"]) {
      expect(usage).toContain(flag);
    }
    const args = buildDevicectlDisplayScreenshotArgs({
      deviceId: "sim-1",
      destination: "/tmp/panel.png",
      displayUniqueId: "outer-display-id",
    });
    for (const flag of args.filter((arg) => arg.startsWith("--"))) {
      expect(captureHelp).toContain(flag);
    }
  });
});

describe("chooseSimulatorPanelScreenshotTransport", () => {
  test.each(capabilities)(
    "keeps single-display capture on simctl with capability %j",
    (capability) => {
      for (const panelCount of [0, 1]) {
        for (const displayUniqueId of [undefined, "", "outer-display-id"]) {
          expect(
            chooseSimulatorPanelScreenshotTransport({
              panelCount,
              panelKey: "Main",
              displayUniqueId,
              capability,
            }),
          ).toEqual({ kind: "simctl", display: "Main", reason: "single-display" });
        }
      }
    },
  );

  test("selects devicectl for a supported multi-display simulator with a unique ID", () => {
    expect(
      chooseSimulatorPanelScreenshotTransport({
        panelCount: 2,
        panelKey: "Outer",
        displayUniqueId: "outer-display-id",
        capability: { kind: "supported" },
      }),
    ).toEqual({ kind: "devicectl", displayUniqueId: "outer-display-id" });
  });

  test.each([undefined, ""])(
    "falls back to the panel name when the unique ID is %j",
    (displayUniqueId) => {
      expect(
        chooseSimulatorPanelScreenshotTransport({
          panelCount: 2,
          panelKey: "Outer",
          displayUniqueId,
          capability: { kind: "supported" },
        }),
      ).toEqual({ kind: "simctl", display: "Outer", reason: "no-unique-id" });
    },
  );

  test.each(unsupportedCapabilities)(
    "falls back to the panel name for capability %j",
    (capability) => {
      for (const displayUniqueId of [undefined, "", "outer-display-id"]) {
        expect(
          chooseSimulatorPanelScreenshotTransport({
            panelCount: 2,
            panelKey: "Outer",
            displayUniqueId,
            capability,
          }),
        ).toEqual({ kind: "simctl", display: "Outer", reason: "coredevice-unsupported" });
      }
    },
  );
});

describe("FakeSimulatorDisplayScreenshotCapture", () => {
  test("records options including the signal and returns the configured buffer", async () => {
    const capture = new FakeSimulatorDisplayScreenshotCapture();
    const options = {
      deviceId: "sim-1",
      displayUniqueId: "outer-display-id",
      signal: new AbortController().signal,
    };
    capture.result = Buffer.from("configured screenshot bytes");
    expect(await capture.capture(options)).toBe(capture.result);
    expect(capture.calls).toEqual([options]);
    expect(capture.calls[0].signal).toBe(options.signal);
  });

  test("records calls even when rejecting with the configured error", async () => {
    const capture = new FakeSimulatorDisplayScreenshotCapture();
    const options = { deviceId: "sim-1", displayUniqueId: "outer-display-id" };
    capture.failure = new ActionableError("Capture failed");
    await expect(capture.capture(options)).rejects.toBe(capture.failure);
    expect(capture.calls).toEqual([options]);
  });
});
