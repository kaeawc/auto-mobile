import { expect, test } from "bun:test";
import {
  TextRequestState,
  resolveTextCtrlProxyTimeoutMs,
} from "../../../src/features/action/textTransportTimeout";

test.each([
  [0, 5000],
  [1, 5000],
  [5, 5000],
  [300, 32000],
  [1000, 102000],
  [2000, 120000],
])("text transport length %s has timeout %s", (length, expected) => {
  expect(resolveTextCtrlProxyTimeoutMs("a".repeat(length))).toBe(expected);
});

test("counts code points rather than UTF-16 units", () => {
  expect(resolveTextCtrlProxyTimeoutMs("😀".repeat(300))).toBe(32000);
});

test.each([
  [4000, 4000],
  [110000, 102000],
  [0, 0],
  [-1, 0],
])("remaining budget %s clamps to %s", (budget, expected) => {
  expect(resolveTextCtrlProxyTimeoutMs("a".repeat(1000), budget)).toBe(expected);
});

test("outstanding text marks a request deadline indeterminate", () => {
  const state = new TextRequestState();
  state.dispatched();
  expect(state.timeoutError("request expired")?.retryable).toBe(false);
});

test.each([true, false])(
  "completed text confirmed=%s does not relabel unrelated errors",
  (confirmed) => {
    const state = new TextRequestState();
    const complete = state.dispatched();
    complete(confirmed);
    expect(state.timeoutError("later observation failed")).toBeUndefined();
  },
);

test("only the unconfirmed command's own thrown error remains indeterminate", () => {
  const state = new TextRequestState();
  const error = new Error("lost reply");
  state.dispatched()(false, error);
  expect(state.timeoutError(error)?.retryable).toBe(false);
  expect(state.timeoutError(new Error(error.message))).toBeUndefined();
  state.dispatched()(true);
  expect(state.timeoutError(new Error("later step failed"))).toBeUndefined();
});

test("dispatch completion is idempotent while another command remains pending", () => {
  const state = new TextRequestState();
  const complete = state.dispatched();
  const other = state.dispatched();
  complete(true);
  complete(true);
  expect(state.timeoutError("expired")?.retryable).toBe(false);
  other(true);
  expect(state.timeoutError("expired")).toBeUndefined();
});

test("settled resolves immediately without a dispatched command", async () => {
  const state = new TextRequestState();
  expect(state.hasPending()).toBe(false);
  await state.settled();
});

test("all settlement waiters wait for every pending command", async () => {
  const state = new TextRequestState();
  const first = state.dispatched();
  const second = state.dispatched();
  let settled = 0;
  const waiters = [state.settled(), state.settled()].map((waiter) => waiter.then(() => settled++));
  first(true);
  first(true);
  await Promise.resolve();
  expect(state.hasPending()).toBe(true);
  expect(settled).toBe(0);
  second(false, new Error("lost reply"));
  await Promise.all(waiters);
  expect(state.hasPending()).toBe(false);
  expect(settled).toBe(2);
  await state.settled();
});

test("settlement tracks a later dispatch independently", async () => {
  const state = new TextRequestState();
  state.dispatched()(true);
  await state.settled();
  const complete = state.dispatched();
  let settled = false;
  const waiter = state.settled().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  complete(true);
  await waiter;
  expect(settled).toBe(true);
});
