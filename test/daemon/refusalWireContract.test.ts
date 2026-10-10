import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acquisitionRefusals from "../../src/daemon/deviceAcquisitionRefusals";
import * as inputOwnership from "../../src/daemon/inputDeviceOwnership";
import * as managedSlotRefusals from "../../src/daemon/managedSlots/managedSlotRefusal";
import * as bootCapacity from "../../src/models/BootCapacityExhaustedError";
import * as boundSessionRefusal from "../../src/server/deviceOutsideBoundSessionRefusal";
import * as daemonTypes from "../../src/daemon/types";
import type { ManagedSlotsResult } from "../../src/models/managedSlotsResult";
import { DEFAULT_PROVISION_DEVICE_RETRYABILITY } from "../../src/devices/exactDeviceProvisioning";
import {
  MANAGED_SLOT_FIXTURE_PREFIX,
  PROVISION_DEVICE_FIXTURE_PREFIX,
  buildRefusalSurfaceFixtures,
  type RefusalSurfaceFixture,
  type RefusalWireResult,
  expectedWireCodes,
  managedSlotNestedCodes,
  REFUSAL_FIXTURES_DIR,
  REFUSAL_SURFACES_DIR,
  serializeRefusalSurfaceFixture,
  surfaceFixtureStem,
  UNFIXTURED_REFUSAL_CODES,
  buildRefusalWireFixtures,
  serializeRefusalFixture,
  type RefusalDisposition,
} from "../helpers/refusalWireFixtures";

/**
 * Cross-language contract for typed daemon refusals: the JUnit runner and XCTestRunner decode the
 * same fixtures and classify them per expectations.json. This suite keeps the TypeScript side of
 * that contract honest.
 */
interface Expectations {
  codes: Record<
    string,
    {
      expected: RefusalDisposition;
      knownGaps?: Record<string, RefusalDisposition>;
      fields: RefusalFields;
    }
  >;
}

interface RefusalFields {
  code?: string;
  retryable: boolean;
  acquireNewSession: boolean;
  retryAfterMs?: number;
  externalDevices?: string[];
}

interface WirePayload {
  retryAfterMs?: number;
  externalDevices?: string[];
  code?: string;
  retryable?: boolean;
  nextAction?: string;
  error?: {
    retryAfterMs?: number;
    code?: string;
    retryable?: boolean;
    nextAction?: string;
    acquisitionFailure?: { code?: string } | null;
  };
}

/** The codes a payload names on the wire, outermost first. */
function wireCodes(payload: WirePayload): string[] {
  const codes = [typeof payload.error === "object" ? payload.error.code : payload.code];
  const nested =
    typeof payload.error === "object" ? payload.error.acquisitionFailure?.code : undefined;
  return nested ? [...codes, nested] : codes.filter((code): code is string => code !== undefined);
}

const WAIT_CODES: ReadonlySet<string> = new Set([
  "device_owned_by_other_session",
  "device_cleanup_in_progress",
  "device_owned_by_other_daemon",
  "device_shutting_down",
]);
const RETRYABLE_WAIT_CODES: ReadonlySet<string> = new Set([
  "capacity_exhausted",
  "discovery_incomplete",
]);

/** What a runner reads from a payload: the shape `fields` pins for the Kotlin and Swift suites. */
function readFields(payload: WirePayload): RefusalFields {
  const envelope = typeof payload.error === "object" ? payload.error : undefined;
  const retryAfterMs = envelope?.retryAfterMs ?? payload.retryAfterMs;
  return {
    code: envelope?.code ?? payload.code,
    retryable: envelope?.retryable === true || payload.retryable === true,
    acquireNewSession: (envelope?.nextAction ?? payload.nextAction) === "acquire_new_session",
    ...(typeof retryAfterMs === "number" && retryAfterMs > 0 ? { retryAfterMs } : {}),
    ...(payload.externalDevices ? { externalDevices: payload.externalDevices } : {}),
  };
}

/** The precedence documented in expectations.json, applied to the top-level wire fields. */
function deriveDisposition(payload: WirePayload): RefusalDisposition {
  const envelope = typeof payload.error === "object" ? payload.error : undefined;
  return dispositionOf(
    envelope?.code ?? payload.code ?? "",
    (envelope?.retryable ?? payload.retryable) === true,
    envelope?.nextAction ?? payload.nextAction,
  );
}

function dispositionOf(
  code: string,
  retryable: boolean,
  nextAction: string | undefined,
): RefusalDisposition {
  if (WAIT_CODES.has(code) || (retryable && RETRYABLE_WAIT_CODES.has(code))) {
    return "wait";
  }
  if (nextAction === "acquire_new_session") {
    return "acquire-new-session";
  }
  return retryable ? "retry" : "fail";
}

const expectations = JSON.parse(
  readFileSync(join(REFUSAL_FIXTURES_DIR, "expectations.json"), "utf8"),
) as Expectations;
const fixtures = buildRefusalWireFixtures();
const fixtureCodes = fixtures.map((fixture) => fixture.code);

/**
 * Every exported `*_CODE` string constant of the modules that define device-refusal codes. The
 * session-envelope codes (`session_ownership_lost`, `no_active_device_session`) and the daemon
 * lifecycle codes are literals or live beside unrelated protocol codes; they are fixtured by name.
 */
function exportedCodeConstants(): Map<string, string> {
  const found = new Map<string, string>();
  for (const module of [
    acquisitionRefusals,
    inputOwnership,
    bootCapacity,
    managedSlotRefusals,
    boundSessionRefusal,
    daemonTypes,
  ]) {
    for (const [name, value] of Object.entries(module)) {
      if (name.endsWith("_CODE") && typeof value === "string") {
        found.set(value, name);
      }
    }
  }
  return found;
}

interface SurfaceFields extends RefusalFields {
  /** The evidence the refusal carries beside its typed fields. */
  details?: Record<string, unknown>;
  /** A managed slot failure's boot-capacity object. */
  capacity?: Record<string, unknown>;
}

interface SurfaceExpectations {
  fixtures: Record<string, { expected: RefusalDisposition; fields: SurfaceFields }>;
}

interface TypedFields {
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nextAction?: string;
}

/** The typed fields a surface fixture's payload carries, and where they sit on that surface. */
function surfaceTyped(fixture: RefusalSurfaceFixture): {
  typed: TypedFields;
  details?: Record<string, unknown>;
  capacity?: Record<string, unknown>;
} {
  const payload = fixture.payload as Record<string, unknown>;
  if (fixture.surface === "socket-frame") {
    return { typed: payload as TypedFields, details: payload.details as Record<string, unknown> };
  }
  if (fixture.surface === "delete-device") {
    const text = (payload as unknown as RefusalWireResult).content[0].text;
    const failure = (JSON.parse(text) as { failure: Record<string, unknown> }).failure;
    const { code, phase, message, retryable, retryAfterMs, nextAction, ...evidence } = failure;
    expect([phase, typeof message], fixture.name).toEqual(["precondition", "string"]);
    return {
      typed: { code, retryable, retryAfterMs, nextAction } as TypedFields,
      details: Object.keys(evidence).length > 0 ? evidence : undefined,
    };
  }
  const result = payload as unknown as ManagedSlotsResult;
  const failure = result.slots.find((slot) => slot.failure)?.failure ?? result.failure;
  return { typed: failure as TypedFields, capacity: failure?.capacity };
}

function surfaceFields(fixture: RefusalSurfaceFixture): SurfaceFields {
  const { typed, details, capacity } = surfaceTyped(fixture);
  return {
    code: typed.code,
    retryable: typed.retryable === true,
    acquireNewSession: typed.nextAction === "acquire_new_session",
    ...(typeof typed.retryAfterMs === "number" && typed.retryAfterMs > 0
      ? { retryAfterMs: typed.retryAfterMs }
      : {}),
    ...(details ? { details } : {}),
    ...(capacity ? { capacity } : {}),
  };
}

const surfaceFixtures = buildRefusalSurfaceFixtures();
const surfaceExpectations = JSON.parse(
  readFileSync(join(REFUSAL_SURFACES_DIR, "expectations.json"), "utf8"),
) as SurfaceExpectations;

describe("refusal wire contract", () => {
  test("committed fixtures equal what the real TypeScript builders emit", () => {
    for (const fixture of fixtures) {
      const path = join(REFUSAL_FIXTURES_DIR, `${fixture.code}.json`);
      expect(readFileSync(path, "utf8")).toBe(serializeRefusalFixture(fixture));
    }
  });

  test("no stray fixture file exists without a builder", () => {
    const files = readdirSync(REFUSAL_FIXTURES_DIR)
      .filter((name) => name.endsWith(".json") && name !== "expectations.json")
      .map((name) => name.replace(/\.json$/, ""));
    expect(files.sort()).toEqual([...fixtureCodes].sort());
  });

  test("every fixture carries the code it is named for on the wire", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(wireCodes(payload), fixture.code).toEqual(expectedWireCodes(fixture.code));
    }
  });

  test("every provisionDevice failure code has a fixture, bare or prefixed", () => {
    for (const code of Object.keys(DEFAULT_PROVISION_DEVICE_RETRYABILITY)) {
      const present =
        fixtureCodes.includes(code) ||
        fixtureCodes.includes(`${PROVISION_DEVICE_FIXTURE_PREFIX}${code}`);
      expect(present, code).toBe(true);
    }
  });

  test("every managed slot acquisition failure code has a fixture", () => {
    for (const code of managedSlotNestedCodes()) {
      expect(fixtureCodes, code).toContain(`${MANAGED_SLOT_FIXTURE_PREFIX}${code}`);
    }
  });

  test("the expectations agree with the disposition the wire fields imply", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(expectations.codes[fixture.code].expected, fixture.code).toBe(
        deriveDisposition(payload),
      );
    }
  });

  test("the expectations pin the fields each fixture carries on the wire", () => {
    for (const fixture of fixtures) {
      const payload = JSON.parse(fixture.result.content[0].text) as WirePayload;
      expect(expectations.codes[fixture.code].fields, fixture.code).toEqual(readFields(payload));
    }
    const rows = Object.values(expectations.codes).map((row) => row.fields);
    expect(rows.some((fields) => fields.retryAfterMs !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.externalDevices !== undefined)).toBe(true);
    expect(rows.some((fields) => fields.acquireNewSession)).toBe(true);
  });

  test("every refusal code constant has a fixture or a recorded reason it has none", () => {
    const missing: string[] = [];
    for (const [code, constant] of exportedCodeConstants()) {
      if (!fixtureCodes.includes(code) && !(code in UNFIXTURED_REFUSAL_CODES)) {
        missing.push(`${constant} = "${code}"`);
      }
    }
    // Add a builder to test/helpers/refusalWireFixtures.ts, run
    // `bun scripts/generate-refusal-wire-fixtures.ts`, and add a row to expectations.json.
    expect(missing).toEqual([]);
  });

  test("every retryable acquisition code has a fixture", () => {
    for (const code of acquisitionRefusals.RETRYABLE_DEVICE_ACQUISITION_CODES) {
      expect(fixtureCodes).toContain(code);
    }
  });

  test("the expectations table covers exactly the fixtures", () => {
    expect(Object.keys(expectations.codes).sort()).toEqual([...fixtureCodes].sort());
  });

  test("a known gap never repeats the expectation", () => {
    for (const [code, row] of Object.entries(expectations.codes)) {
      for (const actual of Object.values(row.knownGaps ?? {})) {
        expect(actual, code).not.toBe(row.expected);
      }
    }
  });

  describe("surfaces that carry a refusal but are not a tool result", () => {
    test("committed surface fixtures equal what the real serializers emit", () => {
      if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
        mkdirSync(REFUSAL_SURFACES_DIR, { recursive: true });
        for (const fixture of surfaceFixtures) {
          writeFileSync(
            join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`),
            serializeRefusalSurfaceFixture(fixture),
          );
        }
      }
      for (const fixture of surfaceFixtures) {
        const path = join(REFUSAL_SURFACES_DIR, `${surfaceFixtureStem(fixture)}.json`);
        expect(existsSync(path), `${path}; regenerate with UPDATE_CAPTURED_FIXTURES=1`).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(serializeRefusalSurfaceFixture(fixture));
      }
    });

    test("no stray surface fixture exists without a builder", () => {
      const files = readdirSync(REFUSAL_SURFACES_DIR)
        .filter((name) => name.endsWith(".json") && name !== "expectations.json")
        .map((name) => name.replace(/\.json$/, ""));
      expect(files.sort()).toEqual(surfaceFixtures.map(surfaceFixtureStem).sort());
      expect(Object.keys(surfaceExpectations.fixtures).sort()).toEqual(files.sort());
    });

    test("the expectations pin the fields and disposition each surface carries", () => {
      for (const fixture of surfaceFixtures) {
        const stem = surfaceFixtureStem(fixture);
        const row = surfaceExpectations.fixtures[stem];
        const fields = surfaceFields(fixture);
        expect(row.fields, stem).toEqual(fields);
        expect(row.expected, stem).toBe(
          dispositionOf(
            fields.code ?? "",
            fields.retryable,
            fields.acquireNewSession ? "acquire_new_session" : undefined,
          ),
        );
      }
    });

    test("every socket frame carries the code it is named for and its retry intent", () => {
      for (const fixture of surfaceFixtures.filter((f) => f.surface === "socket-frame")) {
        const frame = fixture.payload as { success: boolean; code?: string; retryable?: boolean };
        expect(frame.success, fixture.name).toBe(false);
        expect([frame.code], fixture.name).toEqual(expectedWireCodes(fixture.name));
        expect(typeof frame.retryable, fixture.name).toBe("boolean");
      }
    });

    test("the surfaces cover the shapes the wire gained on 2026-10-10", () => {
      const names = (surface: string) =>
        surfaceFixtures.filter((f) => f.surface === surface).map((f) => f.name);
      expect(names("socket-frame")).toEqual(
        expect.arrayContaining([
          "device_owned_by_other_session",
          "device_outside_bound_session",
          "device_outside_managed_slots",
          "device_assigned_to_managed_slot",
        ]),
      );
      expect(names("delete-device")).toEqual(
        expect.arrayContaining(["device_owned_by_other_daemon", "discovery_incomplete"]),
      );
      expect(names("managed-slots-result")).toContain("capacity_exhausted.capacity_external");
    });
  });
});
