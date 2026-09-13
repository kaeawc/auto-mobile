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

describe("filterAppsByQuery type default (#6155, default changed by #6798)", () => {
  test("omitted type is still a filter, not 'all' — neither of these apps reports launchability", () => {
    // The default moved from "user" to "launchable" (#6798). These fixtures
    // carry no launchable flag, so the default selects nothing; the point
    // preserved from #6155 is that an omitted type is never "no filter".
    const result = filterAppsByQuery(apps, {});
    expect(result).toEqual([]);
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

describe("filterAppsByQuery search normalization (#6216 review)", () => {
  const cameraApp: AppsQueryAppInfo = {
    packageName: "com.example.camera",
    type: "user",
    foreground: false,
    recent: false,
    label: "Camera",
  };
  const otherApp: AppsQueryAppInfo = {
    packageName: "com.example.other",
    type: "user",
    foreground: false,
    recent: false,
    label: "Other",
  };
  const searchApps = [cameraApp, otherApp];

  test("a search term with surrounding whitespace and different case still matches (' Camera ')", () => {
    expect(filterAppsByQuery(searchApps, { type: "all", search: " Camera " })).toEqual([cameraApp]);
  });

  test("an all-whitespace search term is treated as no filter", () => {
    expect(filterAppsByQuery(searchApps, { type: "all", search: "   " })).toEqual(searchApps);
  });

  test("a non-matching search term still excludes apps", () => {
    expect(filterAppsByQuery(searchApps, { type: "all", search: " zzz " })).toEqual([]);
  });

  test("case/whitespace-insensitive matching also works against the package name", () => {
    expect(filterAppsByQuery(searchApps, { type: "all", search: " CAMERA " })).toEqual([cameraApp]);
  });
});

describe("parseAppsQueryParams type default (#6155)", () => {
  test("omitted type is left undefined (filterAppsByQuery applies the 'user' default, not this parser)", () => {
    // Left undefined so queryInstalledApps can tell "no filter requested" apart
    // from an explicit type=user, which matters for the physical-iOS
    // unreliable-classification rejection (#6216 review, round 5).
    const options = parseAppsQueryParams({ deviceId: "emulator-5554" });
    expect(options.type).toBeUndefined();
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

  test("an explicit type=user excludes iOS system apps, matching Android", () => {
    // The omitted-type default is "launchable" since #6798; type=user remains
    // the explicit way to ask the #6155 question.
    expect(filterAppsByQuery(iosApps, { type: "user" })).toEqual([iosUserApp]);
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

describe("toQueryIosApp preserves the legacy displayName alias (#6798)", () => {
  test("emits both displayName and label from the iOS display name", () => {
    const queryApp = toQueryIosApp({
      bundleId: "com.example.myapp",
      type: "user",
      displayName: "Example App",
    });

    expect(queryApp.displayName).toBe("Example App");
    expect(queryApp.label).toBe("Example App");
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

describe("filterAppsByQuery launchable default (#6798)", () => {
  const contacts: AppsQueryAppInfo = {
    packageName: "com.android.contacts",
    type: "system",
    foreground: false,
    recent: false,
    label: "Contacts",
    launchable: true,
  };
  const contactsProvider: AppsQueryAppInfo = {
    packageName: "com.android.providers.contacts",
    type: "system",
    foreground: false,
    recent: false,
    label: "Contacts Storage",
    launchable: false,
  };
  const myApp: AppsQueryAppInfo = {
    packageName: "com.example.myapp",
    type: "user",
    foreground: false,
    recent: false,
    label: "My App",
    launchable: true,
  };
  const launchableApps = [contacts, contactsProvider, myApp];

  test("an omitted type defaults to launchable, so Contacts is no longer hidden", () => {
    expect(filterAppsByQuery(launchableApps, {})).toEqual([contacts, myApp]);
  });

  test("the launchable default still drops providers and overlays that cannot be launched", () => {
    expect(filterAppsByQuery(launchableApps, {})).not.toContain(contactsProvider);
  });

  test("the user/system distinction is preserved and still filterable explicitly", () => {
    expect(filterAppsByQuery(launchableApps, { type: "user" })).toEqual([myApp]);
    expect(filterAppsByQuery(launchableApps, { type: "system" })).toEqual([
      contacts,
      contactsProvider,
    ]);
    expect(filterAppsByQuery(launchableApps, { type: "all" })).toEqual(launchableApps);
  });

  test("an app whose launchability was never reported is excluded by the launchable filter", () => {
    const unknown: AppsQueryAppInfo = {
      packageName: "com.example.unknown",
      type: "user",
      foreground: false,
      recent: false,
    };
    expect(filterAppsByQuery([unknown], { type: "launchable" })).toEqual([]);
  });

  test("search matches the display label, so 'contacts' finds the app and not just the id", () => {
    expect(filterAppsByQuery(launchableApps, { type: "all", search: "Contacts" })).toEqual([
      contacts,
      contactsProvider,
    ]);
    expect(filterAppsByQuery(launchableApps, { type: "all", search: "my app" })).toEqual([myApp]);
  });
});

describe("filterAppsByQuery per-profile launchability (#6798 review)", () => {
  // A launcher activity can be disabled for the owner and enabled in a work
  // profile, so a deduplicated system app carries launchability per user id.
  const contacts: AppsQueryAppInfo = {
    packageName: "com.android.contacts",
    type: "system",
    userIds: [0, 10],
    foreground: false,
    recent: false,
    label: "Contacts",
    launchable: true,
    launchableByUserId: { 0: false, 10: true },
  };

  test("type=launchable with a profile consults that profile's launchability", () => {
    expect(filterAppsByQuery([contacts], { type: "launchable", profile: 10 })).toEqual([contacts]);
    expect(filterAppsByQuery([contacts], { type: "launchable", profile: 0 })).toEqual([]);
  });

  test("without a profile the scalar 'launches for at least one user' still applies", () => {
    expect(filterAppsByQuery([contacts], { type: "launchable" })).toEqual([contacts]);
  });

  test("a profile with no reported launchability is not treated as launchable", () => {
    expect(filterAppsByQuery([contacts], { type: "launchable", profile: 11 })).toEqual([]);
  });
});
