import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

const duoEnumerate = readFileSync(
  join(import.meta.dir, "../../fixtures/duo-enumerate.txt"),
  "utf8",
);
const withoutInnerScreen = duoEnumerate.replace(
  /    \(3\) LCD-1:\n[\s\S]*?(?=    \(5\) Resizable:)/,
  "",
);

// Issue #6584: fields from separate Connected Screens entries must not mix.
describe("SimCtlClient getScreenSize", () => {
  const device: BootedDevice = {
    deviceId: "ios-device-screensize",
    name: "iOS Device",
    platform: "ios",
    source: "local",
  };
  const client = (stdout: string) =>
    new SimCtlClient(device, async () => createExecResult(stdout, ""));

  test("does not mix Pixel Size and Preferred UI Scale across screens", async () => {
    const stdout = duoEnumerate
      .replace("        Preferred UI Scale: 3\n", "")
      .replace("        Pixel Size: {2007, 2853}\n", "");
    await expect(client(stdout).getScreenSize()).rejects.toThrow(
      "Unable to determine screen size from provided data.",
    );
  });

  test("uses the first complete Integrated screen", async () => {
    await expect(client(duoEnumerate).getScreenSize()).resolves.toEqual({
      width: 466,
      height: 678,
    });
  });

  test("uses a later complete screen if the first is missing its UI scale", async () => {
    const stdout = duoEnumerate.replace("        Preferred UI Scale: 3\n", "");
    await expect(client(stdout).getScreenSize()).resolves.toEqual({
      width: 669,
      height: 951,
    });
  });

  test("uses the single Integrated screen when LCD-1 is absent", async () => {
    expect(withoutInnerScreen).not.toBe(duoEnumerate);
    await expect(client(withoutInnerScreen).getScreenSize()).resolves.toEqual({
      width: 466,
      height: 678,
    });
  });

  test("finishes the final Connected Screens entry at EOF", async () => {
    const stdout = duoEnumerate.slice(0, duoEnumerate.indexOf("    (2) TVOut:"));
    await expect(client(stdout).getScreenSize()).resolves.toEqual({
      width: 466,
      height: 678,
    });
  });
});
