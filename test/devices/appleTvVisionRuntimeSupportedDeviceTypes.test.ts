import { describe, expect, test } from "bun:test";
import tvFixture from "../fixtures/ios-simctl/list-all-appletv-26-5.json";
import visionFixture from "../fixtures/ios-simctl/list-all-visionos-26-5.json";
import { ActionableError } from "../../src/models/ActionableError";
import { assertAppleTvSpecInCatalog } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import { assertAppleVisionSpecInCatalog } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";

// #18287: the tvOS and visionOS spec checks honour a runtime's `supportedDeviceTypes`, not only
// the device type's bounds. Fixtures are the verbatim `simctl list -j` captures from
// test/fixtures/ios-simctl; every variant that edits a runtime is built here and labelled derived.
interface Catalog {
  runtimes: AppleDeviceRuntime[];
  deviceTypes: AppleDeviceType[];
}

const TV_RUNTIME = "com.apple.CoreSimulator.SimRuntime.tvOS-26-5";
const TV_4K_3RD_GEN = "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K";
const XROS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.xrOS-26-5";
const VISION_PRO_4K = "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro-4K";
const VISION_PRO = "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro";

function captured(fixture: { runtimes: AppleDeviceRuntime[]; devicetypes: AppleDeviceType[] }) {
  return (): Catalog => ({
    runtimes: structuredClone(fixture.runtimes),
    deviceTypes: structuredClone(fixture.devicetypes),
  });
}
const tvCatalog = captured(tvFixture);
const visionCatalog = captured(visionFixture);

/** Derived, not captured: `runtimeId` with `deviceTypeId` dropped from its supportedDeviceTypes. */
function withoutListedType(catalog: Catalog, runtimeId: string, deviceTypeId: string): Catalog {
  return {
    ...catalog,
    runtimes: catalog.runtimes.map((runtime) =>
      runtime.identifier === runtimeId
        ? {
            ...runtime,
            supportedDeviceTypes: runtime.supportedDeviceTypes?.filter(
              (entry) => entry.identifier !== deviceTypeId,
            ),
          }
        : runtime,
    ),
  };
}

/** Derived, not captured: every runtime without supportedDeviceTypes, as older simctl output. */
function withoutLists(catalog: Catalog): Catalog {
  return {
    ...catalog,
    runtimes: catalog.runtimes.map(({ supportedDeviceTypes: _omitted, ...rest }) => rest),
  };
}

function refusal(check: () => void): unknown {
  try {
    check();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("assertAppleTvSpecInCatalog with runtime supportedDeviceTypes (#18287)", () => {
  const spec = { deviceType: TV_4K_3RD_GEN, runtime: TV_RUNTIME };

  test("captured: a type the tvOS runtime lists passes", () => {
    expect(refusal(() => assertAppleTvSpecInCatalog(spec, tvCatalog()))).toBeUndefined();
  });

  test("derived: a type inside the bounds that the runtime does not list is refused", () => {
    const error = refusal(() =>
      assertAppleTvSpecInCatalog(spec, withoutListedType(tvCatalog(), TV_RUNTIME, TV_4K_3RD_GEN)),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`is incompatible with tvOS runtime '${TV_RUNTIME}' (26.5)`);
  });

  test("derived: without the runtime list, the bounds decide", () => {
    expect(
      refusal(() => assertAppleTvSpecInCatalog(spec, withoutLists(tvCatalog()))),
    ).toBeUndefined();
  });
});

describe("assertAppleVisionSpecInCatalog with runtime supportedDeviceTypes (#18287)", () => {
  const spec = { deviceType: VISION_PRO_4K, runtime: XROS_RUNTIME };

  test("captured: the type the visionOS runtime lists passes", () => {
    expect(refusal(() => assertAppleVisionSpecInCatalog(spec, visionCatalog()))).toBeUndefined();
  });

  test("captured: a type outside its bounds and not listed is refused", () => {
    const error = refusal(() =>
      assertAppleVisionSpecInCatalog(
        { deviceType: VISION_PRO, runtime: XROS_RUNTIME },
        visionCatalog(),
      ),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("is incompatible with visionOS runtime");
  });

  test("derived: a type inside the bounds that the runtime does not list is refused", () => {
    const error = refusal(() =>
      assertAppleVisionSpecInCatalog(
        spec,
        withoutListedType(visionCatalog(), XROS_RUNTIME, VISION_PRO_4K),
      ),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(
      `is incompatible with visionOS runtime '${XROS_RUNTIME}' (26.5)`,
    );
  });

  test("derived: without the runtime list, the bounds decide", () => {
    expect(
      refusal(() => assertAppleVisionSpecInCatalog(spec, withoutLists(visionCatalog()))),
    ).toBeUndefined();
  });
});
