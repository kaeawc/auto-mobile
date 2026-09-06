import { describe, expect, test } from "bun:test";
import {
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
