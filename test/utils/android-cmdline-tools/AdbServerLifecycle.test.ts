import { describe, expect, test } from "bun:test";
import {
  LEGACY_MANAGED_ADB_SERVER_ENV,
  MANAGED_ADB_SERVER_ENV,
  MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS,
  isManagedAdbServerEnabled,
  stopManagedAdbServer,
} from "../../../src/utils/android-cmdline-tools/AdbServerLifecycle";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type {
  AdbExecuteOptions,
  AdbExecutor,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

function environment(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values;
}

describe("managed ADB server lifecycle configuration", () => {
  test("is disabled by default and preserves a shared ADB server", () => {
    expect(isManagedAdbServerEnabled(environment({}))).toBeFalse();
  });

  test("accepts the canonical opt-in and retains the legacy alias", () => {
    expect(isManagedAdbServerEnabled(environment({ [MANAGED_ADB_SERVER_ENV]: "true" }))).toBeTrue();
    expect(
      isManagedAdbServerEnabled(environment({ [LEGACY_MANAGED_ADB_SERVER_ENV]: "1" })),
    ).toBeTrue();
  });

  test("gives the canonical setting precedence over the legacy alias", () => {
    expect(
      isManagedAdbServerEnabled(
        environment({
          [MANAGED_ADB_SERVER_ENV]: "0",
          [LEGACY_MANAGED_ADB_SERVER_ENV]: "1",
        }),
      ),
    ).toBeFalse();
  });
});

describe("stopManagedAdbServer", () => {
  test("does not construct an ADB client when managed mode is disabled", async () => {
    let created = 0;
    const adbFactory: AdbClientFactory = {
      create: () => {
        created += 1;
        throw new Error("should not create an ADB client");
      },
    };

    await stopManagedAdbServer({ adbFactory, environment: environment({}) });

    expect(created).toBe(0);
  });

  test("stops the process-wide ADB server once when the managed mode owns it", async () => {
    const calls: Array<{ args: string[]; options: AdbExecuteOptions | undefined }> = [];
    const adb: Pick<AdbExecutor, "execute"> = {
      async execute(args, options): Promise<never> {
        calls.push({ args, options });
        return undefined as never;
      },
    };
    const adbFactory: AdbClientFactory = {
      create: () => adb as AdbExecutor,
    };

    await stopManagedAdbServer({
      adbFactory,
      environment: environment({ [MANAGED_ADB_SERVER_ENV]: "1" }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ["kill-server"],
      options: {
        timeoutMs: MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS,
        noRetry: true,
      },
    });
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
  });

  test("aborts a hung server shutdown at the fixed cleanup bound", async () => {
    const timer = new FakeTimer();
    let signal: AbortSignal | undefined;
    const adb: Pick<AdbExecutor, "execute"> = {
      async execute(_args, options): Promise<never> {
        signal = options?.signal;
        return await new Promise<never>(() => {});
      },
    };
    const adbFactory: AdbClientFactory = {
      create: () => adb as AdbExecutor,
    };

    const shutdown = stopManagedAdbServer({
      adbFactory,
      environment: environment({ [MANAGED_ADB_SERVER_ENV]: "1" }),
      timer,
    });
    await Promise.resolve();

    timer.advanceTime(MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS);

    await expect(shutdown).rejects.toThrow(
      `Managed ADB server shutdown timed out after ${MANAGED_ADB_SERVER_SHUTDOWN_TIMEOUT_MS}ms`,
    );
    expect(signal?.aborted).toBeTrue();
  });
});
