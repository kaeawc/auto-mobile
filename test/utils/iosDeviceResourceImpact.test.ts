import { setDeviceResourcesResultSchema } from "../../src/server/deviceResourceToolOutputSchemas";
import { fakeIosDeviceResourceHazards as hazards } from "../helpers/fakeIosDeviceResourceHazards";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import definitions from "../../schemas/tool-definitions.json";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import {
  iosDeviceResourceImpact,
  coreDrivingImpact,
  getIosDeviceResourceImpact,
  describeDisabledDeviceResources,
} from "../../src/utils/iosDeviceResourceImpact";

const keys = Object.keys(iosDeviceResourceCatalog) as (keyof typeof iosDeviceResourceCatalog)[];

test("every disjoint catalog group has one shared verified driving claim and inferred feature impacts", () => {
  expect(Object.keys(iosDeviceResourceImpact)).toEqual(keys);
  expect(coreDrivingImpact.confidence).toBe("verified");
  expect(coreDrivingImpact.evidence?.startsWith("#15097")).toBe(true);
  const labels = Object.values(iosDeviceResourceCatalog).flat();
  expect(new Set(labels).size).toBe(labels.length);
  for (const key of keys) {
    const impact = getIosDeviceResourceImpact(key)!;
    expect(impact.automobileImpact[0]).toBe(coreDrivingImpact);
    expect(impact.appImpact.length).toBeGreaterThan(0);
    for (const item of [...impact.automobileImpact.slice(1), ...impact.appImpact].filter(
      (item) => item.confidence !== "verified",
    )) {
      expect(item.confidence).toBe("inferred");
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.evidence).toBeUndefined();
    }
  }
});

test("tool references name registered tools", () => {
  const names = new Set(definitions.map((tool) => tool.name));
  const allowed = ["observe", "launchApp", "terminateApp", "tapOn", "sendKeys", "putAppFile"];
  for (const tool of allowed) {
    expect(names.has(tool)).toBe(true);
  }
  for (const impact of Object.values(iosDeviceResourceImpact)) {
    for (const item of [...impact.automobileImpact, ...impact.appImpact]) {
      for (const reference of item.description.matchAll(/`([^`]+)`/g)) {
        expect(allowed).toContain(reference[1]!);
      }
    }
  }
});

test("new service groups have exact labels and non-iOS resources have no impact", () => {
  expect(iosDeviceResourceCatalog.siriAndAppIntents).toEqual([
    "com.apple.assistantd",
    "com.apple.assistant_service",
    "com.apple.assistant_cdmd",
    "com.apple.siriactionsd",
    "com.apple.linkd",
  ]);
  expect(iosDeviceResourceCatalog.speechServices).toEqual([
    "com.apple.corespeechd",
    "com.apple.speechmaintenanced",
    "com.apple.sirittsd",
  ]);
  expect(iosDeviceResourceCatalog.mediaTranscoding).toEqual([
    "com.apple.photos.ImageConversionService",
    "com.apple.photos.VideoConversionService",
  ]);
  expect(getIosDeviceResourceImpact("mailApp")).toBeUndefined();
});

test("disabled reports follow catalog order and exclude unreadable, enabled and non-iOS states", () => {
  const report = describeDisabledDeviceResources({
    mediaTranscoding: { state: "disabled" },
    widgets: { state: "unknown" },
    wallpaperRendering: { state: "disabled" },
    healthServices: { state: "unsupported" },
    liveActivities: { state: "enabled" },
    mailApp: { state: "disabled" },
  });
  expect(report.map((entry) => entry.resource)).toEqual(["wallpaperRendering", "mediaTranscoding"]);
  expect(report[0]).toEqual({
    resource: "wallpaperRendering",
    labels: [...iosDeviceResourceCatalog.wallpaperRendering],
    ...iosDeviceResourceImpact.wallpaperRendering,
  });
  expect(describeDisabledDeviceResources({})).toEqual([]);
});

test("documented impact table matches every resource, label and impact", () => {
  // Windows checkouts convert line endings.
  const doc = readFileSync(
    new URL("../../docs/design-docs/device-resources.md", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const section =
    doc.split("## Impact of disabling iOS Simulator services\n")[1]?.split("\n## ")[0] ?? "";
  const rows = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const data = rows.slice(2);
  expect(data.map((row) => row[0]?.replaceAll("`", ""))).toEqual(keys);
  for (const [index, key] of keys.entries()) {
    const row = data[index]!;
    expect(row[1]?.split("<br>").map((label) => label.trim().replaceAll("`", ""))).toEqual([
      ...iosDeviceResourceCatalog[key],
    ]);
    expect(row[2]).toBe(
      iosDeviceResourceImpact[key].automobileImpact.map((item) => item.description).join(" "),
    );
    expect(row[3]).toBe(
      iosDeviceResourceImpact[key].appImpact.map((item) => item.description).join(" "),
    );
    expect(row[4]).toBe(
      key === "calendarServices"
        ? "Core driving: verified (#15097); bootout CPU hazard: verified (#15218); feature impacts: inferred"
        : "Core driving: verified (#15097); feature impacts: inferred",
    );
  }
});

test("unsafeWith is derived per resource and omitted for unrelated groups", () => {
  const unsafeWith = [
    {
      hazardId: "fake-spin",
      appliesTo: ["post_boot", "preboot"] as const,
      withResources: ["reminderServices"] as const,
      reason: "Fake CPU spin",
      evidence: "Injected test evidence",
    },
  ];
  expect(getIosDeviceResourceImpact("calendarServices", hazards)?.unsafeWith).toEqual(unsafeWith);
  expect(getIosDeviceResourceImpact("widgets", hazards)).not.toHaveProperty("unsafeWith");
  expect(
    describeDisabledDeviceResources({ calendarServices: { state: "disabled" } }, hazards)[0]
      ?.unsafeWith,
  ).toEqual(unsafeWith);
  expect(
    getIosDeviceResourceImpact("reminderServices", hazards)?.unsafeWith?.[0]?.withResources,
  ).toEqual(["calendarServices"]);
});

test("optional unsafeWith survives the output schema alongside legacy reports", () => {
  const report = {
    success: true,
    device: { deviceId: "SIM", platform: "ios" },
    requested: {},
    resources: {},
    changed: [],
    verification: "current_boot",
    disabledResources: describeDisabledDeviceResources(
      { calendarServices: { state: "disabled" } },
      hazards,
    ),
  };
  expect(JSON.stringify(setDeviceResourcesResultSchema.parse(report).disabledResources)).toBe(
    JSON.stringify(report.disabledResources),
  );
  const legacy = {
    ...report,
    disabledResources: describeDisabledDeviceResources({ widgets: { state: "disabled" } }, []),
  };
  expect(setDeviceResourcesResultSchema.parse(legacy).disabledResources?.[0]).not.toHaveProperty(
    "unsafeWith",
  );
});

test("real hazards have verified measured impacts and single-resource metadata", () => {
  const impact = getIosDeviceResourceImpact("calendarServices")!;
  expect(impact.unsafeWith?.[0]).toMatchObject({ withResources: [], appliesTo: ["post_boot"] });
  expect(
    impact.automobileImpact.some(
      (item) => item.confidence === "verified" && item.evidence?.startsWith("#15218:"),
    ),
  ).toBe(true);
});
