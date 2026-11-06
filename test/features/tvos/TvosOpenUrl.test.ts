import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models";
import { assertTvosOpenLinkArgs, TvosOpenURL } from "../../../src/features/tvos/TvosOpenUrl";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const tv: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  deviceId: "5B7E1C3D-2A4F-4E6B-8C9D-1E2F3A4B5C6D",
  platform: "tvos",
};

describe("TvosOpenURL", () => {
  test("opens a custom-scheme link with simctl openurl on the Apple TV's UDID", async () => {
    const simctl = new FakeSimctl();
    const result = await new TvosOpenURL(tv, simctl).execute("  television://show/42  ");

    expect(result).toEqual({ success: true, url: "television://show/42" });
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      ["openurl", tv.deviceId, "television://show/42"],
    ]);
  });

  test("passes the URL as one argv element, byte for byte", async () => {
    const simctl = new FakeSimctl();
    const url = 'television://search?q=a b&x="$(id)"';
    await new TvosOpenURL(tv, simctl).execute(url);

    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toEqual([
      ["openurl", tv.deviceId, url],
    ]);
  });

  test("reports a simctl failure as an unsuccessful open naming the cause", async () => {
    const simctl = new FakeSimctl();
    simctl.setCommandArgsError(
      ["openurl", tv.deviceId, "nobody://x"],
      new Error("The operation couldn't be completed. (OSStatus error -10814.)"),
    );
    const result = await new TvosOpenURL(tv, simctl).execute("nobody://x");

    expect(result.success).toBe(false);
    expect(result.url).toBe("nobody://x");
    expect(result.error).toContain("OSStatus error -10814");
    expect(result.error).toContain("declares the URL scheme");
  });

  test("refuses an empty URL without calling simctl", async () => {
    const simctl = new FakeSimctl();
    const result = await new TvosOpenURL(tv, simctl).execute("   ");

    expect(result).toEqual({ success: false, url: "   ", error: "Invalid URL provided" });
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("refuses an Android package: URL and points to launchApp", async () => {
    const simctl = new FakeSimctl();
    const result = await new TvosOpenURL(tv, simctl).execute("package:com.example.television");

    expect(result.success).toBe(false);
    expect(result.error).toContain("launchApp");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("an aborted request rejects without opening the link", async () => {
    const simctl = new FakeSimctl();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new TvosOpenURL(tv, simctl).execute("television://x", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test("a request cancelled while simctl runs rejects instead of reporting a failure", async () => {
    const controller = new AbortController();
    class CancellingSimctl extends FakeSimctl {
      override async executeCommandArgs(args: string[]): Promise<ExecResult> {
        await Promise.resolve();
        controller.abort();
        throw new Error(`killed: ${args.join(" ")}`);
      }
    }

    await expect(
      new TvosOpenURL(tv, new CancellingSimctl()).execute("television://x", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

describe("assertTvosOpenLinkArgs", () => {
  test("accepts a plain link", () => {
    expect(() => assertTvosOpenLinkArgs({})).not.toThrow();
  });

  test("refuses every iOS- or Android-only option by name", () => {
    const refuse = () =>
      assertTvosOpenLinkArgs({
        waitFor: { text: "Episode 42" },
        settled: {},
        acceptOpenAlert: true,
        chooserAppPackage: "com.example",
      });

    expect(refuse).toThrow(ActionableError);
    expect(refuse).toThrow(
      "openLink does not support waitFor, settled, acceptOpenAlert, chooserAppPackage on tvOS",
    );
  });
});
