import { z as z3 } from "zod/v3";
import { z } from "zod/v4";

/** Carries an authored own `__proto__` entry through the intersection merge. */
const OWN_PROTO_ENTRY = Symbol("prototypeOwnProtoEntry");

type ProtoCarrier = { [OWN_PROTO_ENTRY]?: unknown };

function carryOwnProtoEntry(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  // The record side owns every other key; contributing none keeps the merge to that output.
  const entry = Object.getOwnPropertyDescriptor(raw, "__proto__");
  return entry ? { [OWN_PROTO_ENTRY]: entry.value } : {};
}

/**
 * `z.record(keySchema, valueSchema)` that keeps an authored own `__proto__` key.
 *
 * Zod 4.6 skips a `__proto__` key in records and strips it in intersection merges
 * (its bundled `zod/v3` strips it in merges too), so `z.record(...).and(z.unknown())`
 * no longer keeps it. Prototype specs, events
 * and outputs treat every authored name as data (#16102): this validates the
 * `__proto__` entry with the same key and value schemas and writes it back as an
 * own data property. The JSON Schema stays the record's.
 */
export function prototypeOwnKeyRecord<K extends z.core.$ZodRecordKey, V extends z.ZodType>(
  keySchema: K,
  valueSchema: V,
) {
  return z
    .record(keySchema, valueSchema)
    .and(z.unknown().overwrite(carryOwnProtoEntry))
    .check((ctx) => {
      const merged = ctx.value as Record<string, unknown> & ProtoCarrier;
      if (!Object.hasOwn(merged, OWN_PROTO_ENTRY)) {
        return;
      }
      const raw = merged[OWN_PROTO_ENTRY];
      delete merged[OWN_PROTO_ENTRY];
      const key = z.safeParse(keySchema, "__proto__");
      const value = valueSchema.safeParse(raw);
      const issues = [
        ...(key.success ? [] : key.error.issues),
        ...(value.success ? [] : value.error.issues),
      ];
      if (issues.length > 0) {
        ctx.issues.push(
          ...issues.map(
            (issue) =>
              ({
                ...issue,
                path: ["__proto__", ...issue.path],
                input: raw,
              }) as z.core.$ZodRawIssue,
          ),
        );
        return;
      }
      Object.defineProperty(merged, "__proto__", {
        value: value.data,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
}

/** {@link prototypeOwnKeyRecord} for the `zod/v3` prototype spec schemas. */
export function prototypeOwnKeyRecordV3<K extends z3.ZodType<string>, V extends z3.ZodTypeAny>(
  keySchema: K,
  valueSchema: V,
) {
  return z3
    .record(keySchema, valueSchema)
    .and(z3.unknown().transform(carryOwnProtoEntry))
    .transform((merged, ctx) => {
      const record = merged as Record<string, z3.output<V>> & ProtoCarrier;
      if (!Object.hasOwn(record, OWN_PROTO_ENTRY)) {
        return record;
      }
      const raw = record[OWN_PROTO_ENTRY];
      delete record[OWN_PROTO_ENTRY];
      const key = keySchema.safeParse("__proto__");
      const value = valueSchema.safeParse(raw);
      const issues = [
        ...(key.success ? [] : key.error.issues),
        ...(value.success ? [] : value.error.issues),
      ];
      if (issues.length > 0 || !value.success) {
        issues.forEach((issue) =>
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            path: ["__proto__", ...issue.path],
            message: issue.message,
          }),
        );
        return z3.NEVER;
      }
      Object.defineProperty(record, "__proto__", {
        value: value.data,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return record;
    });
}
