import { expect, test } from "bun:test";
import { handleDeviceConditionCall } from "../../src/server/deviceConditionTool";
import type { AttestationChainSource } from "../../src/features/deviceCondition/keyAttestation";
import { certificate } from "../helpers/attestation/derFixture";
import { toolStructured, toolText } from "../helpers/toolResponse";

class FakeAttestationSource implements AttestationChainSource {
  calls = 0;
  chain = [certificate().toString("base64"), certificate().toString("base64")];
  async exportAttestation() {
    this.calls++;
    return this.chain;
  }
}
const device = { deviceId: "test-emulator", name: "test", platform: "android" as const };
const args = { deviceCondition: { exportAttestation: true } };
const featureFlags = { isEnabled: () => true };
test("exports public chain, root and parsed fields without a session", async () => {
  const source = new FakeAttestationSource();
  const result = await handleDeviceConditionCall(device, args, {
    featureFlags,
    attestationSource: () => source,
  });
  expect(source.calls).toBe(1);
  expect(toolStructured(result)).toMatchObject({
    success: true,
    attestation: {
      certificateChainBase64: source.chain,
      rootCertificateBase64: source.chain[1],
      fields: { deviceLocked: false },
    },
  });
});
test("refuses mixing export with mutation, lease, disabled flag or iOS", async () => {
  const source = new FakeAttestationSource();
  for (const extra of [{ reset: true }, { rootState: "unset" }, { expiresInSeconds: 1 }]) {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { exportAttestation: true, ...extra } },
      { featureFlags, attestationSource: () => source },
    );
    expect(toolStructured(response).success).toBe(false);
  }
  expect(
    toolStructured(
      await handleDeviceConditionCall(device, args, {
        featureFlags: { isEnabled: () => false },
        attestationSource: () => source,
      }),
    ).success,
  ).toBe(false);
  expect(
    toolStructured(
      await handleDeviceConditionCall({ ...device, platform: "ios" }, args, {
        featureFlags,
        attestationSource: () => source,
      }),
    ).success,
  ).toBe(false);
  expect(source.calls).toBe(0);
});
test("surfaces incomplete chains and malformed certificates as structured errors", async () => {
  const source = new FakeAttestationSource();
  source.chain = [];
  await expect(
    handleDeviceConditionCall(device, args, { featureFlags, attestationSource: () => source }),
  ).rejects.toThrow();
  source.chain = ["not base64", "not base64"];
  await expect(
    handleDeviceConditionCall(device, args, { featureFlags, attestationSource: () => source }),
  ).rejects.toThrow();
});
test("export cannot be combined with another device state operation", async () => {
  const source = new FakeAttestationSource();
  const response = await handleDeviceConditionCall(
    device,
    { ...args, clock: {} },
    { featureFlags, attestationSource: () => source },
  );
  expect(toolText(response)).toContain("cannot be combined");
  expect(source.calls).toBe(0);
});
