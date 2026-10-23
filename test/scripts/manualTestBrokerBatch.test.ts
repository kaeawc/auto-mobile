import { expect, test } from "bun:test";
import {
  BrokerBatchRequestIds,
  parseBrokerBatch,
  renderHostConfig,
  renderClientRequest,
  planExpectations,
} from "../../scripts/manual-test/brokerBatch";
import { parseSessionConfig } from "../../src/devices/sessionConfig";
import { parseSessionBrokerHostConfig } from "../../src/daemon/sessionBroker/hostConfig";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { brokerBatchInput } from "./manualTestPrivateDaemonFixture";

test("batch renders product-validated host and Android/iOS request contracts", () => {
  const batch = parseBrokerBatch(brokerBatchInput());
  const host = renderHostConfig(batch);
  expect(parseSessionBrokerHostConfig(JSON.parse(JSON.stringify(host)))).toEqual(host);
  expect(host.limits).toEqual(batch.limits);
  for (const client of batch.clients) {
    const request = renderClientRequest(client, `batch-${client.name}-1`);
    expect(parseSessionConfig(JSON.parse(JSON.stringify(request)))).toEqual(request);
    if (client.hardware !== "phone" && client.hardware !== "tablet" && client.hardware !== "duo") {
      throw new Error("fixture must use a hardware archetype");
    }
    expect(request.device.hardware).toEqual({ kind: "archetype", archetype: client.hardware });
    expect(request.device.os).toEqual({ kind: "omitted" });
  }
});

test("explicit hardware and OS selectors and timeouts use product validation", () => {
  const client = {
    name: "ios-pro",
    platform: "ios" as const,
    hardware: { kind: "model-type", modelType: { family: "iphone", variant: "pro" } },
    os: { kind: "exact", version: "26.5" },
    idleTimeoutMs: 600_000,
    preparationTimeoutMs: 5_000,
  };
  const request = renderClientRequest(client, "batch-ios-pro-1");
  expect(request).toMatchObject({
    idleTimeoutMs: 600_000,
    preparationTimeoutMs: 5_000,
    device: { hardware: client.hardware, os: client.os },
  });
  expect(
    renderClientRequest({ name: "default", platform: "android" }, "request").device.hardware,
  ).toEqual({ kind: "omitted" });
  expect(() =>
    renderClientRequest(
      {
        ...client,
        hardware: { kind: "exact-model", model: { namespace: "alias", value: "phone" } },
      },
      "request",
    ),
  ).not.toThrow();
  expect(() => renderClientRequest(client, "x".repeat(257))).toThrow("session_config_invalid");
});

test.each([
  { hardware: "unknown" },
  { hardware: null },
  { hardware: { kind: "archetype", archetype: "duo" } },
  { os: { kind: "major", major: -1 } },
  { os: null },
  { os: { kind: "exact", version: "bad" } },
  { idleTimeoutMs: 119_999 },
  { idleTimeoutMs: 3_600_001 },
  { preparationTimeoutMs: 0 },
])("invalid client fields are refused by the product parser: %j", (fields) => {
  const input = brokerBatchInput();
  expect(() =>
    parseBrokerBatch({ ...input, clients: [{ ...input.clients[0], ...fields }] }),
  ).toThrow();
});

test.each(["A", "", "a_b", "a".repeat(33), "../client"])(
  "refuses invalid client name %j",
  (name) => {
    const input = brokerBatchInput();
    input.clients[0].name = name;
    expect(() => parseBrokerBatch(input)).toThrow();
  },
);

test("refuses duplicate names and schema additions", () => {
  const input = brokerBatchInput();
  input.clients[1].name = input.clients[0].name;
  expect(() => parseBrokerBatch(input)).toThrow("unique");
  expect(() => parseBrokerBatch({ ...brokerBatchInput(), schemaVersion: 2 })).toThrow();
  expect(() => parseBrokerBatch({ ...brokerBatchInput(), unexpected: true })).toThrow();
  expect(() =>
    parseBrokerBatch({
      ...brokerBatchInput(),
      clients: [{ ...brokerBatchInput().clients[0], unexpected: true }],
    }),
  ).toThrow();
});

test("host policy is validated through the product parser, with defaults for every client platform", () => {
  const input = brokerBatchInput();
  input.defaults.android.hardware.omitted = "unknown";
  expect(() => parseBrokerBatch(input)).toThrow("Invalid session broker host configuration");
  expect(() => parseBrokerBatch({ ...brokerBatchInput(), defaults: {} })).toThrow();
  expect(() =>
    parseBrokerBatch({
      ...brokerBatchInput(),
      defaults: { android: brokerBatchInput().defaults.android },
    }),
  ).toThrow("requires explicit ios defaults");
});

test("default 2, explicit 4, and hard 4 device ceilings", () => {
  const input = brokerBatchInput();
  input.limits.totalDeviceCap = 3;
  expect(() => parseBrokerBatch(input)).toThrow("--max-devices 2");
  expect(parseBrokerBatch(input, { maxDevices: 3 }).limits.totalDeviceCap).toBe(3);
  input.limits.totalDeviceCap = 4;
  expect(parseBrokerBatch(input, { maxDevices: 4 }).limits.totalDeviceCap).toBe(4);
  input.limits.totalDeviceCap = 5;
  expect(() => parseBrokerBatch(input, { maxDevices: 4 })).toThrow();
  for (const maxDevices of [0, 5, 1.5, NaN, Infinity]) {
    expect(() => parseBrokerBatch(input, { maxDevices })).toThrow("hard ceiling");
  }
});

test("pooling requires explicit reuse permission", () => {
  for (const change of [
    { idlePoolCap: 1, reuse: false },
    { idlePoolCap: 0, reuse: true },
  ]) {
    const input = brokerBatchInput();
    input.limits.idlePoolCap = change.idlePoolCap;
    input.reuseCleanDevices = change.reuse;
    expect(() => parseBrokerBatch(input)).toThrow("--allow-reuse");
    expect(parseBrokerBatch(input, { allowReuse: true }).reuseCleanDevices).toBe(change.reuse);
  }
});

test("Android reuse flag requires explicit reuse permission and renders to host config", () => {
  const input = { ...brokerBatchInput(), reuseAndroidCleanDevices: true };
  expect(() => parseBrokerBatch(input)).toThrow("reuseAndroidCleanDevices false");
  const host = renderHostConfig(parseBrokerBatch(input, { allowReuse: true }));
  expect(host.reuseAndroidCleanDevices).toBe(true);
});

test.each(["erase", "keep-booted"])("explicit iOS %s cannot bypass no-reuse guards", (mode) => {
  const input = { ...brokerBatchInput(), reuseCleanDevices: false, reuse: { ios: { mode } } };
  expect(() => parseBrokerBatch(input)).toThrow("--allow-reuse");
  const parsed = parseBrokerBatch(input, { allowReuse: true });
  expect(renderHostConfig(parsed).reuse?.ios.mode).toBe(mode);
});

test("the iOS keep-booted reuse cap is accepted by the harness and defaults to 10 (#15017)", () => {
  const withCap = {
    ...brokerBatchInput(),
    reuseCleanDevices: false,
    reuse: { ios: { mode: "keep-booted", maxUses: 4 } },
  };
  expect(renderHostConfig(parseBrokerBatch(withCap, { allowReuse: true })).reuse?.ios).toEqual({
    mode: "keep-booted",
    maxUses: 4,
    fallback: "erase",
  });
  const defaulted = { ...withCap, reuse: { ios: { mode: "keep-booted" } } };
  expect(renderHostConfig(parseBrokerBatch(defaulted, { allowReuse: true })).reuse?.ios).toEqual({
    mode: "keep-booted",
    maxUses: 10,
    fallback: "erase",
  });
  expect(() =>
    parseBrokerBatch(
      { ...withCap, reuse: { ios: { mode: "keep-booted", maxUses: 0 } } },
      { allowReuse: true },
    ),
  ).toThrow("Invalid session broker host configuration");
});

test("planning retains excess clients and marks capacity refusals by order", () => {
  const input = brokerBatchInput();
  expect(planExpectations(parseBrokerBatch(input))).toEqual([
    { name: "a-phone", expected: "ready" },
    { name: "a-tablet", expected: "ready" },
    { name: "i-phone", expected: "failed:capacity_exhausted" },
  ]);
  input.limits.sessionCap = 1;
  expect(planExpectations(parseBrokerBatch(input)).map((row) => row.expected)).toEqual([
    "ready",
    "failed:capacity_exhausted",
    "failed:capacity_exhausted",
  ]);
  input.limits.totalDeviceCap = 0;
  expect(
    planExpectations(parseBrokerBatch(input)).every(
      (row) => row.expected === "failed:capacity_exhausted",
    ),
  ).toBe(true);
});

test("injected identities number attempts independently per client", () => {
  const ids = new FakeIdGenerator(["batch", "next-batch"]);
  const requests = new BrokerBatchRequestIds(ids);
  expect(requests.next("a-phone")).toBe("batch-a-phone-1");
  expect(requests.next("a-phone")).toBe("batch-a-phone-2");
  expect(requests.next("i-phone")).toBe("batch-i-phone-1");
  expect(new BrokerBatchRequestIds(ids).next("a-phone")).toBe("next-batch-a-phone-1");
});

test("catalog classification passes through to the rendered host config", () => {
  const input = brokerBatchInput();
  const host = renderHostConfig(parseBrokerBatch(input));
  expect(host.androidProfileArchetypes).toEqual({ medium_phone: "phone", medium_tablet: "tablet" });
  expect(input.iosClassifications).toEqual(host.iosClassifications!);
});

test("omitted classification keys fall back to product defaults", () => {
  const input: Record<string, unknown> = { ...brokerBatchInput() };
  delete input.androidProfileArchetypes;
  delete input.iosClassifications;
  const host = renderHostConfig(parseBrokerBatch(input));
  expect(host.androidProfileArchetypes).toEqual({});
  expect(host.iosClassifications).toEqual([]);
});

test.each([
  { androidProfileArchetypes: { medium_phone: "watch" } },
  { androidProfileArchetypes: [] },
  { iosClassifications: [{ simulatorDeviceTypeIdentifier: "", modelType: { family: "duo" } }] },
  { iosClassifications: "nope" },
])("invalid classification input is refused by the product parser: %j", (fields) => {
  expect(() => parseBrokerBatch({ ...brokerBatchInput(), ...fields })).toThrow(
    "Invalid session broker host configuration",
  );
});

test("every host-config key the product accepts survives the batch round trip (#14789)", () => {
  const input = {
    ...brokerBatchInput(),
    limits: { totalDeviceCap: 2, sessionCap: 2, idlePoolCap: 0, maxConcurrentResetBoots: 1 },
    androidResetMode: "keep-booted",
    reuseAndroidCleanDevices: true,
    androidKeepBootedMaxUses: 5,
    androidKeepBootedFallback: "snapshot",
    androidResetTimeoutMs: 60_000,
    reuse: { ios: { mode: "off" } },
  };
  const batch = parseBrokerBatch(input, { allowReuse: true });
  expect(batch.limits.maxConcurrentResetBoots).toBe(1);
  const host = renderHostConfig(batch);
  expect(host).toMatchObject({
    limits: { maxConcurrentResetBoots: 1 },
    androidResetMode: "keep-booted",
    androidKeepBootedMaxUses: 5,
    androidKeepBootedFallback: "snapshot",
    androidResetTimeoutMs: 60_000,
  });
  // The product parser accepts the rendered host config, and re-wrapping it as a batch is lossless.
  expect(
    renderHostConfig(
      parseBrokerBatch({ ...host, schemaVersion: 1, clients: [] }, { allowReuse: true }),
    ),
  ).toEqual(host);
});

test("the product parser still owns invalid host-config values and required caps", () => {
  const input = brokerBatchInput();
  expect(() =>
    parseBrokerBatch({ ...input, limits: { ...input.limits, maxConcurrentResetBoots: 0 } }),
  ).toThrow("Invalid session broker host configuration");
  expect(() => parseBrokerBatch({ ...input, limits: { totalDeviceCap: 2 } })).toThrow(
    "are required",
  );
});
