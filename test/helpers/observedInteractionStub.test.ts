import { expect, test } from "bun:test";
import { buildObserveResult } from "./observeFixture";
import { runBlockWith, runBlockWithEnvelope } from "./observedInteractionStub";

const base = {
  updatedAt: 1,
  screenSize: { width: 1, height: 1 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
};
const before = buildObserveResult(base);
const after = buildObserveResult({ ...base, updatedAt: 2 });
const options = { changeExpected: false };

test("runBlockWith hands the block the observation and returns its result untouched", async () => {
  const seen: unknown[] = [];
  const result = await runBlockWith(before)(async (observation) => {
    seen.push(observation);
    return { success: true };
  }, options);
  expect(seen).toEqual([before]);
  expect(result).toEqual({ success: true });
});

test("runBlockWith resolves a thunk on every call", async () => {
  let calls = 0;
  const stub = runBlockWith(() => {
    calls += 1;
    return before;
  });
  await stub(async () => ({ success: true }), options);
  await stub(async () => ({ success: true }), options);
  expect(calls).toBe(2);
});

test("runBlockWithEnvelope merges the envelope into the block result", async () => {
  const result = await runBlockWithEnvelope(before, { observation: after })(
    async () => ({ success: true }),
    options,
  );
  expect(result).toEqual({ success: true, observation: after });
});
