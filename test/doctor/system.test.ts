import { describe, expect, test } from "bun:test";
import {
  checkOperatingSystem,
  checkArchitecture,
  checkRuntime,
  runSystemChecks,
} from "../../src/doctor/checks/system";

describe("system doctor checks", () => {
  test("checkOperatingSystem returns pass with platform info", () => {
    const result = checkOperatingSystem();

    expect(result.name).toBe("Operating System");
    expect(result.status).toBe("pass");
    expect(result.value).toBe(process.platform);
    expect(result.message).toContain(process.platform);
  });

  test("checkArchitecture returns pass with arch info", () => {
    const result = checkArchitecture();

    expect(result.name).toBe("Architecture");
    expect(result.status).toBe("pass");
    expect(result.value).toBe(process.arch);
    expect(result.message).toBe(process.arch);
  });

  test("checkRuntime reports the Bun runtime when a Bun version is present", () => {
    const result = checkRuntime(() => "1.2.3");

    expect(result.name).toBe("Runtime");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Bun 1.2.3");
    expect(result.value).toBe("bun@1.2.3");
  });

  test("checkRuntime reports the Node.js runtime when no Bun version is present", () => {
    const result = checkRuntime(() => undefined);

    expect(result.name).toBe("Runtime");
    expect(result.status).toBe("pass");
    expect(result.message).toBe(`Node.js ${process.version}`);
    expect(result.value).toBe(`node@${process.version}`);
  });

  test("runSystemChecks returns all three checks", () => {
    const results = runSystemChecks();

    expect(results).toHaveLength(3);
    expect(results[0].name).toBe("Operating System");
    expect(results[1].name).toBe("Architecture");
    expect(results[2].name).toBe("Runtime");
    for (const result of results) {
      expect(result.status).toBe("pass");
    }
  });
});
