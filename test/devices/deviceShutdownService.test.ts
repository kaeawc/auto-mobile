import { describe, expect, test } from "bun:test";
import {
  DeviceShutdownService,
  type DeviceShutdownReservation,
  type DeviceShutdownWorkflow,
} from "../../src/devices/deviceShutdownService";
import { FakeLogger } from "../fakes/FakeLogger";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withoutUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function harness(releaseError?: Error) {
  const log = new FakeLogger();
  const service = new DeviceShutdownService(log);
  const events: string[] = [];
  const reservation: DeviceShutdownReservation<string> = {
    device: "device",
    async release() {
      events.push("release");
      if (releaseError) {
        throw releaseError;
      }
    },
  };
  const failures: unknown[] = [];
  const workflow: DeviceShutdownWorkflow<string, string> = {
    async prepare() {
      events.push("prepare");
      return reservation;
    },
    async execute(received) {
      events.push("execute");
      expect(received).toBe(reservation);
      return "success";
    },
    failure(error) {
      events.push("failure");
      failures.push(error);
      return "failure result";
    },
  };
  return { log, service, events, failures, workflow };
}

function expectReleaseWarning(log: FakeLogger, error: Error, context: string): void {
  expect(log.at("warn")).toHaveLength(1);
  expect(log.at("warn")[0]?.message).toBe(
    `[DeviceShutdownService] Failed to release shutdown reservation (${context}): ${error.message}`,
  );
  expect(log.at("warn")[0]?.args).toEqual([error]);
}

describe("DeviceShutdownService", () => {
  test("prepares, executes, and releases once on success", async () => {
    const h = harness();
    expect(await h.service.shutdown(h.workflow)).toBe("success");
    expect(h.events).toEqual(["prepare", "execute", "release"]);
    expect(h.failures).toEqual([]);
    expect(h.log.at("warn")).toEqual([]);
  });

  test("a rejecting finally release preserves success without an unhandled rejection", async () => {
    await withoutUnhandledRejections(async () => {
      const releaseError = new Error("release failed");
      const h = harness(releaseError);
      expect(await h.service.shutdown(h.workflow)).toBe("success");
      expect(h.events).toEqual(["prepare", "execute", "release"]);
      expect(h.failures).toEqual([]);
      expectReleaseWarning(h.log, releaseError, "finally");
    });
  });

  for (const releaseRejects of [false, true]) {
    test(`execute failure result survives finally release (rejects=${releaseRejects})`, async () => {
      await withoutUnhandledRejections(async () => {
        const releaseError = new Error("release failed");
        const shutdownError = new Error("shutdown failed");
        const h = harness(releaseRejects ? releaseError : undefined);
        h.workflow.execute = async () => {
          h.events.push("execute");
          throw shutdownError;
        };
        expect(await h.service.shutdown(h.workflow)).toBe("failure result");
        expect(h.failures).toEqual([shutdownError]);
        expect(h.events).toEqual(["prepare", "execute", "failure", "release"]);
        if (releaseRejects) {
          expectReleaseWarning(h.log, releaseError, "finally");
        } else {
          expect(h.log.at("warn")).toEqual([]);
        }
      });
    });
  }

  test("failure hook's original throw propagates after a rejecting release is attempted", async () => {
    await withoutUnhandledRejections(async () => {
      const releaseError = new Error("release failed");
      const shutdownError = new Error("shutdown failed");
      const h = harness(releaseError);
      h.workflow.execute = async () => {
        h.events.push("execute");
        throw shutdownError;
      };
      h.workflow.failure = (error) => {
        h.events.push("failure");
        expect(error).toBe(shutdownError);
        throw error;
      };
      const caught = await h.service.shutdown(h.workflow).catch((error: unknown) => error);
      expect(caught).toBe(shutdownError);
      expect(h.events).toEqual(["prepare", "execute", "failure", "release"]);
      expectReleaseWarning(h.log, releaseError, "finally");
    });
  });

  test("prepare failure skips execute and release", async () => {
    const h = harness();
    const prepareError = new Error("prepare failed");
    h.workflow.prepare = async () => {
      h.events.push("prepare");
      throw prepareError;
    };
    expect(await h.service.shutdown(h.workflow)).toBe("failure result");
    expect(h.failures).toEqual([prepareError]);
    expect(h.events).toEqual(["prepare", "failure"]);
    expect(h.log.at("warn")).toEqual([]);
  });

  for (const phase of ["prepare", "execute"] as const) {
    test(`passes an abort from ${phase} unchanged to failure`, async () => {
      const h = harness();
      const controller = new AbortController();
      const abortError = new DOMException("shutdown aborted", "AbortError");
      controller.abort(abortError);
      h.workflow[phase] = async () => {
        h.events.push(phase);
        controller.signal.throwIfAborted();
        throw new Error("Expected aborted signal to throw");
      };
      expect(await h.service.shutdown(h.workflow)).toBe("failure result");
      expect(h.failures[0]).toBe(abortError);
      expect(h.events).toEqual(
        phase === "prepare" ? ["prepare", "failure"] : ["prepare", "execute", "failure", "release"],
      );
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    for (const releaseRejects of [false, true]) {
      test(`retained ${outcome} releases only after settlement (rejects=${releaseRejects})`, async () => {
        await withoutUnhandledRejections(async () => {
          const releaseError = new Error("late release failed");
          const operation = deferred();
          const h = harness(releaseRejects ? releaseError : undefined);
          h.workflow.execute = async (_reservation, retain) => {
            h.events.push("execute");
            retain(operation.promise, outcome === "failure");
            return "success";
          };
          expect(await h.service.shutdown(h.workflow)).toBe("success");
          expect(h.events).toEqual(["prepare", "execute"]);
          if (outcome === "success") {
            operation.resolve();
          } else {
            operation.reject(new Error("late teardown failed"));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(h.events).toEqual(["prepare", "execute", "release"]);
          if (releaseRejects) {
            expectReleaseWarning(h.log, releaseError, `late operation ${outcome}`);
          } else {
            expect(h.log.at("warn")).toEqual([]);
          }
        });
      });
    }
  }

  for (const outcome of ["success", "failure"] as const) {
    test(`execute failure keeps reservation until late ${outcome} releases it`, async () => {
      await withoutUnhandledRejections(async () => {
        const operation = deferred();
        const releaseError = new Error("late release failed");
        const shutdownError = new Error("shutdown failed");
        const h = harness(releaseError);
        h.workflow.execute = async (_reservation, retain) => {
          h.events.push("execute");
          retain(operation.promise, true);
          throw shutdownError;
        };
        expect(await h.service.shutdown(h.workflow)).toBe("failure result");
        expect(h.failures[0]).toBe(shutdownError);
        expect(h.events).toEqual(["prepare", "execute", "failure"]);
        if (outcome === "success") {
          operation.resolve();
        } else {
          operation.reject(new Error("late teardown failed"));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(h.events).toEqual(["prepare", "execute", "failure", "release"]);
        expectReleaseWarning(h.log, releaseError, `late operation ${outcome}`);
      });
    });
  }

  test("late failure stays retained by default even when execute throws", async () => {
    await withoutUnhandledRejections(async () => {
      const operation = deferred();
      const h = harness();
      const shutdownError = new Error("shutdown failed");
      const lateError = new Error("late teardown failed");
      h.workflow.execute = async (_reservation, retain) => {
        h.events.push("execute");
        retain(operation.promise);
        throw shutdownError;
      };
      expect(await h.service.shutdown(h.workflow)).toBe("failure result");
      expect(h.failures).toEqual([shutdownError]);
      expect(h.events).toEqual(["prepare", "execute", "failure"]);
      operation.reject(lateError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.events).toEqual(["prepare", "execute", "failure"]);
      expect(h.log.at("warn")).toHaveLength(1);
      expect(h.log.at("warn")[0]?.message).toBe(
        "[DeviceShutdownService] Retaining shutdown reservation after late teardown failed: late teardown failed",
      );
      expect(h.log.at("warn")[0]?.args).toEqual([lateError]);
    });
  });
});
