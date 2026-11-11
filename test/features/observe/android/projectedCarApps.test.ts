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

  test("a started and bound service keeps its bindings past its indent-1 startCommandResult line", () => {
    const lines = projectionServicesDump("one").split(/\r?\n/);
    const start = lines.findIndex((line) =>
      line.includes(
        "* ServiceRecord{5215844 u0 com.google.android.gms/com.google.android.location.internal.GoogleLocationManagerService",
      ),
    );
    const end = lines.findIndex(
      (line, index) => index > start && line.includes("* ServiceRecord{"),
    );
    const service = lines.slice(start, end);
    const startCommandAt = service.indexOf(" startCommandResult=1");
    const gearheadAt = service.findIndex((line) =>
      line.includes(":com.google.android.projection.gearhead:car/"),
    );
    expect(startCommandAt).toBeGreaterThan(0);
    expect(gearheadAt).toBeGreaterThan(startCommandAt);

    expect(parseProjectedCarApps(service.join("\n"))).toEqual([
      { packageName: "com.google.android.gms", userId: 0 },
    ]);
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
