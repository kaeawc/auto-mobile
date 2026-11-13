import { describe, expect, test } from "bun:test";
import { PrototypeAssetPutLedger } from "../../../src/features/prototype/prototypeAssetPutLedger";

describe("PrototypeAssetPutLedger", () => {
  test("only the newest put of a device and id settles as latest", () => {
    const ledger = new PrototypeAssetPutLedger();
    const older = ledger.begin("sim-1", "shot");
    const newer = ledger.begin("sim-1", "shot");
    expect(older()).toBe(false);
    expect(newer()).toBe(true);
  });

  test("keys are per device and id, and a settled key is released", () => {
    const ledger = new PrototypeAssetPutLedger();
    const first = ledger.begin("sim-1", "shot");
    const otherDevice = ledger.begin("sim-2", "shot");
    const otherId = ledger.begin("sim-1", "logo");
    expect(first()).toBe(true);
    expect(otherDevice()).toBe(true);
    expect(otherId()).toBe(true);
    const again = ledger.begin("sim-1", "shot");
    expect(again()).toBe(true);
  });
});
