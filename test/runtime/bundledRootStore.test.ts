import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

// #14979: the daemon trusts Bun's bundled roots for outbound HTTPS (fetch, WHIP, node:https
// downloads), and neither the `tls.ca` option nor SSL_CERT_FILE can remove a bundled root, so the
// runtime's own store is the only place a distrusted root can be dropped. Bun 1.4.4 ships NSS
// 3.131.1, which removed these eMudhra emSign roots; emSign Root CA - G1 is still NSS-trusted.
const DISTRUSTED_ROOT_COMMON_NAMES = [
  "emSign ECC Root CA - G3",
  "emSign Root CA - C1",
  "emSign ECC Root CA - C3",
];

function commonNames(): string[] {
  return rootCertificates.flatMap((pem) =>
    new X509Certificate(pem).subject
      .split("\n")
      .filter((field) => field.startsWith("CN="))
      .map((field) => field.slice("CN=".length)),
  );
}

describe("bundled TLS root store", () => {
  test("does not trust the distrusted emSign roots", () => {
    const names = commonNames();
    for (const distrusted of DISTRUSTED_ROOT_COMMON_NAMES) {
      expect(names).not.toContain(distrusted);
    }
  });

  test("is a parsed, non-empty store, so the absence check is meaningful", () => {
    expect(commonNames()).toContain("emSign Root CA - G1");
  });
});
