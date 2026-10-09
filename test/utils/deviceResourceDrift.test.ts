import { describe, expect, test } from "bun:test";
import {
  computeDeviceResourceDrift,
  deviceResourceProfileFingerprint,
  nextOwnedOverrides,
} from "../../src/utils/deviceResourceDrift";

describe("workload profile fingerprint", () => {
  test("ignores key order and omitted entries", () => {
    expect(
      deviceResourceProfileFingerprint({
        resources: { widgets: "disabled", wallpaperRendering: "disabled" },
      }),
    ).toBe(
      deviceResourceProfileFingerprint({
        resources: { wallpaperRendering: "disabled", widgets: "disabled", tipsServices: undefined },
      }),
    );
  });

  test("distinguishes requested states", () => {
    expect(deviceResourceProfileFingerprint({ resources: { widgets: "disabled" } })).not.toBe(
      deviceResourceProfileFingerprint({ resources: { widgets: "enabled" } }),
    );
  });
});

describe("requested-versus-observed drift", () => {
  test("classifies each observed state without guessing", () => {
    expect(
      computeDeviceResourceDrift(
        {
          wallpaperRendering: "disabled",
          widgets: "disabled",
          tipsServices: "disabled",
          newsServices: "disabled",
          healthServices: "disabled",
        },
        {
          wallpaperRendering: { state: "disabled" },
          widgets: { state: "enabled" },
          tipsServices: { state: "unsupported", reason: "absent" },
          newsServices: { state: "unknown", reason: "read failed" },
        },
      ),
    ).toEqual([
      {
        resource: "widgets",
        kind: "missingRequested",
        expected: "disabled",
        observed: { state: "enabled" },
      },
      {
        resource: "tipsServices",
        kind: "unsupported",
        expected: "disabled",
        observed: { state: "unsupported", reason: "absent" },
      },
      {
        resource: "newsServices",
        kind: "commandFailure",
        expected: "disabled",
        observed: { state: "unknown", reason: "read failed" },
      },
      {
        resource: "healthServices",
        kind: "commandFailure",
        expected: "disabled",
        observed: { state: "unknown", reason: "The observation did not report this resource." },
      },
    ]);
  });

  test("owned extras are only recorded overrides outside the profile still in effect", () => {
    expect(
      computeDeviceResourceDrift(
        { wallpaperRendering: "disabled" },
        {
          wallpaperRendering: { state: "disabled" },
          widgets: { state: "disabled" },
          tipsServices: { state: "enabled" },
          newsServices: { state: "disabled" },
        },
        { wallpaperRendering: "disabled", widgets: "disabled", tipsServices: "disabled" },
      ),
    ).toEqual([
      {
        resource: "widgets",
        kind: "ownedExtra",
        expected: "disabled",
        observed: { state: "disabled" },
      },
    ]);
  });
});

describe("owned override bookkeeping", () => {
  test("adds changed disabled entries, drops re-enabled ones, keeps unproven ones", () => {
    expect(
      nextOwnedOverrides(
        { widgets: "disabled", tipsServices: "disabled", newsServices: "disabled" },
        { wallpaperRendering: "disabled", widgets: "enabled", gameServices: "disabled" },
        ["wallpaperRendering", "widgets"],
        {
          wallpaperRendering: { state: "disabled" },
          widgets: { state: "enabled" },
          tipsServices: { state: "unknown" },
          newsServices: { state: "enabled" },
          gameServices: { state: "disabled" },
        },
      ),
    ).toEqual({ wallpaperRendering: "disabled", tipsServices: "disabled" });
  });
});
