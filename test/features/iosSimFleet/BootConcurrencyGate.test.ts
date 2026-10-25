import { expect, test } from "bun:test";
import { BootConcurrencyGate } from "../../../src/features/iosSimFleet/BootConcurrencyGate";

test("FIFO permits respect the limit and release idempotently", async () => {
  const gate = new BootConcurrencyGate(1);
  const first = await gate.acquire();
  const order: number[] = [];
  const second = gate.acquire(undefined, "second").then((permit) => {
    order.push(2);
    return permit;
  });
  const third = gate.acquire().then((permit) => {
    order.push(3);
    return permit;
  });
  expect(gate.status()).toEqual({ limit: 1, running: 1, queued: 2 });
  first.release();
  first.release();
  const next = await second;
  expect(order).toEqual([2]);
  expect(gate.status()).toEqual({ limit: 1, running: 1, queued: 1 });
  next.release();
  (await third).release();
  expect(order).toEqual([2, 3]);
  expect(gate.status()).toEqual({ limit: 1, running: 0, queued: 0 });
});

test("abort removes a queued waiter without consuming a permit", async () => {
  const gate = new BootConcurrencyGate(1);
  const first = await gate.acquire();
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const pending = gate.acquire(controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(gate.status()).toEqual({ limit: 1, running: 1, queued: 0 });
  first.release();
  const aborted = gate.acquire(controller.signal);
  await expect(aborted).rejects.toBe(reason);
  expect(gate.status().running).toBe(0);
});

test("raising the limit wakes FIFO waiters; lowering it retains active permits", async () => {
  const gate = new BootConcurrencyGate(1);
  const first = await gate.acquire();
  const second = gate.acquire();
  const third = gate.acquire();
  gate.setLimit(2);
  const next = await second;
  expect(gate.status()).toEqual({ limit: 2, running: 2, queued: 1 });
  gate.setLimit(1);
  first.release();
  expect(gate.status()).toEqual({ limit: 1, running: 1, queued: 1 });
  next.release();
  (await third).release();
  expect(gate.status().running).toBe(0);
});

test("raising the limit grants multiple waiters in FIFO order", async () => {
  const gate = new BootConcurrencyGate(1);
  const first = await gate.acquire();
  const order: number[] = [];
  const second = gate.acquire().then((permit) => {
    order.push(2);
    return permit;
  });
  const third = gate.acquire().then((permit) => {
    order.push(3);
    return permit;
  });
  gate.setLimit(3);
  const permits = await Promise.all([second, third]);
  expect(order).toEqual([2, 3]);
  expect(gate.status()).toEqual({ limit: 3, running: 3, queued: 0 });
  first.release();
  for (const permit of permits) {
    permit.release();
  }
});
