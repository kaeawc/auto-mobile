import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeGateCapabilities,
  prototypeRequiredCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeRequestEventOf } from "../../../src/features/prototype/prototypeRequestEvent";
import {
  MAX_PROTOTYPE_UPLOAD_BYTES,
  MAX_PROTOTYPE_UPLOAD_PARTS,
} from "../../../src/features/prototype/prototypeRequestLimits";
import type { PrototypeStrictOptions } from "../../../src/features/prototype/prototypeStrictPolicy";
import { requestActionSchema } from "../../../src/features/prototype/prototypeRequestSchema";
import patterns from "../../fixtures/prototype-spec/patterns.json";
import corpus from "../../fixtures/prototype-spec/corpus.json";

const fixture = (kind: string, name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/prototype-spec/${kind}/${name}`, import.meta.url), "utf8"),
  );
// Load shared data outside each pure validator assertion's timing budget.
const valid = corpus.valid
  .filter((name) => name.startsWith("request-upload"))
  .map((name) => ({ name, spec: fixture("valid", name) }));
const invalid = corpus.invalid
  .filter((name) => name.startsWith("request-upload"))
  .map((name) => ({
    name,
    entry: fixture("invalid", name) as {
      spec: unknown;
      expectedPath: string;
      options?: PrototypeStrictOptions;
    },
  }));

describe("upload request contract", () => {
  for (const { name, spec } of valid) {
    test(name, () => {
      expect(validatePrototypeSpec(spec).success).toBe(true);
      expect(prototypeRequiredCapabilities(spec).map((gate) => gate.capability)).toContain(
        "prototype_network_upload_v1",
      );
    });
  }
  for (const { name, entry } of invalid) {
    test(name, () => {
      const result = validatePrototypeSpec(entry.spec, {
        ...entry.options,
        requiredCapabilities: prototypeGateCapabilities,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.path).toBe(entry.expectedPath);
      }
    });
  }
  for (const verdict of ["accepted", "rejected"] as const) {
    for (const value of patterns.uploadDisposition[verdict]) {
      test(`Zod upload disposition ${verdict} ${JSON.stringify(value)}`, () => {
        for (const field of ["name", "filename"]) {
          const part = { name: "photo", file: { asset: "hero" }, [field]: value };
          expect(
            requestActionSchema.safeParse({
              type: "request",
              method: "POST",
              url: "https://example.com",
              body: { multipart: [part] },
            }).success,
          ).toBe(verdict === "accepted");
        }
      });
    }
    for (const value of patterns.uploadContentType[verdict]) {
      test(`Zod upload media type ${verdict} ${JSON.stringify(value)}`, () => {
        for (const body of [
          { file: { asset: "hero" }, contentType: value },
          { multipart: [{ name: "photo", file: { asset: "hero" }, contentType: value }] },
        ]) {
          expect(
            requestActionSchema.safeParse({
              type: "request",
              method: "POST",
              url: "https://example.com",
              body,
            }).success,
          ).toBe(verdict === "accepted");
        }
      });
    }
  }
  test("shared upload limits", () => {
    expect(MAX_PROTOTYPE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_PROTOTYPE_UPLOAD_PARTS).toBe(16);
  });
  test("request event accepts only nonnegative integral upload byte counts", () => {
    const payload = {
      requestId: "upload",
      method: "POST",
      url: "https://example.com",
      via: "host",
      outcome: "success",
      durationMs: 1,
    };
    const event = (uploadBytes: number) =>
      prototypeRequestEventOf({
        kind: "emit",
        name: "prototype_request",
        payload: { ...payload, uploadBytes },
      });
    expect(event(10485760)?.uploadBytes).toBe(10485760);
    expect(event(-1)).toBeUndefined();
    expect(event(0.5)).toBeUndefined();
  });
});
