import { expect, test } from "bun:test";
import { ConnectionFailureRecord } from "../../../src/features/observe/ConnectionFailureRecord";
import { CtrlProxyForwardingLeaseConflictError } from "../../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";

test("failure records classify typed lease conflicts and reset on replacement or clear", () => {
  const record = new ConnectionFailureRecord();
  record.record(new CtrlProxyForwardingLeaseConflictError("busy", 42, undefined, true));
  expect(record.message).toBe("busy");
  expect(record.isForwardingLeaseConflict).toBe(true);
  expect(record.isTransientLeaseConflict).toBe(true);
  record.record(new Error("ordinary failure"));
  expect(record.message).toBe("ordinary failure");
  expect(record.isForwardingLeaseConflict).toBe(false);
  expect(record.isTransientLeaseConflict).toBe(false);
  record.clear();
  expect(record.message).toBeUndefined();
  expect(record.isForwardingLeaseConflict).toBe(false);
  expect(record.isTransientLeaseConflict).toBe(false);
});
