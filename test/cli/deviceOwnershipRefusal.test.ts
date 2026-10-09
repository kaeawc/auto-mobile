import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resetCliOutputSinksForTesting,
  resetDaemonProxyFactoryForTesting,
  runCliCommand,
  setCliOutputSinksForTesting,
  setDaemonProxyFactoryForTesting,
} from "../../src/cli";
import { cliDeviceOwnershipHint } from "../../src/cli/deviceOwnershipHint";
import { InputDeviceOwnedError, TOOL_CALL_REMEDY } from "../../src/daemon/inputDeviceOwnership";
import {
  DeviceCleanupInProgressError,
  DeviceOwnedByOtherDaemonError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { LIFECYCLE_TOOL_REMEDY } from "../../src/server/lifecycleDeviceOwnership";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { createTeardownFailureResponse } from "../../src/server/deviceTools";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../helpers/cliDataDirIsolation";

describe("cliDeviceOwnershipHint (#10743, #10783, #10785)", () => {
  test("returns undefined for failures that are not a held-device refusal", () => {
    expect(cliDeviceOwnershipHint({ error: "boom", code: "other" }, "tapOn")).toBeUndefined();
    expect(cliDeviceOwnershipHint(null, "tapOn")).toBeUndefined();
    expect(cliDeviceOwnershipHint("text", "tapOn")).toBeUndefined();
  });

  test("tells a device-aware tool's caller to pass --session-uuid", () => {
    const hint = cliDeviceOwnershipHint({ code: "device_owned_by_other_session" }, "tapOn");
    expect(hint).toContain("--session-uuid <uuid>");
    expect(hint).not.toContain("--force");
  });

  test("tells the caller to retry after a device's cleanup finishes (#10960)", () => {
    const hint = cliDeviceOwnershipHint({ code: "device_cleanup_in_progress" }, "startDevice");
    expect(hint).toContain("retryAfterMs");
    expect(hint).not.toContain("--session-uuid");
  });

  test("tells the caller another daemon holds the device (#10980)", () => {
    const hint = cliDeviceOwnershipHint({ code: "device_owned_by_other_daemon" }, "startDevice");
    expect(hint).toContain("another AutoMobile daemon");
    const result = shapeToolCallError(new DeviceOwnedByOtherDaemonError("emulator-5554", 4242), {
      toolName: "startDevice",
      source: "MCP",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "device_owned_by_other_daemon",
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  test("shapes the cleanup refusal with its code, retryable and retryAfterMs (#10960)", () => {
    const result = shapeToolCallError(new DeviceCleanupInProgressError("emulator-5554", 4_000), {
      toolName: "setActiveDevice",
      source: "MCP",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      code: "device_cleanup_in_progress",
      deviceId: "emulator-5554",
      retryable: true,
      retryAfterMs: 4_000,
    });
  });

  test("offers --force true only for the tools that accept it", () => {
    expect(
      cliDeviceOwnershipHint({ code: "device_owned_by_other_session" }, "killDevice"),
    ).toContain("--force true");
    expect(
      cliDeviceOwnershipHint(
        { failure: { code: "device_owned_by_other_session" } },
        "deleteDevice",
      ),
    ).toContain("--force true");
  });
});

describe("--cli surfaces a held-device refusal", () => {
  const originalProcessExit = process.exit;
  const originalConsoleError = console.error;
  let isolatedCliDataDir: IsolatedCliDataDir;
  let exitCodes: number[];
  let stderr: string[];

  beforeEach(() => {
    isolatedCliDataDir = isolateCliDataDir();
    exitCodes = [];
    stderr = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    console.error = ((...args: unknown[]) => {
      stderr.push(args.join(" "));
    }) as typeof console.error;
    setCliOutputSinksForTesting({ stdout: { write: () => {} }, stderr: { write: () => {} } });
  });

  afterEach(() => {
    process.exit = originalProcessExit;
    console.error = originalConsoleError;
    resetCliOutputSinksForTesting();
    resetDaemonProxyFactoryForTesting();
    isolatedCliDataDir.restore();
  });

  function respondWith(envelope: unknown): void {
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async () => envelope,
      adoptCliSessionLiveness: async (): Promise<string | undefined> => undefined,
      close: async (): Promise<void> => {},
    }));
  }

  test("a sessionless tool call prints the daemon's remedy and the CLI hint, then exits 1", async () => {
    respondWith(
      shapeToolCallError(
        new InputDeviceOwnedError("rotate", "emulator-5554", undefined, TOOL_CALL_REMEDY),
        { toolName: "rotate", source: "MCP" },
      ),
    );

    await runCliCommand(["rotate", "--deviceId", "emulator-5554"]);

    expect(exitCodes).toEqual([1]);
    expect(stderr[0]).toContain("device 'emulator-5554' is held by another session");
    expect(stderr[0]).toContain("The request carried no sessionUuid");
    expect(stderr[0]).toContain(TOOL_CALL_REMEDY);
    expect(stderr[1]).toContain("--session-uuid <uuid>");
  });

  test("a killDevice refusal also names --force", async () => {
    respondWith(
      shapeToolCallError(
        new InputDeviceOwnedError("killDevice", "emulator-5554", undefined, LIFECYCLE_TOOL_REMEDY),
        { toolName: "killDevice", source: "MCP" },
      ),
    );

    await runCliCommand([
      "killDevice",
      "--device",
      '{"name":"x","deviceId":"emulator-5554","platform":"android"}',
    ]);

    expect(exitCodes).toEqual([1]);
    expect(stderr[0]).toContain(LIFECYCLE_TOOL_REMEDY);
    expect(stderr[1]).toContain("--force true");
  });

  test("a deleteDevice precondition refusal surfaces its message and hint", async () => {
    respondWith(
      createTeardownFailureResponse(
        {
          operationId: "00000000-0000-0000-0000-000000000000",
          mode: "destroy",
          target: { platform: "android", isVirtual: true, stableId: "x" },
        } as never,
        "precondition",
        "device_owned_by_other_session",
        "deleteDevice refused: device 'emulator-5554' is held by another session.",
      ),
    );

    await runCliCommand(["deleteDevice"]);

    expect(exitCodes).toEqual([1]);
    expect(stderr[0]).toContain("held by another session");
    expect(stderr[1]).toContain("--force true");
  });
});
