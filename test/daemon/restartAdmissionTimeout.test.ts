import { describe, expect, test } from "bun:test";
import { DaemonManager } from "../../src/daemon/manager";
import { RESTART_ADMISSION_TIMEOUT_MS } from "../../src/daemon/manager/DaemonRestartCoordinator";
import { DaemonRestartDeferredError } from "../../src/daemon/daemonRestartAdmission";
import type { DaemonClientLike } from "../../src/daemon/client/clientResponseDecoding";
import type { DaemonMethodCallOptions } from "../../src/daemon/client/client";
import type { DaemonStatus } from "../../src/daemon/types";
import { McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Asking an incumbent daemon to agree to a restart runs under the startup lock against a 30 s start
 * budget; its connect and admission RPC must not use the client's 120 s default (#13792).
 */

const expected: DaemonStatus = {
  running: true,
  pid: 1001,
  startedAt: 100,
  version: "0.0.73",
  buildId: "incumbent-build",
  entryScript: "/old/dist/src/index.js",
};

class AdmissionClient implements DaemonClientLike {
  connects = 0;
  methodOptions: Array<DaemonMethodCallOptions | undefined> = [];
  constructor(private readonly answer: () => Promise<unknown>) {}
  async connect(): Promise<void> {
    this.connects += 1;
  }
  async close(): Promise<void> {}
  async callTool(): Promise<unknown> {
    return {};
  }
  async readResource(): Promise<unknown> {
    return {};
  }
  async callDaemonMethod(
    _method: string,
    _params: Record<string, unknown>,
    options?: DaemonMethodCallOptions,
  ): Promise<unknown> {
    this.methodOptions.push(options);
    return await this.answer();
  }
}

function managerWith(client: AdmissionClient): DaemonManager {
  return new DaemonManager({
    clientFactory: () => client,
    timer: new FakeTimer(),
    processFinder: { findDaemonProcesses: () => [], isProcessRunning: () => true },
  });
}

describe("safe-restart admission of an incumbent daemon (#13792)", () => {
  test.each(["preparation", "admission"] as const)(
    "identity-recovery %s refusal carries its reason on the deferred error",
    async (phase) => {
      let calls = 0;
      const client = new AdmissionClient(async () => {
        calls += 1;
        return phase === "admission" && calls === 1
          ? { accepted: true, maintenanceToken: "recovery-token" }
          : { accepted: false, reason: "active_operations" };
      });

      const outcome = managerWith(client)["prepareIdentityRecoveryRestart"]({
        ...expected,
        dbPath: "/incumbent/auto-mobile.db",
        options: {},
      });

      await expect(outcome).rejects.toBeInstanceOf(DaemonRestartDeferredError);
      await expect(outcome).rejects.toMatchObject({
        refusalReason: "active_operations",
        message: new DaemonRestartDeferredError("active_operations").message,
      });
    },
  );

  test("one bounded call carries the admission, with no separate default-timeout connect", async () => {
    const client = new AdmissionClient(async () => ({ accepted: true }));

    await expect(managerWith(client).prepareDaemonForConditionalRestart(expected)).resolves.toEqual(
      {
        accepted: true,
      },
    );

    expect(client.connects).toBe(0);
    expect(client.methodOptions).toEqual([{ timeoutMs: RESTART_ADMISSION_TIMEOUT_MS }]);
  });

  test("a timed-out admission is a deferral that names the incumbent, never an acceptance", async () => {
    const client = new AdmissionClient(async () => {
      throw new McpTimeoutError({
        toolName: "ide/prepareRestart",
        timeoutMs: RESTART_ADMISSION_TIMEOUT_MS,
        origin: "DaemonClient.callDaemonMethod",
      });
    });

    const outcome = await managerWith(client)
      .prepareDaemonForConditionalRestart(expected)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(DaemonRestartDeferredError);
    expect(String(outcome)).toContain("safe-restart admission is unavailable");
    expect(String(outcome)).toContain("pid 1001");
    expect(String(outcome)).toContain("0.0.73");
  });
});
