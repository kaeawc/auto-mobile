import { describe, expect, test } from "bun:test";
import {
  extractIosApplicationType,
  filterAppsByQuery,
  parseAppsQueryParams,
  toQueryIosApp,
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
  test("simctl's explicit ApplicationType: System is classified as system (simulator)", () => {
    expect(
      extractIosApplicationType({ ApplicationType: "System" }, "com.apple.mobilesafari", false),
    ).toBe("system");
  });

  test("simctl's ApplicationType: Hidden is classified as system (simulator)", () => {
    expect(
      extractIosApplicationType({ ApplicationType: "Hidden" }, "com.apple.springboard", false),
    ).toBe("system");
  });

  test("simctl's ApplicationType: User is classified as user even under com.apple. (simulator)", () => {
    // A user-installed app can legitimately carry a com.apple. bundle id in
    // fixtures/tests; an explicit ApplicationType always wins over the
    // bundle-id fallback heuristic.
    expect(extractIosApplicationType({ ApplicationType: "User" }, "com.apple.example", false)).toBe(
      "user",
    );
  });

  test("an explicit ApplicationType also wins on a physical device", () => {
    expect(
      extractIosApplicationType({ ApplicationType: "System" }, "com.apple.mobilesafari", true),
    ).toBe("system");
    expect(extractIosApplicationType({ ApplicationType: "User" }, "com.apple.example", true)).toBe(
      "user",
    );
  });

  test("no ApplicationType field falls back to the com.apple. bundle-id namespace on the simulator", () => {
    expect(extractIosApplicationType({}, "com.apple.mobilesafari", false)).toBe("system");
    expect(extractIosApplicationType({}, "com.example.myapp", false)).toBe("user");
  });

  test("no ApplicationType field defaults to user on a PHYSICAL device (#6216 review)", () => {
    // devicectl's `device info apps --json-output` exposes no user/system signal
    // at all (bundleIdentifier/name/version/bundleVersion/url/appClip only), so
    // guessing "system" from the com.apple. bundle-id prefix would misclassify a
    // user's own Apple-published apps (Pages, Numbers, TestFlight, ...) and hide
    // them from the default type=user query.
    expect(extractIosApplicationType({}, "com.apple.Pages", true)).toBe("user");
    expect(extractIosApplicationType({}, "com.apple.mobilesafari", true)).toBe("user");
    expect(extractIosApplicationType({}, "com.example.myapp", true)).toBe("user");
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

describe("toQueryIosApp always populates userIds (#6216 review)", () => {
  test("a system app carries userIds: [0] so a profile filter does not drop it", () => {
    const queryApp = toQueryIosApp({ bundleId: "com.apple.mobilesafari", type: "system" });
    expect(queryApp.userIds).toEqual([0]);
  });

  test("a user app also carries userIds: [0] (iOS has a single profile)", () => {
    const queryApp = toQueryIosApp({ bundleId: "com.example.myapp", type: "user" });
    expect(queryApp.userIds).toEqual([0]);
  });
});

describe("profile filtering preserves iOS system apps (#6216 review)", () => {
  // Matches the shape toQueryIosApp actually emits: iOS has a single (profile 0)
  // user, so every app — user or system — carries userIds: [0].
  const iosUserApp: AppsQueryAppInfo = {
    packageName: "com.example.myapp",
    type: "user",
    userId: 0,
    userIds: [0],
    foreground: false,
    recent: false,
  };
  const iosSystemApp: AppsQueryAppInfo = {
    packageName: "com.apple.mobilesafari",
    type: "system",
    userId: 0,
    userIds: [0],
    foreground: false,
    recent: false,
  };
  const iosApps = [iosUserApp, iosSystemApp];

  test("profile:0 does not drop iOS system apps under type=system", () => {
    expect(filterAppsByQuery(iosApps, { type: "system", profile: 0 })).toEqual([iosSystemApp]);
  });

  test("profile:0 does not drop iOS system apps under type=all", () => {
    expect(filterAppsByQuery(iosApps, { type: "all", profile: 0 })).toEqual(iosApps);
  });

  test("a non-matching profile still excludes iOS apps (the filter itself still works)", () => {
    expect(filterAppsByQuery(iosApps, { type: "all", profile: 1 })).toEqual([]);
  });
});
