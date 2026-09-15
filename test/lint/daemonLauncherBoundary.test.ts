import { describe, expect, test } from "bun:test";
import { repositoryPath } from "../../scripts/check-daemon-launcher-boundary";

describe("daemon launcher boundary", () => {
  test("normalizes Windows separators before applying the owner exemption", () => {
    expect(repositoryPath("src\\daemon\\DaemonLauncher.ts")).toBe("src/daemon/DaemonLauncher.ts");
  });
});
