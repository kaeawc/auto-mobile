import { describe, expect, test } from "bun:test";
import fixture from "../../fixtures/prototype-spec/ble/codecs.json";
import {
  MAX_PROTOTYPE_BLE_VALUE_BYTES,
  PROTOTYPE_BLE_CODECS,
  decodePrototypeBleValue,
  encodePrototypeBleValue,
} from "../../../src/features/prototype/prototypeBleCodecs";

interface CodecCase {
  name: string;
  codec: string;
  op: string;
  input: unknown;
  expected?: unknown;
  error?: string;
}

const cases: CodecCase[] = fixture.cases;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

function actual(codecCase: CodecCase): unknown {
  if (codecCase.op === "decode") {
    return decodePrototypeBleValue(codecCase.codec, bytes(String(codecCase.input)));
  }
  const result = encodePrototypeBleValue(codecCase.codec, codecCase.input);
  return result.ok ? { ok: true, value: hex(result.value) } : result;
}

describe("BLE codecs (#14266)", () => {
  test("the codec list and attribute limit match the shared fixture", () => {
    const codecs: string[] = [...PROTOTYPE_BLE_CODECS];
    expect(codecs).toEqual(fixture.codecs);
    expect(MAX_PROTOTYPE_BLE_VALUE_BYTES).toBe(fixture.maxBytes);
  });

  for (const codecCase of cases) {
    test(codecCase.name, () => {
      const expected: unknown =
        codecCase.error === undefined
          ? { ok: true, value: codecCase.expected }
          : { ok: false, error: codecCase.error };
      expect(actual(codecCase)).toEqual(expected);
    });
  }
});
