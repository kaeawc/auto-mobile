import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { RECEIPT_RETENTION_MS } from "../../../src/daemon/sessionBroker/retention";
import { readBrokerTimingStats } from "../../../src/daemon/sessionBroker/timingStats";

test("broker timing stats accepts the receipt retention window", async () => {
  const stats = await readBrokerTimingStats(
    { timingSamples: async () => [] },
    () => RECEIPT_RETENTION_MS,
    RECEIPT_RETENTION_MS,
    1,
  );

  expect(stats.sinceMs).toBe(0);
  expect(stats.untilMs).toBe(RECEIPT_RETENTION_MS);
});

test("broker timing stats rejects windows beyond receipt retention", async () => {
  await expect(
    readBrokerTimingStats(
      { timingSamples: async () => [] },
      () => RECEIPT_RETENTION_MS + 1,
      RECEIPT_RETENTION_MS + 1,
      1,
    ),
  ).rejects.toThrow(ActionableError);
});
