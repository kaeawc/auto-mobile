import { expect, test } from "bun:test";
import { isProductBrokerDevice } from "../../../src/daemon/sessionBroker/persistedIdentity";
import { bindingDeviceName } from "../../../src/daemon/sessionBroker/provisioning/reconciler";

test.each(["ambroker-scope-0-g1-nonce", "amslot-scope-0-g1-nonce"])(
  "recognizes product device %s",
  (name) => expect(isProductBrokerDevice(name)).toBe(true),
);

test.each(["amslotx", "AMSLOT-", "xambroker-", "ambrokerx", "", "Pixel_8"])(
  "rejects look-alike %s",
  (name) => expect(isProductBrokerDevice(name)).toBe(false),
);

test("only new broker names are generated", () => {
  expect(bindingDeviceName({ scopeKey: "0123456789", bindingIndex: 3 }, 2, "nonce")).toBe(
    "ambroker-01234567-3-g2-nonce",
  );
});
