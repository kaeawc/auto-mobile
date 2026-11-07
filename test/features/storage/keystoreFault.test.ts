import { describe, expect, test } from "bun:test";
import {
  AdbKeystoreFaultClient,
  buildFaultCommand,
  validateKeystoreFaultRequest,
} from "../../../src/features/storage/keystoreFault";
import type { AdbCommandRunner } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../../src/models";

class FakeContentCallAdb implements AdbCommandRunner {
  readonly commands: string[] = [];
  constructor(private readonly reply: () => Promise<Pick<ExecResult, "stdout" | "stderr">>) {}
  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const { stdout, stderr } = await this.reply();
    return {
      stdout,
      stderr,
      toString: () => stdout,
      trim: () => stdout.trim(),
      includes: (s) => stdout.includes(s),
    };
  }
}

const bundle = (json: object) => ({
  stdout: `Result: Bundle[{result=${JSON.stringify(json)}}]\n`,
  stderr: "",
});
const ok = {
  schemaVersion: 1,
  capability: "storage.keystore",
  bridgeAvailable: true,
  requestedScope: "login",
  requestedKind: "DELAY",
  outcome: "ok",
};

describe("validateKeystoreFaultRequest", () => {
  test("blank selectors are EMPTY_SELECTOR for both methods", () => {
    for (const method of ["injectFault", "clearFaults"] as const) {
      expect(validateKeystoreFaultRequest(method, { scope: " ", kind: "DELAY" })).toMatchObject({
        outcome: "invalid_selector",
        reason: "EMPTY_SELECTOR",
        bridgeAvailable: true,
      });
    }
  });

  test("unknown or missing kinds and out-of-range delays are INVALID_FAULT", () => {
    const invalid = [
      { scope: "login" },
      { scope: "login", kind: "delay" },
      { scope: "login", kind: "DELAY" },
      { scope: "login", kind: "DELAY", delayMs: 0 },
      { scope: "login", kind: "DELAY", delayMs: 10_001 },
      { scope: "login", kind: "DELAY", delayMs: 1.5 },
    ];
    for (const request of invalid) {
      expect(validateKeystoreFaultRequest("injectFault", request)?.reason).toBe("INVALID_FAULT");
    }
  });

  test("valid requests pass, and clearFaults needs only a selector", () => {
    expect(
      validateKeystoreFaultRequest("injectFault", {
        alias: "token",
        kind: "DELAY",
        delayMs: 10_000,
      }),
    ).toBeNull();
    expect(
      validateKeystoreFaultRequest("injectFault", { scope: "login", kind: "PROVIDER_EXCEPTION" }),
    ).toBeNull();
    expect(validateKeystoreFaultRequest("clearFaults", { scope: "login" })).toBeNull();
    expect(
      validateKeystoreFaultRequest("injectFault", {
        alias: "token",
        kind: "STRONGBOX_UNAVAILABLE",
      }),
    ).toBeNull();
  });
});

describe("buildFaultCommand", () => {
  test("quotes every value and sends delayMs as a long", () => {
    expect(
      buildFaultCommand("com.example", "injectFault", {
        scope: "login",
        alias: "a b",
        kind: "DELAY",
        delayMs: 250,
      }),
    ).toBe(
      "shell content call --uri 'content://com.example.automobile.keystore' --method injectFault" +
        " --extra scope:s:'login' --extra alias:s:'a b' --extra kind:s:'DELAY' --extra delayMs:l:'250'",
    );
  });

  test("clearFaults sends only selectors", () => {
    expect(
      buildFaultCommand("com.example", "clearFaults", {
        scope: "login",
        kind: "DELAY",
        delayMs: 1,
      }),
    ).toBe(
      "shell content call --uri 'content://com.example.automobile.keystore' --method clearFaults --extra scope:s:'login'",
    );
  });
});

describe("AdbKeystoreFaultClient", () => {
  test("returns the provider envelope and strips unknown fields", async () => {
    const adb = new FakeContentCallAdb(async () => bundle({ ...ok, secret: "key" }));
    const result = await new AdbKeystoreFaultClient(adb).updateKeystoreFaults(
      "com.example",
      "injectFault",
      { scope: "login", kind: "DELAY", delayMs: 5 },
    );
    expect(result).toEqual(ok as typeof result);
    expect(adb.commands).toHaveLength(1);
  });

  test("passes provider refusals through unchanged", async () => {
    const refusal = { ...ok, outcome: "authorization_denied", reason: "MUTATION_NOT_ALLOWED" };
    const adb = new FakeContentCallAdb(async () => bundle(refusal));
    const result = await new AdbKeystoreFaultClient(adb).updateKeystoreFaults(
      "com.example",
      "clearFaults",
      { scope: "login" },
    );
    expect(result).toMatchObject({
      outcome: "authorization_denied",
      reason: "MUTATION_NOT_ALLOWED",
    });
  });

  test("a missing provider is BRIDGE_NOT_INSTALLED", async () => {
    const adb = new FakeContentCallAdb(async () => ({
      stdout: "",
      stderr:
        "Error while accessing provider:com.example.automobile.keystore\njava.lang.IllegalArgumentException: Unknown authority com.example.automobile.keystore",
    }));
    const result = await new AdbKeystoreFaultClient(adb).updateKeystoreFaults(
      "com.example",
      "clearFaults",
      { alias: "token" },
    );
    expect(result).toMatchObject({
      outcome: "unavailable",
      reason: "BRIDGE_NOT_INSTALLED",
      bridgeAvailable: false,
      requestedAlias: "token",
    });
  });

  test("a transport failure or unparseable reply is BRIDGE_UNAVAILABLE", async () => {
    const failures = [
      async () => {
        throw new Error("device offline");
      },
      async () => ({ stdout: "Result: Bundle[{result={not json}}]", stderr: "" }),
      async () => ({ stdout: "Result: null", stderr: "" }),
    ];
    for (const reply of failures) {
      const result = await new AdbKeystoreFaultClient(
        new FakeContentCallAdb(reply),
      ).updateKeystoreFaults("com.example", "clearFaults", { scope: "login" });
      expect(result).toMatchObject({ outcome: "unavailable", reason: "BRIDGE_UNAVAILABLE" });
    }
  });
});
