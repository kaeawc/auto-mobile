import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import {
  AppBundleMetadataClient,
  type CodesignExecutor,
  type EntitlementPlistReader,
} from "../../../src/utils/ios-cmdline-tools/AppBundleMetadataClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

const associatedDomains = {
  "com.apple.developer.associated-domains": ["applinks:example.com"],
};

describe("AppBundleMetadataClient", () => {
  test("passes a special bundle path as one literal codesign argv member", async () => {
    const calls: Array<{ args: readonly string[]; signal?: AbortSignal }> = [];
    const executor: CodesignExecutor = {
      execute: async (args, signal) => {
        calls.push({ args, signal });
        return result("<plist/>");
      },
    };
    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };
    const client = new AppBundleMetadataClient(executor, plist);
    const path = "/tmp/My $(unsafe); app.app";

    await expect(
      client.readEntitlements({
        appBundlePath: path,
        deviceId: "SIM-UDID",
        bundleId: "com.example.app",
      }),
    ).resolves.toEqual(associatedDomains);

    expect(calls).toEqual([
      { args: ["-d", "--entitlements", ":-", path], signal: expect.any(AbortSignal) },
    ]);
  });

  test("parses signed entitlement metadata into typed values", async () => {
    const executor: CodesignExecutor = {
      execute: async () =>
        result(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.developer.associated-domains</key>
<array><string>applinks:example.com</string></array>
</dict></plist>`),
    };

    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };
    await expect(
      new AppBundleMetadataClient(executor, plist).readEntitlements({
        appBundlePath: "/tmp/Signed.app",
      }),
    ).resolves.toEqual(associatedDomains);
  });

  test("returns null for an unsigned bundle", async () => {
    const executor: CodesignExecutor = {
      execute: async () => {
        throw Object.assign(new Error("codesign exited unsuccessfully"), {
          stderr: "code object is not signed at all",
        });
      },
    };
    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };

    await expect(
      new AppBundleMetadataClient(executor, plist).readEntitlements({
        appBundlePath: "/tmp/Unsigned.app",
      }),
    ).resolves.toBeNull();
  });

  test("returns an actionable redacted error when codesign is unavailable", async () => {
    const executor: CodesignExecutor = {
      execute: async () => {
        throw new Error("spawn codesign ENOENT /tmp/secret.app");
      },
    };
    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };

    await expect(
      new AppBundleMetadataClient(executor, plist).readEntitlements({
        appBundlePath: "/tmp/secret.app",
      }),
    ).rejects.toThrow("Confirm Xcode command-line tools are installed");
  });

  test("redacts malformed entitlement output and artifact paths from errors", async () => {
    const executor: CodesignExecutor = { execute: async () => result("not a plist") };

    const malformedPlist: EntitlementPlistReader = {
      readJsonBytes: async () => {
        throw new Error("malformed");
      },
    };
    await expect(
      new AppBundleMetadataClient(executor, malformedPlist).readEntitlements({
        appBundlePath: "/tmp/secret.app",
      }),
    ).rejects.toThrow("Unable to parse app-bundle entitlements");
    await expect(
      new AppBundleMetadataClient(executor, malformedPlist).readEntitlements({
        appBundlePath: "/tmp/secret.app",
      }),
    ).rejects.not.toThrow("secret.app");
  });

  test("aborts the owned command when the timeout expires", async () => {
    const timer = new FakeTimer();
    let commandSignal: AbortSignal | undefined;
    const executor: CodesignExecutor = {
      execute: async (_args, signal) =>
        new Promise<ExecResult>((_resolve, reject) => {
          commandSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("child aborted")), {
            once: true,
          });
        }),
    };
    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };
    const promise = new AppBundleMetadataClient(executor, plist, timer).readEntitlements({
      appBundlePath: "/tmp/Slow.app",
      timeoutMs: 50,
    });

    timer.advanceTime(50);

    await expect(promise).rejects.toThrow("timed out after 50ms");
    expect(commandSignal?.aborted).toBe(true);
  });

  test("propagates caller cancellation to the owned command", async () => {
    const controller = new AbortController();
    let commandSignal: AbortSignal | undefined;
    const executor: CodesignExecutor = {
      execute: async (_args, signal) =>
        new Promise<ExecResult>((_resolve, reject) => {
          commandSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("child aborted")), {
            once: true,
          });
        }),
    };
    const plist: EntitlementPlistReader = { readJsonBytes: async () => associatedDomains };
    const promise = new AppBundleMetadataClient(executor, plist).readEntitlements({
      appBundlePath: "/tmp/Cancelled.app",
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow("cancelled");
    expect(commandSignal?.aborted).toBe(true);
  });
});
