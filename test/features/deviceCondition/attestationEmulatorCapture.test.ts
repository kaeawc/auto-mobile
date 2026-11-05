import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decodeAttestationCertificate,
  parseKeyAttestationCertificate,
} from "../../../src/features/deviceCondition/keyAttestation";

test("reads attestation fields from the captured API 35 emulator chain", () => {
  const fixture: { chainBase64Der: string[] } = JSON.parse(
    readFileSync(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "fixtures",
        "attestation",
        "emulator-api35-attestation-chain.json",
      ),
      "utf8",
    ),
  );
  const chain = fixture.chainBase64Der.map(decodeAttestationCertificate);
  expect(chain).toHaveLength(3);
  const fields = parseKeyAttestationCertificate(chain[0]);
  expect(fields.attestationSecurityLevel).toBe(0);
  expect(fields.keymasterSecurityLevel).toBe(0);
  expect(fields.deviceLocked).toBe(false);
  expect(fields.verifiedBootState).toBe(2);
  expect(fields.attestationApplicationId?.packageInfos[0]?.packageName).toBe(
    "dev.jasonpearson.automobile.ctrlproxy",
  );
});
