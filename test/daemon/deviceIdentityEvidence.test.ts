import { describe, expect, test } from "bun:test";
import {
  compareIdentityEvidence,
  deriveEvidenceFromBootedDevice,
  deriveEvidenceFromPooledDevice,
} from "../../src/daemon/deviceIdentityEvidence";

describe("device identity evidence", () => {
  test("orders stamped, unstamped, and unresolved observations", () => {
    expect(
      compareIdentityEvidence(
        { stableId: "Pixel_8", observedAt: 4, unresolved: false },
        { stableId: "Pixel_7", observedAt: 3, unresolved: false },
      ),
    ).toBe("stale");
    expect(
      compareIdentityEvidence(
        { stableId: "Pixel_8", observedAt: 4, unresolved: false },
        { observedAt: 4, unresolved: true },
      ),
    ).toBe("equal");
    expect(
      compareIdentityEvidence(
        { stableId: "Pixel_8", observedAt: 4, unresolved: false },
        { observedAt: 5, unresolved: true },
      ),
    ).toBe("unresolved-newer");
    expect(
      compareIdentityEvidence(
        { stableId: "Pixel_8", observedAt: 4, unresolved: false },
        { stableId: "Pixel_7", unresolved: false },
      ),
    ).toBe("newer");
  });

  test("treats Android raw serial names as unresolved without weakening resolved labels", () => {
    expect(
      deriveEvidenceFromBootedDevice(
        { deviceId: "emulator-5554", name: "emulator-5554", platform: "android", observedAt: 4 },
        false,
      ),
    ).toEqual({ observedAt: 4, unresolved: true });
    expect(
      deriveEvidenceFromBootedDevice(
        { deviceId: "emulator-5554", name: "Pixel_8_API_35", platform: "android", observedAt: 4 },
        false,
      ),
    ).toEqual({ stableId: "Pixel_8_API_35", observedAt: 4, unresolved: false });
    expect(
      deriveEvidenceFromPooledDevice({ identityObservedAt: 5, identityUnresolved: true }),
    ).toEqual({ observedAt: 5, unresolved: true });
  });
});
