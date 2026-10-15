import { expect, test } from "bun:test";
import { isSessionBrokerDeviceName } from "../../../src/daemon/sessionBroker/deviceNaming";

test("recognizes current and legacy broker device names", () => {
  for (const name of ["ambroker-039fd12f-0-g1-nonce", "amslot-039fd12f-0-g1-nonce"]) {
    expect(isSessionBrokerDeviceName(name)).toBe(true);
  }
  for (const name of ["", "ambroker", "amslot", "phone", "my-ambroker-phone", "AMBROKER-phone"]) {
    expect(isSessionBrokerDeviceName(name)).toBe(false);
  }
});
