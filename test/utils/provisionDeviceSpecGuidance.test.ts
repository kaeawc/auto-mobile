import { describe, expect, test } from "bun:test";
import { provisionDeviceRegistrationSchema } from "../../src/features/deviceLifecycle/core/schemas";
import { APPLE_PROVISION_SPEC_GUIDANCE } from "../../src/utils/provisionDeviceSpecSchemas";
import { formatToolParamError } from "../../src/utils/toolParamError";

// A provisionDevice refusal of a missing or short Apple spec names the fields to pass, an example
// and where the host's identifiers are listed (#17090).

function refusal(input: Record<string, unknown>): string {
  const result = provisionDeviceRegistrationSchema.safeParse(input);
  if (result.success) {
    throw new Error("expected a refusal");
  }
  return formatToolParamError(
    "provisionDevice",
    result.error,
    input,
    provisionDeviceRegistrationSchema,
  );
}

const APPLE_PLATFORMS = [
  { platform: "ios", options: {} },
  { platform: "watchos", options: { readiness: "none" } },
  { platform: "tvos", options: { readiness: "none" } },
  { platform: "visionos", options: { readiness: "none" } },
] as const;

describe("provisionDevice Apple spec guidance", () => {
  for (const { platform, options } of APPLE_PLATFORMS) {
    const guidance = APPLE_PROVISION_SPEC_GUIDANCE[platform];

    test(`${platform}: a missing spec names runtime, deviceType, an example and the catalog`, () => {
      const message = refusal({ device: { platform, name: "Sim" }, ...options });

      expect(message).toContain(
        `device.spec is required for ${platform}: pass spec { runtime, deviceType }`,
      );
      expect(message).toContain(JSON.stringify(guidance.example));
      expect(message).toContain(guidance.catalog);
      expect(message).not.toContain("received undefined");
    });

    test(`${platform}: a missing spec field names an example identifier`, () => {
      const message = refusal({
        device: { platform, name: "Sim", spec: { runtime: guidance.example.runtime } },
        ...options,
      });

      expect(message).toContain(
        `device.spec.deviceType is required: a CoreSimulator device-type identifier such as '${guidance.example.deviceType}'`,
      );
      expect(message).toContain(guidance.catalog);
    });
  }

  test("ios: a short deviceType names its full CoreSimulator form", () => {
    const message = refusal({
      device: {
        platform: "ios",
        name: "Sim",
        spec: {
          runtime: APPLE_PROVISION_SPEC_GUIDANCE.ios.example.runtime,
          deviceType: "iPhone-17",
        },
      },
    });

    expect(message).toContain("com.apple.CoreSimulator.SimDeviceType.iPhone-17, not 'iPhone-17'");
    expect(message).toContain(APPLE_PROVISION_SPEC_GUIDANCE.ios.catalog);
  });
});
