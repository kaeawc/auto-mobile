import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

// Issue #6584: getScreenSize's LCD-section parser must not mix width/height
// from one `simctl io enumerate` section with uiScale from another section.
describe("SimCtlClient getScreenSize", () => {
  const device: BootedDevice = {
    deviceId: "ios-device-screensize",
    name: "iOS Device",
    platform: "ios",
    source: "local",
  };

  test("does not mix Pixel Size and Preferred UI Scale across separate sections", async () => {
    // Synthetic multi-section output: the first Integrated screen section only
    // reports Pixel Size, and a second, unrelated section only reports
    // Preferred UI Scale. A naive parser that never resets its accumulators
    // between sections would combine the two into {828/3, 1792/3} = {276, 597}.
    const stdout = [
      "== Devices ==",
      "-- iPhone --",
      "Class: Display",
      "Screen Type: Integrated",
      "LCD:",
      "  Pixel Size: {828, 1792}",
      "Port: com.apple.iphonesimulator.lcd-1",
      "Class: Display",
      "Screen Type: Integrated",
      "LCD:",
      "  Preferred UI Scale: 3",
      "Port: com.apple.iphonesimulator.lcd-2",
    ].join("\n");

    const execAsync = async () => createExecResult(stdout, "");
    const simctl = new SimCtlClient(device, execAsync);

    // Neither section has both fields, so the fix should refuse to combine
    // them and throw rather than silently returning a mismatched size.
    await expect(simctl.getScreenSize()).rejects.toThrow(
      "Unable to determine screen size from provided data.",
    );
  });

  test("uses the first complete section and ignores a later, differently-scaled section", async () => {
    const stdout = [
      "== Devices ==",
      "-- iPhone --",
      "Class: Display",
      "Screen Type: Integrated",
      "LCD:",
      "  Pixel Size: {828, 1792}",
      "  Preferred UI Scale: 2",
      "Port: com.apple.iphonesimulator.lcd-1",
      "Class: Display",
      "Screen Type: Integrated",
      "LCD:",
      "  Pixel Size: {1242, 2688}",
      "  Preferred UI Scale: 3",
      "Port: com.apple.iphonesimulator.lcd-2",
    ].join("\n");

    const execAsync = async () => createExecResult(stdout, "");
    const simctl = new SimCtlClient(device, execAsync);

    const size = await simctl.getScreenSize();

    expect(size).toEqual({ width: 414, height: 896 });
  });

  test("still returns a valid size for a single well-formed section", async () => {
    const stdout = [
      "Class: Display",
      "Screen Type: Integrated",
      "LCD:",
      "  Pixel Size: {1179, 2556}",
      "  Preferred UI Scale: 3",
      "Port: com.apple.iphonesimulator.lcd-1",
    ].join("\n");

    const execAsync = async () => createExecResult(stdout, "");
    const simctl = new SimCtlClient(device, execAsync);

    const size = await simctl.getScreenSize();

    expect(size).toEqual({ width: 393, height: 852 });
  });
});
