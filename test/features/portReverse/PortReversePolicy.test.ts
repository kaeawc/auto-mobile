import { describe, expect, test } from "bun:test";
import {
  assertPortsAllowed,
  portReversePolicyFromEnv,
} from "../../../src/features/portReverse/PortReversePolicy";

describe("PortReversePolicy", () => {
  test("privileged ports are refused even without an allowlist", () => {
    expect(() => assertPortsAllowed({}, [80, 8080])).toThrow("Refused to reverse port(s) 80");
    expect(() => assertPortsAllowed({}, [1024, 65535])).not.toThrow();
  });

  test("the env allowlist accepts ports and inclusive ranges", () => {
    const policy = portReversePolicyFromEnv({
      AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS: " 3000-3999, 8080 ",
    });
    expect(() => assertPortsAllowed(policy, [3000, 3999, 8080])).not.toThrow();
    expect(() => assertPortsAllowed(policy, [4000])).toThrow("4000");
  });

  test("an invalid allowlist entry fails closed", () => {
    const policy = portReversePolicyFromEnv({ AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS: "3000,abc" });
    expect(policy.allowed).toEqual([]);
    expect(() => assertPortsAllowed(policy, [3000])).toThrow();
  });

  test("unset or blank allows every unprivileged port", () => {
    expect(portReversePolicyFromEnv({})).toEqual({});
    expect(portReversePolicyFromEnv({ AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS: " " })).toEqual({});
  });
});
