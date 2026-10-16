import { afterEach, describe, expect, test } from "bun:test";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";

describe("IosCtrlProxyBuilder.configure", () => {
  afterEach(() => {
    IosCtrlProxyBuilder.resetInstances();
  });

  test("overrides apply to the static policy readers", () => {
    IosCtrlProxyBuilder.configure({ useLocalBuild: true });
    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(true);

    IosCtrlProxyBuilder.configure({ useLocalBuild: false });
    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(false);
  });

  test("an explicit checksum is an escape hatch from the unverifiable-pin check", () => {
    IosCtrlProxyBuilder.configure({ expectedChecksum: "a".repeat(64) });
    expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false);
  });

  test("configure merges over the current settings instead of replacing them", () => {
    IosCtrlProxyBuilder.configure({ useLocalBuild: true });
    IosCtrlProxyBuilder.configure({ expectedChecksum: "b".repeat(64) });

    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(true);
    expect(IosCtrlProxyBuilder.isPinnedVersionUnverifiable()).toBe(false);
  });

  test("null and resetInstances both restore the defaults", () => {
    const envDriven = IosCtrlProxyBuilder.isLocalBuildModeEnabled();
    IosCtrlProxyBuilder.configure({ useLocalBuild: !envDriven });
    IosCtrlProxyBuilder.configure(null);
    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(envDriven);

    IosCtrlProxyBuilder.configure({ useLocalBuild: !envDriven });
    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(!envDriven);
    IosCtrlProxyBuilder.resetInstances();
    expect(IosCtrlProxyBuilder.isLocalBuildModeEnabled()).toBe(envDriven);
  });
});
