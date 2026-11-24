import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ExecSeamOptions } from "../../../src/utils/ExecSeam";
import type { ExecFileAsync } from "../../../src/utils/HostCommandExecutor";
import {
  coreSimulatorJxaScript,
  resolveDeveloperDirectory,
  runCoreSimulatorJxa,
  type CoreSimulatorJxaRequest,
} from "../../../src/utils/ios-cmdline-tools/CoreSimulatorJxa";

const UDID = "FC885A06-01A2-48D1-A78E-8B7F433F6B90";
const DEVELOPER_DIR = "/Applications/Xcode-27.2.0.app/Contents/Developer";
const BODY = "return JSON.stringify({ value: Number(argv[2]) });";

function rig(stdout: string | Error) {
  const calls: Array<{ file: string; args: string[]; options?: ExecSeamOptions }> = [];
  const exec: ExecFileAsync = async (file, args, options) => {
    calls.push({ file, args, ...(options ? { options } : {}) });
    if (stdout instanceof Error) {
      throw stdout;
    }
    return { stdout, stderr: "" };
  };
  return { host: { exec, developerDirectory: async () => DEVELOPER_DIR }, calls };
}

function request(
  overrides: Partial<CoreSimulatorJxaRequest<{ value: number }>> = {},
): CoreSimulatorJxaRequest<{ value: number }> {
  return {
    udid: UDID,
    body: BODY,
    args: ["7"],
    requireBooted: true,
    timeoutMs: 15_000,
    resultSchema: z.object({ value: z.number() }).strict(),
    label: "probe",
    scriptPlaceholder: "<simulator probe>",
    describeFailure: (code) => `failed: ${code}`,
    ...overrides,
  };
}

describe("runCoreSimulatorJxa (#19110)", () => {
  test("runs osascript with the script, developer directory, UDID and body arguments", async () => {
    const { host, calls } = rig('{"value":7}\n');

    expect(await runCoreSimulatorJxa(request(), host)).toEqual({ value: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("osascript");
    expect(calls[0]!.args).toEqual([
      "-l",
      "JavaScript",
      "-e",
      coreSimulatorJxaScript(BODY, true),
      DEVELOPER_DIR,
      UDID,
      "7",
    ]);
    expect(calls[0]!.options?.timeout).toBe(15_000);
  });

  test("passes the abort signal to the process", async () => {
    const { host, calls } = rig('{"value":1}');
    const controller = new AbortController();

    await runCoreSimulatorJxa(request({ signal: controller.signal }), host);

    expect(calls[0]!.options?.signal).toBe(controller.signal);
  });

  test("the prelude passes null error out-parameters and never an NSError reference", () => {
    const script = coreSimulatorJxaScript(BODY, true);
    expect(script).toContain("sharedServiceContextForDeveloperDirError($(developerDir), null)");
    expect(script).toContain("defaultDeviceSetWithError(null)");
    expect(script).toContain("$.NSUUID.alloc.initWithUUIDString($(udid))");
    expect(script).not.toContain("Ref()");
    expect(script).toContain(BODY);
  });

  test("the booted check is in the prelude only when the call requires it", () => {
    const check =
      'if (Number(device.state) !== 3) return JSON.stringify({ error: "device-not-booted" });';
    expect(coreSimulatorJxaScript(BODY, true)).toContain(check);
    expect(coreSimulatorJxaScript(BODY, false)).not.toContain("device.state");
  });

  test.each(["private-api-unavailable", "device-not-found", "device-not-booted"])(
    "the prelude's %s code becomes the caller's message",
    async (code) => {
      const { host } = rig(JSON.stringify({ error: code }));

      const error = await runCoreSimulatorJxa(request(), host).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ActionableError);
      expect((error as Error).message).toBe(`failed: ${code}`);
    },
  );

  test("output matching neither contract is reported, not returned", async () => {
    const { host } = rig('{"value":"seven"}');

    await expect(runCoreSimulatorJxa(request(), host)).rejects.toThrow(
      `Simulator probe call on ${UDID} printed unexpected output: {"value":"seven"}`,
    );
    await expect(runCoreSimulatorJxa(request(), rig("Segmentation fault").host)).rejects.toThrow(
      "printed unexpected output: Segmentation fault",
    );
  });

  test("a failed osascript is an actionable error with its stderr, not the script", async () => {
    const failure = Object.assign(new Error("Command failed"), {
      stderr: "execution error: Error: boom (-2700)",
      code: 1,
    });

    const error = await runCoreSimulatorJxa(request(), rig(failure).host).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    const message = (error as Error).message;
    expect(message).toStartWith(`Simulator probe call failed on ${UDID}`);
    expect(message).not.toContain("ObjC.import");
  });

  test("a timed-out or aborted process is an actionable error", async () => {
    const killed = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

    await expect(runCoreSimulatorJxa(request(), rig(killed).host)).rejects.toBeInstanceOf(
      ActionableError,
    );
  });
});

describe("resolveDeveloperDirectory", () => {
  test("an Xcode .app DEVELOPER_DIR means its Contents/Developer", async () => {
    expect(
      await resolveDeveloperDirectory(
        { DEVELOPER_DIR: "/Applications/Xcode-27.2.0.app" },
        async (target) => target,
      ),
    ).toBe(DEVELOPER_DIR);
  });

  test("a Contents/Developer DEVELOPER_DIR is used as resolved", async () => {
    expect(await resolveDeveloperDirectory({ DEVELOPER_DIR }, async (target) => target)).toBe(
      DEVELOPER_DIR,
    );
  });

  test("without DEVELOPER_DIR the xcode-select link is resolved", async () => {
    expect(
      await resolveDeveloperDirectory({}, async (target) =>
        target === "/var/db/xcode_select_link" ? DEVELOPER_DIR : "unexpected",
      ),
    ).toBe(DEVELOPER_DIR);
  });
});
