import { describe, expect, test } from "bun:test";
import { parseProjectedCarApps } from "../../../../src/features/observe/android/projectedCarApps";
import { projectionServicesDump } from "../../../helpers/androidAutoProjectionFixtures";

describe("parseProjectedCarApps (#17826)", () => {
  test("lists every app with a live Android Auto binding from the captured dump, not Android Auto itself", () => {
    expect(parseProjectedCarApps(projectionServicesDump("one"))).toEqual([
      { packageName: "com.android.vending", userId: 0 },
      { packageName: "com.google.android.apps.maps", userId: 0 },
      { packageName: "com.google.android.apps.youtube.music", userId: 0 },
      { packageName: "com.google.android.gms", userId: 0 },
      { packageName: "com.google.android.googlequicksearchbox", userId: 0 },
      { packageName: "dev.jasonpearson.automobile.automotivefixture", userId: 0 },
    ]);
  });

  test("a dump taken after projection ended has no projected apps", () => {
    expect(parseProjectedCarApps(projectionServicesDump("none"))).toEqual([]);
  });

  test("a block ends at an outer line, so a later section's client is not attributed to it", () => {
    const dump = [
      "  * ServiceRecord{1 u0 com.example.car/.CarSvc}",
      "    intent={id=0/main cmp=com.example.car/.CarSvc}",
      "  Connection bindings to services:",
      "      * Client AppBindRecord{2 ProcessRecord{3 5120:com.google.android.projection.gearhead:car/u0a1}}",
    ].join("\n");
    expect(parseProjectedCarApps(dump)).toEqual([]);
  });

  test("a c: caller header without a live Android Auto binding is not projected", () => {
    const dump = [
      "  * ServiceRecord{1 u0 com.example.car/.CarSvc c:com.google.android.projection.gearhead}",
      "    intent={id=0/main cmp=com.example.car/.CarSvc}",
      "    * IntentBindRecord{2 CREATE}:",
      "      * Client AppBindRecord{3 ProcessRecord{4 7400:com.example.tester/u0a240}}",
    ].join("\n");
    expect(parseProjectedCarApps(dump)).toEqual([]);
  });

  test("empty or unrelated output yields no apps", () => {
    expect(parseProjectedCarApps("")).toEqual([]);
    expect(parseProjectedCarApps("Permission Denial: can't dump ActivityManager")).toEqual([]);
  });
});
