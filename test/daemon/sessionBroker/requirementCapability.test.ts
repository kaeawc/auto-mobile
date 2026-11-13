import { describe, expect, test } from "bun:test";
import { brokerRequirementCapability } from "../../../src/daemon/sessionBroker/requirementCapability";
import { requirementCapabilityReply } from "../../../src/daemon/sessionBroker/handlers";
import { ActionableError } from "../../../src/models/ActionableError";
import type { SessionCatalogPlatform } from "../../../src/daemon/sessionBroker/brokerOptions";
import type { SessionDeviceCatalog } from "../../../src/devices/sessionRequirements";
import {
  createSessionRequirementCapabilityHandler,
  sessionRequirementCapabilitySchema,
} from "../../../src/server/sessionRequirementCapabilityTool";
import { iosCatalog, iosDefaults } from "../../devices/sessionRequirements/fixtures";

const IOS_OMITTED = {
  schemaVersion: 1,
  platform: "ios",
  hardware: { kind: "omitted" },
  os: { kind: "omitted" },
};

/** The two read-only seams the query may touch, recording every catalog read. */
function host(catalog: SessionDeviceCatalog = iosCatalog()) {
  const reads: SessionCatalogPlatform[] = [];
  return {
    reads,
    options: {
      catalog: async (platform: SessionCatalogPlatform) => {
        reads.push(platform);
        return catalog;
      },
      defaults: (platform: "ios" | "android") => {
        if (platform !== "ios") {
          throw new ActionableError(`Session-broker execution is not configured for ${platform}`);
        }
        return iosDefaults();
      },
    },
  };
}

describe("brokerRequirementCapability (#18180)", () => {
  test("answers from the broker's catalog and defaults", async () => {
    const fake = host();
    const answer = await brokerRequirementCapability(fake.options, IOS_OMITTED);
    expect(answer).toMatchObject({
      ok: true,
      value: {
        satisfiable: true,
        policyVersion: "defaults-ios-1",
        resolvedOs: { source: "platform-default", osVersion: "27.0" },
      },
    });
    expect(fake.reads).toEqual(["ios"]);
  });

  test("an unconfigured platform is invalid_config and reads no catalog", async () => {
    const fake = host();
    const answer = await brokerRequirementCapability(fake.options, {
      ...IOS_OMITTED,
      platform: "android",
    });
    expect(answer).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    expect(fake.reads).toEqual([]);
  });

  test("malformed and watch requests are refused before any catalog read", async () => {
    const fake = host();
    expect(await brokerRequirementCapability(fake.options, { platform: "ios" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const watch = {
      schemaVersion: 1,
      platform: "watchos",
      spec: { runtime: "r", deviceType: "d" },
    };
    expect(await brokerRequirementCapability(fake.options, watch)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", field: "platform" },
    });
    expect(fake.reads).toEqual([]);
  });
});

describe("daemon/sessionRequirementCapability reply (#18180)", () => {
  const broker = (catalog?: SessionDeviceCatalog) => {
    const fake = host(catalog);
    return {
      requirementCapability: (device: unknown, signal?: AbortSignal) =>
        brokerRequirementCapability(fake.options, device, signal),
    };
  };

  test("a satisfiable answer is a success result", async () => {
    expect(await requirementCapabilityReply(broker(), { device: IOS_OMITTED })).toMatchObject({
      success: true,
      result: { satisfiable: true, anyOsSatisfiable: true, defaultOsSatisfiable: true },
    });
  });

  test("no iOS tooling is a stable, retryable catalog_unavailable code", async () => {
    const unavailable = iosCatalog({
      provenance: { source: "simctl", revision: "unavailable", state: "unavailable" },
      models: [],
      releases: [],
    });
    expect(
      await requirementCapabilityReply(broker(unavailable), { device: IOS_OMITTED }),
    ).toMatchObject({ success: false, code: "catalog_unavailable", retryable: true });
  });

  test("missing or extra parameters are invalid_request", async () => {
    expect(await requirementCapabilityReply(broker(), {})).toMatchObject({
      success: false,
      code: "invalid_request",
    });
    expect(
      await requirementCapabilityReply(broker(), { device: IOS_OMITTED, extra: 1 }),
    ).toMatchObject({ success: false, code: "invalid_request" });
  });
});

describe("getSessionRequirementCapability tool (#18180)", () => {
  test("reports session_broker_unavailable when the daemon runs no broker", async () => {
    const handler = createSessionRequirementCapabilityHandler(() => undefined);
    expect(await handler({ device: IOS_OMITTED })).toMatchObject({
      isError: true,
      structuredContent: { success: false, code: "session_broker_unavailable" },
    });
  });

  test("returns the capability answer as structured content", async () => {
    const fake = host();
    const handler = createSessionRequirementCapabilityHandler(() => ({
      requirementCapability: (device, signal) =>
        brokerRequirementCapability(fake.options, device, signal),
    }));
    const response = await handler(
      sessionRequirementCapabilitySchema.parse({ device: IOS_OMITTED }),
    );
    expect(response).not.toHaveProperty("isError");
    expect(response.structuredContent).toMatchObject({
      success: true,
      satisfiable: true,
      resolvedOs: { source: "platform-default", osVersion: "27.0" },
    });
  });
});
