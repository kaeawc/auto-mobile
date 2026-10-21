import { describe, expect, test } from "bun:test";
import {
  AMBIENT_ENV_REGISTRY,
  ENV,
  ENV_REGISTRY,
  readEnvBool,
  readEnvEnum,
  readEnvList,
  readEnvNumber,
  type EnvVarSpec,
} from "../../src/config/env";
import { readEnvInt } from "../../src/utils/envNumbers";

const FLAG: EnvVarSpec = {
  name: "T_FLAG",
  legacyName: "OLD_FLAG",
  kind: "bool",
  default: "off",
  doc: "x",
};
const MODE: EnvVarSpec = {
  name: "T_MODE",
  kind: "enum",
  default: "a",
  doc: "x",
  values: ["a", "b"],
};
const LIST: EnvVarSpec = { name: "T_LIST", kind: "list", default: "", doc: "x" };
const silent = { warn: () => {} };

describe("typed env readers", () => {
  test.each([
    ["1", true],
    [" TRUE ", true],
    ["yes", true],
    ["0", false],
    ["", false],
    [undefined, false],
  ])("bool %p -> %p", (value, expected) => {
    expect(readEnvBool(FLAG, { T_FLAG: value })).toBe(expected);
  });

  test("bool falls back to the legacy name", () => {
    expect(readEnvBool(FLAG, { OLD_FLAG: "1" })).toBe(true);
  });

  // #11848: one truthiness rule, so `1`, `true` and `TRUE` mean the same thing for every flag.
  test("every registered bool flag shares one truthiness table", () => {
    const flags = [...ENV_REGISTRY, ...AMBIENT_ENV_REGISTRY].filter((spec) => spec.kind === "bool");
    expect(flags.map((spec) => spec.name)).toContain(ENV.CTRLPROXY_VERBOSE.name);
    const table: ReadonlyArray<readonly [string | undefined, boolean]> = [
      ["1", true],
      ["true", true],
      ["TRUE", true],
      ["on", true],
      ["0", false],
      ["false", false],
      [undefined, false],
    ];
    for (const spec of flags) {
      for (const name of [spec.name, spec.legacyName].filter((n) => n !== undefined)) {
        for (const [value, expected] of table) {
          expect([name, value, readEnvBool(spec, { [name]: value })]).toEqual([
            name,
            value,
            expected,
          ]);
        }
      }
    }
  });

  test("number honours zero, exclusive minimums, fractions and reports invalid text", () => {
    const invalid: string[] = [];
    const record = (raw: string) => invalid.push(raw);
    const nonNegative = ENV.PRIVATE_DAEMON_ORPHAN_IDLE_MS;
    const name = nonNegative.name;
    expect(readEnvNumber(nonNegative, { [name]: "0" }, record)).toBe(0);
    expect(readEnvNumber(nonNegative, { [name]: "-1" }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, { [name]: "abc" }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, { [name]: "  " }, record)).toBeUndefined();
    expect(readEnvNumber(nonNegative, {}, record)).toBeUndefined();
    expect(invalid).toEqual(["-1", "abc"]);
    const positive = ENV.OBSERVE_PERF_WINDOW_MS;
    expect(readEnvNumber(positive, { [positive.name]: "0" })).toBeUndefined();
    expect(readEnvNumber(positive, { [positive.name]: "2500.5" })).toBe(2500.5);
  });

  test("int is strict, uses spec.fallback or the caller's, and warns through the injected log", () => {
    const warnings: string[] = [];
    const log = { warn: (message: string) => warnings.push(message) };
    const spec = ENV.DOCTOR_TIMEOUT_MS;
    expect(readEnvInt(spec, { [spec.name]: "2m" }, { log })).toBe(5000);
    expect(warnings).toHaveLength(1);
    expect(readEnvInt(spec, { [spec.name]: "7000" }, { log: silent })).toBe(7000);
    expect(readEnvInt(spec, {}, { fallback: 9, log: silent })).toBe(9);
    const port = ENV.PORT_RANGE_START;
    expect(
      readEnvInt(port, { AUTO_MOBILE_PORT_RANGE_START: "9000" }, { fallback: 1, log: silent }),
    ).toBe(9000);
  });

  test("enum accepts only declared values, case-insensitively", () => {
    expect(readEnvEnum(MODE, { T_MODE: " B " })).toBe("b");
    expect(readEnvEnum(MODE, { T_MODE: "c" })).toBeUndefined();
    expect(readEnvEnum(MODE, {})).toBeUndefined();
  });

  test("list trims entries and drops blanks", () => {
    expect(readEnvList(LIST, { T_LIST: " a, ,b ,," })).toEqual(["a", "b"]);
    expect(readEnvList(LIST, {})).toEqual([]);
  });
});
