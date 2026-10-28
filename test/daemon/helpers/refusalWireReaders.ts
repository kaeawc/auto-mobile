import { parseJsonUnknown } from "../../helpers/parseJsonUnknown";
import type {
  RefusalDisposition,
  RefusalSurface,
  RefusalSurfaceFixture,
} from "../../helpers/refusalWireFixtures";

/**
 * Readers for the refusal wire fixtures. Each one validates the shape it needs at run time and
 * returns the narrowed value, so a malformed fixture or expectations row fails loudly with its
 * path instead of being asserted into a type.
 */

export interface RefusalFields {
  code?: string;
  retryable: boolean;
  acquireNewSession: boolean;
  retryAfterMs?: number;
  recovering?: boolean;
  externalDevices?: string[];
  heldDevices?: string[];
  dbPath?: string;
  unknownMigrations?: string[];
}

export interface Expectations {
  codes: Record<
    string,
    {
      expected: RefusalDisposition;
      knownGaps?: Record<string, RefusalDisposition>;
      fields: RefusalFields;
    }
  >;
}

export interface SurfaceFields extends Omit<RefusalFields, "retryable"> {
  retryable?: boolean;
  /** The evidence the refusal carries beside its typed fields. */
  details?: Record<string, unknown>;
  /** A broker provisioning failure's boot-capacity object. */
  capacity?: Record<string, unknown>;
  budget?: Record<string, unknown>;
}

export interface SurfaceExpectations {
  fixtures: Record<string, { expected: RefusalDisposition; fields: SurfaceFields }>;
}

export interface TypedFields {
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  nextAction?: string;
}

export interface WirePayload {
  details?: { recovering?: boolean };
  retryAfterMs?: number;
  recovering?: boolean;
  externalDevices?: string[];
  heldDevices?: string[];
  code?: string;
  retryable?: boolean;
  nextAction?: string;
  dbPath?: string;
  unknownMigrations?: string[];
  error?: {
    retryAfterMs?: number;
    recovering?: boolean;
    code?: string;
    retryable?: boolean;
    nextAction?: string;
    acquisitionFailure?: { code?: string } | null;
  };
}

const DISPOSITIONS: readonly RefusalDisposition[] = [
  "wait",
  "acquire-new-session",
  "retry",
  "fail",
];

const SURFACES: readonly RefusalSurface[] = [
  "socket-frame",
  "delete-device",
  "overload-frame",
  "webrtc-stream-response",
  "aux-socket-response",
  "device-loss-outcome",
  "device-session-error-fields",
  "recording-start-result",
  "proxy-tool-result",
  "request-failure-fields",
  "liveness-handover",
  "provision-envelope",
  "press-button-result",
];

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function optionalRecord(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return value === undefined ? undefined : requireRecord(value, `${label}.${key}`);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label}.${key} is not a string`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value !== undefined && typeof value !== "number") {
    throw new Error(`${label}.${key} is not a number`);
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = record[key];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${label}.${key} is not a boolean`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = optionalBoolean(record, key, label);
  if (value === undefined) {
    throw new Error(`${label}.${key} is missing`);
  }
  return value;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${key} is not an array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} holds a non-string`);
    }
    return entry;
  });
}

function requireDisposition(
  record: Record<string, unknown>,
  key: string,
  label: string,
): RefusalDisposition {
  const disposition = DISPOSITIONS.find((candidate) => candidate === record[key]);
  if (disposition === undefined) {
    throw new Error(`${label}.${key} is not a disposition`);
  }
  return disposition;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(`${label} has unexpected keys: ${extra.join(", ")}`);
  }
}

/** The text of a tool result's first content block, which carries the JSON body. */
export function resultText(result: unknown): string {
  const { content } = requireRecord(result, "tool result");
  if (!Array.isArray(content)) {
    throw new Error("tool result has no content blocks");
  }
  const text = requireRecord(content[0], "tool result content[0]").text;
  if (typeof text !== "string") {
    throw new Error("tool result content[0] has no text");
  }
  return text;
}

/** The JSON body of a tool result's first content block. */
export function resultJson(result: unknown): unknown {
  return parseJsonUnknown(resultText(result));
}

export function readTypedFields(value: unknown, label = "typed fields"): TypedFields {
  const record = requireRecord(value, label);
  const code = optionalString(record, "code", label);
  const retryable = optionalBoolean(record, "retryable", label);
  const retryAfterMs = optionalNumber(record, "retryAfterMs", label);
  const nextAction = optionalString(record, "nextAction", label);
  return {
    ...(code === undefined ? {} : { code }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(nextAction === undefined ? {} : { nextAction }),
  };
}

export function readWirePayload(value: unknown): WirePayload {
  const record = requireRecord(value, "wire payload");
  const details = optionalRecord(record, "details", "wire payload");
  const envelope =
    typeof record.error === "object" && record.error !== null
      ? optionalRecord(record, "error", "wire payload")
      : undefined;
  const acquisition = envelope?.acquisitionFailure;
  return {
    ...(details
      ? { details: { recovering: optionalBoolean(details, "recovering", "details") } }
      : {}),
    retryAfterMs: optionalNumber(record, "retryAfterMs", "wire payload"),
    recovering: optionalBoolean(record, "recovering", "wire payload"),
    externalDevices: optionalStringArray(record, "externalDevices", "wire payload"),
    heldDevices: optionalStringArray(record, "heldDevices", "wire payload"),
    code: optionalString(record, "code", "wire payload"),
    retryable: optionalBoolean(record, "retryable", "wire payload"),
    nextAction: optionalString(record, "nextAction", "wire payload"),
    dbPath: optionalString(record, "dbPath", "wire payload"),
    unknownMigrations: optionalStringArray(record, "unknownMigrations", "wire payload"),
    ...(envelope
      ? {
          error: {
            retryAfterMs: optionalNumber(envelope, "retryAfterMs", "wire error"),
            recovering: optionalBoolean(envelope, "recovering", "wire error"),
            code: optionalString(envelope, "code", "wire error"),
            retryable: optionalBoolean(envelope, "retryable", "wire error"),
            nextAction: optionalString(envelope, "nextAction", "wire error"),
            acquisitionFailure:
              acquisition === undefined || acquisition === null
                ? acquisition
                : {
                    code: optionalString(
                      requireRecord(acquisition, "acquisitionFailure"),
                      "code",
                      "acquisitionFailure",
                    ),
                  },
          },
        }
      : {}),
  };
}

/** The wire payload of a tool result's JSON body. */
export function wirePayloadOf(result: unknown): WirePayload {
  return readWirePayload(resultJson(result));
}

function readFieldRecord(record: Record<string, unknown>, label: string) {
  const code = optionalString(record, "code", label);
  const retryAfterMs = optionalNumber(record, "retryAfterMs", label);
  const recovering = optionalBoolean(record, "recovering", label);
  const externalDevices = optionalStringArray(record, "externalDevices", label);
  const heldDevices = optionalStringArray(record, "heldDevices", label);
  const dbPath = optionalString(record, "dbPath", label);
  const unknownMigrations = optionalStringArray(record, "unknownMigrations", label);
  return {
    ...(code === undefined ? {} : { code }),
    acquireNewSession: requireBoolean(record, "acquireNewSession", label),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(recovering === undefined ? {} : { recovering }),
    ...(externalDevices === undefined ? {} : { externalDevices }),
    ...(heldDevices === undefined ? {} : { heldDevices }),
    ...(dbPath === undefined ? {} : { dbPath }),
    ...(unknownMigrations === undefined ? {} : { unknownMigrations }),
  };
}

const FIELD_KEYS = [
  "code",
  "retryable",
  "acquireNewSession",
  "retryAfterMs",
  "recovering",
  "externalDevices",
  "heldDevices",
  "dbPath",
  "unknownMigrations",
] as const;

function readRefusalFields(value: unknown, label: string): RefusalFields {
  const record = requireRecord(value, label);
  rejectUnknownKeys(record, FIELD_KEYS, label);
  return {
    ...readFieldRecord(record, label),
    retryable: requireBoolean(record, "retryable", label),
  };
}

function readSurfaceFieldsRow(value: unknown, label: string): SurfaceFields {
  const record = requireRecord(value, label);
  rejectUnknownKeys(record, [...FIELD_KEYS, "details", "capacity", "budget"], label);
  const retryable = optionalBoolean(record, "retryable", label);
  const details = optionalRecord(record, "details", label);
  const capacity = optionalRecord(record, "capacity", label);
  const budget = optionalRecord(record, "budget", label);
  return {
    ...readFieldRecord(record, label),
    ...(retryable === undefined ? {} : { retryable }),
    ...(details ? { details } : {}),
    ...(capacity ? { capacity } : {}),
    ...(budget ? { budget } : {}),
  };
}

export function readExpectations(text: string): Expectations {
  const root = requireRecord(parseJsonUnknown(text), "expectations");
  const rows = requireRecord(root.codes, "expectations.codes");
  return {
    codes: Object.fromEntries(
      Object.entries(rows).map(([code, row]) => {
        const label = `expectations.codes.${code}`;
        const record = requireRecord(row, label);
        const knownGaps = optionalRecord(record, "knownGaps", label);
        return [
          code,
          {
            expected: requireDisposition(record, "expected", label),
            ...(knownGaps
              ? {
                  knownGaps: Object.fromEntries(
                    Object.keys(knownGaps).map((gap) => [
                      gap,
                      requireDisposition(knownGaps, gap, label),
                    ]),
                  ),
                }
              : {}),
            fields: readRefusalFields(record.fields, `${label}.fields`),
          },
        ];
      }),
    ),
  };
}

export function readSurfaceExpectations(text: string): SurfaceExpectations {
  const root = requireRecord(parseJsonUnknown(text), "surface expectations");
  const rows = requireRecord(root.fixtures, "surface expectations.fixtures");
  return {
    fixtures: Object.fromEntries(
      Object.entries(rows).map(([stem, row]) => {
        const label = `surface expectations.fixtures.${stem}`;
        const record = requireRecord(row, label);
        return [
          stem,
          {
            expected: requireDisposition(record, "expected", label),
            fields: readSurfaceFieldsRow(record.fields, `${label}.fields`),
          },
        ];
      }),
    ),
  };
}

/** A committed surface fixture file: `{ surface, name, builder, payload }`. */
export function readSurfaceFixture(text: string): RefusalSurfaceFixture {
  const record = requireRecord(parseJsonUnknown(text), "surface fixture");
  const surface = SURFACES.find((candidate) => candidate === record.surface);
  const name = optionalString(record, "name", "surface fixture");
  const builder = optionalString(record, "builder", "surface fixture");
  if (surface === undefined || name === undefined || builder === undefined) {
    throw new Error("surface fixture is missing its surface, name or builder");
  }
  return { surface, name, builder, payload: record.payload };
}

/** The failure of a broker bindings result: the first binding's, else the scope-level one. */
export function bindingsFailure(payload: Record<string, unknown>): Record<string, unknown> {
  const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
  for (const binding of bindings) {
    const failure = requireRecord(binding, "binding").failure;
    if (failure) {
      return requireRecord(failure, "binding failure");
    }
  }
  return requireRecord(payload.failure, "bindings result failure");
}
