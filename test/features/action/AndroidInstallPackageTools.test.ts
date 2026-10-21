import { describe, expect, test } from "bun:test";
import { AndroidInstallPackageTools } from "../../../src/features/action/AndroidInstallPackageTools";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";

describe("Android install artifact identity cancellation", () => {
  test("aapt metadata execution receives the lookup abort signal", async () => {
    const tools = new FakeAndroidBuildToolsLocator();
    tools.setTool({ tool: "aapt2", path: "/sdk/aapt2" });
    const host = new FakeHostCommandExecutor();
    const stdout = "package: name='com.example' versionCode='1'";
    host.setDefaultResponse({
      stdout,
      stderr: "",
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (value) => stdout.includes(value),
    });
    const packages = new AndroidInstallPackageTools(new FakeAdbExecutor(), tools, host);
    const signal = new AbortController().signal;
    expect(await packages.extractPackageName("/app.apk", signal)).toEqual({
      packageName: "com.example",
    });
    expect(host.getExecutedCalls()).toEqual([
      { command: "/sdk/aapt2", args: ["dump", "badging", "/app.apk"], options: { signal } },
    ]);
  });

  test("an already cancelled lookup never executes aapt", async () => {
    const tools = new FakeAndroidBuildToolsLocator();
    const host = new FakeHostCommandExecutor();
    const packages = new AndroidInstallPackageTools(new FakeAdbExecutor(), tools, host);
    const controller = new AbortController();
    controller.abort();
    await expect(packages.extractPackageName("/app.apk", controller.signal)).rejects.toThrow();
    expect(host.getExecutedCalls()).toEqual([]);
  });
});
