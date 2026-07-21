import { describe, it, expect, afterEach } from "bun:test";
import {
  DEVICE_CREATE_ENV_VAR,
  EnvDeviceCreationGate,
  getDeviceCreationGate,
  isTruthyCreationEnvValue,
  resetDeviceCreationGate,
  setDeviceCreationGate,
} from "../../src/utils/deviceCreationGate";
import { FakeDeviceCreationGate, FakeEnvironmentReader } from "../fakes/FakeDeviceCreationGate";

function gateWithEnv(value: string | undefined): EnvDeviceCreationGate {
  return new EnvDeviceCreationGate(new FakeEnvironmentReader({ [DEVICE_CREATE_ENV_VAR]: value }));
}

describe("device creation gate", () => {
  afterEach(() => {
    resetDeviceCreationGate();
  });

  it("is off by default when neither flag nor env var is set", () => {
    expect(gateWithEnv(undefined).isCreationAllowed()).toBe(false);
    expect(gateWithEnv(undefined).isCreationAllowed(undefined)).toBe(false);
  });

  describe("precedence matrix (flag x env)", () => {
    const cases: { flag: boolean | undefined; env: string | undefined; expected: boolean }[] = [
      { flag: undefined, env: undefined, expected: false },
      { flag: undefined, env: "1", expected: true },
      { flag: undefined, env: "true", expected: true },
      { flag: undefined, env: "0", expected: false },
      { flag: undefined, env: "false", expected: false },
      { flag: true, env: undefined, expected: true },
      { flag: true, env: "0", expected: true },
      { flag: true, env: "false", expected: true },
      { flag: false, env: undefined, expected: false },
      { flag: false, env: "1", expected: false },
      { flag: false, env: "true", expected: false },
    ];

    for (const { flag, env, expected } of cases) {
      it(`flag=${String(flag)} env=${String(env)} -> ${expected}`, () => {
        expect(gateWithEnv(env).isCreationAllowed(flag)).toBe(expected);
      });
    }
  });

  it("accepts 1/true case-insensitively and tolerates whitespace", () => {
    expect(isTruthyCreationEnvValue("TRUE")).toBe(true);
    expect(isTruthyCreationEnvValue("  1 ")).toBe(true);
    expect(isTruthyCreationEnvValue("True")).toBe(true);
    expect(isTruthyCreationEnvValue("yes")).toBe(false);
    expect(isTruthyCreationEnvValue("on")).toBe(false);
    expect(isTruthyCreationEnvValue("")).toBe(false);
    expect(isTruthyCreationEnvValue(undefined)).toBe(false);
  });

  it("describes which source decided", () => {
    expect(gateWithEnv(undefined).describeSource()).toBe("default (off)");
    expect(gateWithEnv("1").describeSource()).toBe(`${DEVICE_CREATE_ENV_VAR}=1`);
    expect(gateWithEnv("1").describeSource(false)).toBe("--create-if-missing=false");
  });

  it("supports injecting a gate through the module seam", () => {
    const fake = new FakeDeviceCreationGate(true);
    setDeviceCreationGate(fake);
    expect(getDeviceCreationGate().isCreationAllowed()).toBe(true);
    resetDeviceCreationGate();
    // Back to the real env-backed gate, which is off in the test environment.
    expect(getDeviceCreationGate().isCreationAllowed(false)).toBe(false);
  });
});
