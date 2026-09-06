import { describe, expect, test } from "bun:test";
import {
  extractIosApplicationType,
  filterAppsByQuery,
  parseAppsQueryParams,
  type AppsQueryAppInfo,
} from "../../src/server/appResources";

const userApp: AppsQueryAppInfo = {
  packageName: "com.example.userapp",
  type: "user",
  foreground: false,
  recent: false,
};

const systemApp: AppsQueryAppInfo = {
  packageName: "com.android.systemui",
  type: "system",
  foreground: false,
  recent: false,
};

const apps: AppsQueryAppInfo[] = [userApp, systemApp];

describe("filterAppsByQuery type default (#6155)", () => {
  test("omitted type defaults to user, not all apps", () => {
    const result = filterAppsByQuery(apps, {});
    expect(result).toEqual([userApp]);
  });

  test("type=system returns only system apps", () => {
    const result = filterAppsByQuery(apps, { type: "system" });
    expect(result).toEqual([systemApp]);
  });

  test("type=user returns only user apps", () => {
    const result = filterAppsByQuery(apps, { type: "user" });
    expect(result).toEqual([userApp]);
  });

  test("type=all returns every app, bypassing the default filter", () => {
    const result = filterAppsByQuery(apps, { type: "all" });
    expect(result).toEqual(apps);
  });
});

describe("parseAppsQueryParams type default (#6155)", () => {
  test("omitted type parses to the documented default of user", () => {
    const options = parseAppsQueryParams({ deviceId: "emulator-5554" });
    expect(options.type).toBe("user");
  });

  test("explicit type=all is accepted and preserved", () => {
    const options = parseAppsQueryParams({ deviceId: "emulator-5554", type: "all" });
    expect(options.type).toBe("all");
  });

  test("explicit type=system is accepted and preserved", () => {
    const options = parseAppsQueryParams({ deviceId: "emulator-5554", type: "system" });
    expect(options.type).toBe("system");
  });

  test("an invalid type still throws", () => {
    expect(() => parseAppsQueryParams({ deviceId: "emulator-5554", type: "bogus" })).toThrow(
      "Invalid type: bogus",
    );
  });
});

describe("extractIosApplicationType iOS user/system classification (#6155)", () => {
  test("simctl's explicit ApplicationType: System is classified as system", () => {
    expect(extractIosApplicationType({ ApplicationType: "System" }, "com.apple.mobilesafari")).toBe(
      "system",
    );
  });

  test("simctl's ApplicationType: Hidden is classified as system", () => {
    expect(extractIosApplicationType({ ApplicationType: "Hidden" }, "com.apple.springboard")).toBe(
      "system",
    );
  });

  test("simctl's ApplicationType: User is classified as user even under com.apple.", () => {
    // A user-installed app can legitimately carry a com.apple. bundle id in
    // fixtures/tests; an explicit ApplicationType always wins over the
    // bundle-id fallback heuristic.
    expect(extractIosApplicationType({ ApplicationType: "User" }, "com.apple.example")).toBe(
      "user",
    );
  });

  test("no ApplicationType field falls back to the com.apple. bundle-id namespace (devicectl)", () => {
    expect(extractIosApplicationType({}, "com.apple.mobilesafari")).toBe("system");
    expect(extractIosApplicationType({}, "com.example.myapp")).toBe("user");
  });
});

describe("iOS apps are classified before the type=user default is applied (#6155)", () => {
  const iosUserApp: AppsQueryAppInfo = {
    packageName: "com.example.myapp",
    type: "user",
    foreground: false,
    recent: false,
  };
  const iosSystemApp: AppsQueryAppInfo = {
    packageName: "com.apple.mobilesafari",
    type: "system",
    foreground: false,
    recent: false,
  };
  const iosApps = [iosUserApp, iosSystemApp];

  test("default (omitted type) excludes iOS system apps, matching Android", () => {
    expect(filterAppsByQuery(iosApps, {})).toEqual([iosUserApp]);
  });

  test("type=system returns only iOS system apps", () => {
    expect(filterAppsByQuery(iosApps, { type: "system" })).toEqual([iosSystemApp]);
  });

  test("type=all returns every iOS app", () => {
    expect(filterAppsByQuery(iosApps, { type: "all" })).toEqual(iosApps);
  });
});
