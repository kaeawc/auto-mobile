import { describe, expect, test } from "bun:test";
import { missingAssetsWarning } from "../../../src/features/overlay/overlayMissingAssets";

describe("missingAssetsWarning", () => {
  test("tells the caller which unsupplied ids to upload", () => {
    const warning = missingAssetsWarning({ missing: ["a", "b"], supplied: new Set() });
    expect(warning).toContain("'a', 'b'");
    expect(warning).toContain("Upload them with assets");
    expect(warning).not.toContain("supplied on this call");
  });

  test("separates supplied ids that stayed missing after the retry", () => {
    const warning = missingAssetsWarning({
      missing: ["a", "b"],
      supplied: new Set(["b"]),
      repair: { kind: "still-missing" },
    });
    expect(warning).toContain("overlay asset(s) 'a'");
    expect(warning).toContain("Asset(s) 'b' were supplied");
    expect(warning).toContain("re-uploaded and the overlay re-sent once");
  });

  test("includes the reason when the repair did not complete", () => {
    const warning = missingAssetsWarning({
      missing: ["a"],
      supplied: new Set(["a"]),
      repair: { kind: "retry-failed", reason: "store full" },
    });
    expect(warning).toContain("did not complete: store full");
  });
});
