import { expect, test } from "bun:test";
import { daemonResponseError } from "../../src/daemon/client";
import { mcpRequestFailureDetails } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";

// #11244: an ide/* device lookup throws the retryable discovery_incomplete refusal, but the
// socket serializer kept codes only for a few known classes, so desktop clients got a bare string.

test("a discovery_incomplete refusal keeps its code and retry intent on the socket wire", () => {
  const error = new BootedDeviceDiscoveryIncompleteError("ios", {
    code: "failed",
    message: "simctl list timed out",
    retryable: true,
  });

  expect(mcpRequestFailureDetails(error, undefined)).toEqual({
    code: "discovery_incomplete",
    retryable: true,
  });
});

test("a capacity refusal carries its wait hint and details", () => {
  const error = new BootCapacityExhaustedError(
    { platform: "ios", limit: 2, booted: 2, retryAfterMs: 5_000 },
    "Refused to boot",
  );

  expect(mcpRequestFailureDetails(error, undefined)).toMatchObject({
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2, booted: 2, platform: "ios" },
  });
});

test("an untyped error with only a system code stays untyped", () => {
  const error = Object.assign(new Error("no such file"), { code: "ENOENT" });
  expect(mcpRequestFailureDetails(error, undefined)).toEqual({});
});

test("the daemon client keeps the refusal's retry intent on the error it throws", () => {
  const response: DaemonResponse = {
    id: "1",
    type: "mcp_response",
    success: false,
    error: "Refused to boot",
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2 },
  };

  expect(daemonResponseError(response)).toMatchObject({
    code: "capacity_exhausted",
    retryable: true,
    retryAfterMs: 5_000,
    details: { limit: 2 },
  });
});
