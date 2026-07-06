import { describe, expect, test } from "bun:test";
import { getCliHelpParameterInfo, getCliHelpSchemaShape, rejectRemovedDoctorInstallFlags } from "../../src/cli";
import { launchAppSchema } from "../../src/server/appTools";

describe("getCliHelpSchemaShape", () => {
  test("unwraps aliased preprocess schemas for CLI parameter help", () => {
    const shape = getCliHelpSchemaShape(launchAppSchema);

    expect(shape).toBeDefined();
    expect(shape?.appId).toBeDefined();
    expect(shape?.clearAppData).toBeDefined();
    expect(shape?.coldBoot).toBeDefined();

    expect(getCliHelpParameterInfo(shape?.appId)).toMatchObject({
      isOptional: false,
      typeName: "string",
    });
    expect(getCliHelpParameterInfo(shape?.clearAppData)).toMatchObject({
      isOptional: true,
      typeName: "boolean",
      description: "Clear app data before launch (default false)",
    });
  });
});

describe("rejectRemovedDoctorInstallFlags", () => {
  test("rejects removed install flags before doctor params reach a daemon", () => {
    expect(() => rejectRemovedDoctorInstallFlags({
      android: true,
      json: true,
      installCmdlineTools: true,
      installXcodeCommandLineTools: true,
    })).toThrow("--install-cmdline-tools, --install-xcode-command-line-tools were removed");
  });

  test("allows read-only doctor params", () => {
    expect(() => rejectRemovedDoctorInstallFlags({
      android: true,
      json: true,
    })).not.toThrow();
  });
});
