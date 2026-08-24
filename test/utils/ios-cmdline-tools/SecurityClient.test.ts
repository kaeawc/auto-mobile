import { describe, expect, test } from "bun:test";
import { createExecResult } from "../../../src/utils/execResult";
import { SecurityClient } from "../../../src/utils/ios-cmdline-tools/SecurityClient";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("SecurityClient", () => {
  test("uses argv for signing identity lookup and parses identities", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async (file, args) => {
        calls.push({ file, args });
        return createExecResult(
          '  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 "Apple Development: Test"\n     1 valid identities found',
          "",
        );
      },
    });

    await expect(client.listCodeSigningIdentities()).resolves.toEqual([
      { fingerprint: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", name: "Apple Development: Test" },
    ]);
    expect(calls).toEqual([
      { file: "security", args: ["find-identity", "-v", "-p", "codesigning"] },
    ]);
  });

  test("returns no identities when the keychain has none", async () => {
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async () => createExecResult("  0 valid identities found", ""),
    });

    await expect(client.listCodeSigningIdentities()).resolves.toEqual([]);
  });

  test("uses the successful help command for availability diagnostics", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async (file, args) => {
        calls.push({ file, args });
        return createExecResult("security commands", "");
      },
    });

    await expect(client.getDiagnostics({ timeoutMs: 1234 })).resolves.toEqual({
      available: true,
      version: null,
    });
    expect(calls).toEqual([{ file: "security", args: ["help"] }]);
  });

  test("decodes CMS with the profile path as one argv value", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const profilePath = "/tmp/a profile; $(not-a-command).mobileprovision";
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async (file, args) => {
        calls.push({ file, args });
        return createExecResult("<plist />", "");
      },
    });

    await expect(client.decodeCms(profilePath)).resolves.toBe("<plist />");
    expect(calls).toEqual([{ file: "security", args: ["cms", "-D", "-i", profilePath] }]);
  });

  test("maps keychain failures to an actionable error without leaking command output", async () => {
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async () => {
        throw new Error("User interaction is not allowed. secret-keychain-detail");
      },
    });

    await expect(client.listCodeSigningIdentities()).rejects.toThrow("Unlock the login keychain");
    await expect(client.listCodeSigningIdentities()).rejects.not.toThrow("secret-keychain-detail");
  });

  test("aborts the child when CMS decoding times out", async () => {
    const timer = new FakeTimer();
    let signal: AbortSignal | undefined;
    let killSignal: NodeJS.Signals | undefined;
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async (_file, _args, options) => {
        signal = options?.signal;
        killSignal = options?.killSignal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      },
      timer,
    });

    const decoding = client.decodeCms("/tmp/profile.mobileprovision", { timeoutMs: 1234 });
    timer.advanceTime(1234);

    await expect(decoding).rejects.toThrow("Security CMS decoding timed out after 1234ms");
    expect(signal?.aborted).toBe(true);
    expect(killSignal).toBe("SIGKILL");
  });

  test("does not execute when cancelled before the command starts", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async () => {
        calls += 1;
        return createExecResult("", "");
      },
    });

    await expect(
      client.decodeCms("/tmp/profile.mobileprovision", { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
  });

  test("aborts the child when cancelled during CMS decoding", async () => {
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const client = new SecurityClient({
      platform: () => "darwin",
      execute: async (_file, _args, options) => {
        childSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          childSignal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      },
    });

    const decoding = client.decodeCms("/tmp/profile.mobileprovision", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(decoding).rejects.toThrow("Security CMS decoding was cancelled");
    expect(childSignal?.aborted).toBe(true);
  });
});
