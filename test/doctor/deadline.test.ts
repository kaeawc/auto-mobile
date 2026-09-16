import { describe, expect, spyOn, test } from "bun:test";
import {
  awaitDoctorProbe,
  createDoctorDeadline,
  DoctorDeadlineError,
} from "../../src/doctor/deadline";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeTimer } from "../fakes/FakeTimer";

describe("createDoctorDeadline", () => {
  test("inherits the ambient request signal without creating a no-timeout replacement", async () => {
    const ambient = new AbortController();
    const timer = new FakeTimer();

    await runWithAbortSignal(ambient.signal, async () => {
      const deadline = createDoctorDeadline({}, timer);
      expect(deadline.probe.signal).toBe(ambient.signal);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      deadline.dispose();
    });
  });

  test("aborts with DoctorDeadlineError when the explicit timeout elapses", () => {
    const timer = new FakeTimer();
    const deadline = createDoctorDeadline({ timeoutMs: 50 }, timer);

    timer.advanceTime(49);
    expect(deadline.probe.signal?.aborted).toBe(false);
    timer.advanceTime(1);

    expect(deadline.probe.signal?.aborted).toBe(true);
    expect(deadline.probe.signal?.reason).toBeInstanceOf(DoctorDeadlineError);
    deadline.dispose();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["ambient", "explicit"] as const)(
    "preserves the first abort reason when the %s signal wins",
    async (winner) => {
      const ambient = new AbortController();
      const explicit = new AbortController();
      const timer = new FakeTimer();

      await runWithAbortSignal(ambient.signal, async () => {
        const deadline = createDoctorDeadline({ signal: explicit.signal, timeoutMs: 50 }, timer);
        const winningController = winner === "ambient" ? ambient : explicit;
        const losingController = winner === "ambient" ? explicit : ambient;
        const reason = new Error(`${winner} cancelled`);

        winningController.abort(reason);
        expect(deadline.probe.signal?.reason).toBe(reason);

        losingController.abort(new Error("later cancellation"));
        timer.advanceTime(50);
        expect(deadline.probe.signal?.reason).toBe(reason);

        deadline.dispose();
        expect(timer.getPendingTimeoutCount()).toBe(0);
      });
    },
  );
});

describe("awaitDoctorProbe", () => {
  test("removes its abort listener after the operation settles", async () => {
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    let resolveOperation: (value: string) => void = () => {};
    const operation = new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });

    try {
      const result = awaitDoctorProbe({ signal: controller.signal }, () => operation);
      await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);

      resolveOperation("complete");
      await expect(result).resolves.toBe("complete");

      expect(remove.mock.calls.length).toBe(add.mock.calls.length);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
