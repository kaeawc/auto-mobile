import { describe, expect, test } from "bun:test";

const UNIT_TESTS = ["test/daemon/clientNotifications.test.ts"];

describe("test lane selection", () => {
  test("keeps hermetic tests out of the integration command and unit exclusions", async () => {
    const packageJson = await Bun.file("package.json").json();
    const unitScript = await Bun.file("scripts/test-unit.sh").text();
    const integrationCommand = packageJson.scripts["test:integration"] as string;

    expect(integrationCommand).not.toContain("test/daemon/daemonClient*.test.ts");
    for (const testPath of UNIT_TESTS) {
      expect(integrationCommand).not.toContain(testPath);
      expect(unitScript).not.toContain(testPath);
    }
  });
});
