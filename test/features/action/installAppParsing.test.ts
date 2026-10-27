import { describe, expect, test } from "bun:test";
import {
  diffInstalledPackages,
  extractInstallErrorText,
} from "../../../src/features/action/installAppParsing";

describe("install app parsing", () => {
  test("keeps message and string command streams in diagnostic order", () => {
    class InstallFailure extends Error {
      stderr = "stderr";
      stdout = "stdout";
    }
    const withStreams = new InstallFailure("install failed");
    expect(extractInstallErrorText(withStreams)).toBe("install failed\nstderr\nstdout");
    expect(extractInstallErrorText("tool failed")).toBe("tool failed");
  });

  test("returns only added packages in sorted order without changing inputs", () => {
    const before = new Set(["existing", "removed"]);
    const after = new Set(["z.new", "existing", "a.new"]);
    expect(diffInstalledPackages(before, after)).toEqual(["a.new", "z.new"]);
    expect([...before]).toEqual(["existing", "removed"]);
    expect([...after]).toEqual(["z.new", "existing", "a.new"]);
  });
});
