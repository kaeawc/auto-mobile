import { describe, expect, test } from "bun:test";
import {
  checkUrl,
  classifyAddress,
  forbiddenHeaderOf,
  StrictEgressPolicy,
} from "../../../src/features/prototype/prototypeEgressPolicy";

const policy = new StrictEgressPolicy(new Set([3000, 4567, 8765]));

describe("prototype egress policy", () => {
  test.each(
    ["::", "::ffff:", "::ffff:0:", "64:ff9b::", "64:ff9b:1::", "64:ff9b:1:abcd:1234:5678:"].flatMap(
      (prefix) =>
        [
          { suffix: "808:808", kind: "public", ordinary: true, daemon: true },
          { suffix: "a01:203", kind: "private", ordinary: true, daemon: false },
          { suffix: "c0a8:10a", kind: "private", ordinary: true, daemon: false },
          { suffix: "ac10:1", kind: "private", ordinary: true, daemon: false },
          { suffix: "6440:1", kind: "private", ordinary: true, daemon: false },
          { suffix: "a00:20f", kind: "private", ordinary: true, daemon: false },
          { suffix: "0:0", kind: "blocked", ordinary: false, daemon: false },
          { suffix: "1:203", kind: "blocked", ordinary: false, daemon: false },
          { suffix: "7f00:1", kind: "blocked", ordinary: false, daemon: false },
          { suffix: "a9fe:a9fe", kind: "blocked", ordinary: false, daemon: false },
          ...[1, 2, 3, 4, 5, 6].map((last) => ({
            suffix: `a00:20${last}`,
            kind: "blocked",
            ordinary: false,
            daemon: false,
          })),
          { suffix: "a00:302", kind: "blocked", ordinary: false, daemon: false },
        ].map((entry) => ({ ...entry, address: `${prefix}${entry.suffix}` })),
    ),
  )("classifies embedded IPv4 in $address", ({ address, kind, ordinary, daemon }) => {
    expect<string>(classifyAddress(address)).toBe(kind);
    expect(policy.permitsAddress(address, 8080)).toBe(ordinary);
    expect(policy.permitsAddress(address, 3000)).toBe(daemon);
  });

  test.each([
    "127.0.0.1",
    "127.1.2.3",
    "2130706433",
    "0x7f.1",
    "0177.0.0.1",
    "127.1",
    "[::1]",
    "[::]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::ffff:a9fe:a9fe]",
    "[::127.0.0.1]",
    "[64:ff9b::7f00:1]",
    "[2002:7f00:1::]",
    "[::ffff:0:7f00:1]",
    "[64:ff9b:1::7f00:1]",
    "[64:ff9b:1:abcd:1234:5678:a9fe:a9fe]",
    "[2001::808:808]",
    "[2001:0:ffff:ffff:ffff:ffff:ffff:ffff]",
    "[fec0::1]",
    "[feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "[fe80::1]",
    "[febf::1]",
    "169.254.169.254",
    "0.0.0.0",
    "0.1.2.3",
    "10.0.2.1",
    "10.0.2.2",
    "10.0.2.3",
    "10.0.2.4",
    "10.0.2.5",
    "10.0.2.6",
    "10.0.3.2",
    "[::ffff:a00:202]",
    "[64:ff9b::a00:203]",
    "[2002:a9fe:a9fe::]",
    "localhost",
    "LOCALHOST.",
    "foo.localhost",
    "foo.localhost.",
  ])("refuses normalized destination %s", (host) => {
    expect(checkUrl(new URL(`http://${host}/`), policy)).toBeDefined();
  });

  test.each([
    "8.8.8.8",
    "10.1.2.3",
    "192.168.1.10",
    "10.0.2.7",
    "10.0.2.15",
    "[2606:4700:4700::1111]",
    "[::ffff:808:808]",
    "[::ffff:0:808:808]",
    "[64:ff9b:1::808:808]",
    "[64:ff9b:1:abcd:1234:5678:808:808]",
    "[fe7f:ffff::1]",
    "[2001:1::1]",
    "[64:ff9b::808:808]",
    "[2002:808:808::]",
    "example.test",
  ])("permits destination %s", (host) => {
    expect(checkUrl(new URL(`http://${host}/`), policy)).toBeUndefined();
  });

  test.each([
    "10.0.2.15",
    "10.1.2.3",
    "192.168.1.10",
    "::ffff:0:a01:203",
    "64:ff9b:1::c0a8:10a",
    "64:ff9b:1:abcd:1234:5678:a00:20f",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "fc00::1",
    "fdff::1",
    "::ffff:c0a8:101",
    "64:ff9b::a00:20f",
    "2002:a00:20f::",
  ])("restricts daemon ports on private address %s", (address) => {
    expect(classifyAddress(address)).toBe("private");
    expect(policy.permitsAddress(address, 3000)).toBe(false);
    expect(policy.permitsAddress(address, 4567)).toBe(false);
    expect(policy.permitsAddress(address, 8765)).toBe(false);
    expect(policy.permitsAddress(address, 8080)).toBe(true);
  });

  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1"])(
    "allows public address %s on daemon ports",
    (address) => {
      expect(classifyAddress(address)).toBe("public");
      expect(policy.permitsAddress(address, 3000)).toBe(true);
    },
  );

  test.each(["not-an-ip", "127.1", "fe80::1%en0", "224.0.0.1", "255.255.255.255", "ff02::1"])(
    "refuses invalid or non-unicast address %s",
    (address) => {
      expect(classifyAddress(address)).toBe("blocked");
    },
  );

  test.each([
    "hOsT",
    "cOnNeCtIoN",
    "uPgRaDe",
    "tRaNsFeR-EnCoDiNg",
    "cOnTeNt-LeNgTh",
    "tE",
    "tRaIlEr",
    "kEeP-AlIvE",
    "cOoKiE",
    "oRiGiN",
    "eXpEcT",
    "pRoXy-AuThOrIzAtIoN",
    "PrOxY-Custom",
  ])("rejects forbidden header %s", (name) => {
    expect(forbiddenHeaderOf({ [name]: "value" })).toBe(name);
  });

  test("allows ordinary application headers", () => {
    expect(
      forbiddenHeaderOf({ Authorization: "value", "Content-Type": "application/json" }),
    ).toBeUndefined();
  });
});
