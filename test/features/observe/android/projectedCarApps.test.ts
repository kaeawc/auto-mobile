import { describe, expect, test } from "bun:test";
import { parseProjectedCarApps } from "../../../../src/features/observe/android/projectedCarApps";
import { projectionServicesDump } from "../../../helpers/androidAutoProjectionFixtures";

describe("parseProjectedCarApps (#17826)", () => {
  test("finds the CarAppService Android Auto bound, not its own, a media service or another client's", () => {
    expect(parseProjectedCarApps(projectionServicesDump("one"))).toEqual([
      { packageName: "dev.jasonpearson.automobile.automotivefixture", userId: 0 },
    ]);
  });

  test("lists two bound apps by package name with the user each service runs as", () => {
    expect(parseProjectedCarApps(projectionServicesDump("two"))).toEqual([
      { packageName: "com.example.nav", userId: 10 },
      { packageName: "dev.jasonpearson.automobile.automotivefixture", userId: 0 },
    ]);
  });

  test("Android Auto's own template services are not projected apps", () => {
    expect(parseProjectedCarApps(projectionServicesDump("none"))).toEqual([]);
  });

  test("a block ends at an outer line, so a later section's client is not attributed to it", () => {
    const dump = [
      "  * ServiceRecord{1 u0 com.example.car/.CarSvc}",
      "    intent={act=androidx.car.app.CarAppService cmp=com.example.car/.CarSvc}",
      "  Connection bindings to services:",
      "      * Client AppBindRecord{2 ProcessRecord{3 5120:com.google.android.projection.gearhead:car/u0a1}}",
    ].join("\n");
    expect(parseProjectedCarApps(dump)).toEqual([]);
  });

  test("empty or unrelated output yields no apps", () => {
    expect(parseProjectedCarApps("")).toEqual([]);
    expect(parseProjectedCarApps("Permission Denial: can't dump ActivityManager")).toEqual([]);
  });
});
