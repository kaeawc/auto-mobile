import { describe, expect, test } from "bun:test";
import {
  checkUrl,
  classifyAddress,
  forbiddenHeaderOf,
  StrictEgressPolicy,
} from "../../../src/features/prototype/prototypeEgressPolicy";

const policy = new StrictEgressPolicy(new Set([3000, 4567, 8765]));

describe("prototype egress policy", () => {
  // Boundary representatives for the specified IANA special-purpose ranges and owner policy.
  test.each(
    [
      {
        kind: "blocked",
        addresses: [
          "0.0.0.0",
          "0.255.255.255",
          "127.0.0.0",
          "127.255.255.255",
          "169.254.0.0",
          "169.254.255.255",
          "10.0.2.1",
          "10.0.2.6",
          "10.0.3.2",
          "224.0.0.0",
          "239.255.255.255",
          "240.0.0.0",
          "255.255.255.255",
          "::",
          "::1",
          "2001::",
          "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
          "2001:0:4136:e378:8000:63bf:3fff:fdd2",
          "fe80::",
          "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "fec0::",
          "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "ff00::",
          "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "::ffff:7f00:1",
          "::7f00:1",
          "::ffff:0:7f00:1",
          "64:ff9b::7f00:1",
          "2002:7f00:1::",
          "64:ff9b:1:7f00:0:100:808:808",
          "64:ff9b:1:7f01:3402:304:808:808", // Only /48 is blocked: 127.1.2.3.
          "64:ff9b:1:ab7f:1201:203:808:808", // Only /56 is blocked: 127.1.2.3; u != 0.
          "64:ff9b:1:abcd:127f:102:308:808", // Only /64 is blocked: 127.1.2.3; u != 0.
          "64:ff9b:1:abcd:1234:5678:7f00:1", // Only /96 is blocked.
          // /48 is private (198.18.0.1), but /64 is blocked (0.1.0.8): severity wins.
          "64:ff9b:1:c612:0:100:808:808",
          // All former zero-filled local-use prefix rows are blocked by their /48 reading.
          "64:ff9b:1::a01:203",
          "64:ff9b:1::ac10:1",
          "64:ff9b:1::6440:1",
          "64:ff9b:1::a00:20f",
          "64:ff9b:1::0:0",
          "64:ff9b:1::1:203",
          "64:ff9b:1::7f00:1",
          "64:ff9b:1::a9fe:a9fe",
          "64:ff9b:1::a00:201",
          "64:ff9b:1::a00:202",
          "64:ff9b:1::a00:203",
          "64:ff9b:1::a00:204",
          "64:ff9b:1::a00:205",
          "64:ff9b:1::a00:206",
          "64:ff9b:1::a00:302",
          "64:ff9b:1::808:808",
          "64:ff9b:1::c0a8:10a",
        ],
      },
      {
        kind: "private",
        addresses: [
          "10.0.0.0",
          "10.255.255.255",
          "10.0.2.0",
          "10.0.2.7",
          "10.0.3.1",
          "10.0.3.3",
          "172.16.0.0",
          "172.31.255.255",
          "192.168.0.0",
          "192.168.255.255",
          "100.64.0.0",
          "100.127.255.255",
          "192.0.0.0",
          "192.0.0.255",
          "192.0.0.7",
          "192.0.0.170",
          "192.0.0.171",
          "192.0.2.0",
          "192.0.2.255",
          "198.51.100.0",
          "198.51.100.255",
          "203.0.113.0",
          "203.0.113.255",
          "198.18.0.0",
          "198.18.0.1",
          "198.19.255.255",
          "100::",
          "100::ffff:ffff:ffff:ffff",
          "2001:2::",
          "2001:2:0:ffff:ffff:ffff:ffff:ffff",
          "2001:db8::",
          "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
          "3fff::",
          "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
          "5f00::",
          "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "fc00::",
          "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "::ffff:c612:1",
          "::c612:1",
          "::ffff:0:c612:1",
          "64:ff9b::c612:1",
          "2002:c612:1::",
          "64:ff9b:1:c612:34:101:808:808", // /48 is private, other layouts are public.
        ],
      },
      {
        kind: "public",
        addresses: [
          "1.0.0.0",
          "126.255.255.255",
          "128.0.0.0",
          "169.253.255.255",
          "169.255.0.0",
          "9.255.255.255",
          "11.0.0.0",
          "172.15.255.255",
          "172.32.0.0",
          "172.32.0.1",
          "192.167.255.255",
          "192.169.0.0",
          "100.63.255.255",
          "100.128.0.0",
          "100.128.0.1",
          "191.255.255.255",
          "192.0.1.0",
          "192.0.1.255",
          "192.0.3.0",
          "198.51.99.255",
          "198.51.101.0",
          "203.0.112.255",
          "203.0.114.0",
          "198.17.255.255",
          "198.20.0.0",
          "223.255.255.255",
          "192.31.196.0",
          "192.31.196.255",
          "192.52.193.0",
          "192.52.193.255",
          "192.88.99.0",
          "192.88.99.255",
          "192.175.48.0",
          "192.175.48.255",
          "ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "100:0:0:1::",
          "2001:1:ffff:ffff:ffff:ffff:ffff:ffff",
          "2001:2:1::",
          "2001:1::1",
          "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
          "2001:db9::",
          "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "3fff:1000::",
          "5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "5f01::",
          "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "fe00::",
          "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          "fe7f::",
          "fe7f:ffff::1",
          "2606:4700::1",
          "::ffff:808:808",
          "::808:808",
          "::ffff:0:808:808",
          "64:ff9b::808:808",
          "2002:808:808::",
          "64:ff9b:1:abcd:1234:5678:808:808",
          "64:ff9b:0:ffff:ffff:ffff:808:808",
          "64:ff9b:2::",
        ],
      },
    ].flatMap(({ kind, addresses }) =>
      addresses.map((address) => ({
        address,
        kind,
        ordinary: kind !== "blocked",
        daemon: kind === "public",
      })),
    ),
  )("classifies special-purpose $address as $kind", ({ address, kind, ordinary, daemon }) => {
    expect<string>(classifyAddress(address)).toBe(kind);
    expect(policy.permitsAddress(address, 8080)).toBe(ordinary);
    expect(policy.permitsAddress(address, 3000)).toBe(daemon);
  });

  test.each(
    ["::", "::ffff:", "::ffff:0:", "64:ff9b::", "64:ff9b:1:abcd:1234:5678:"].flatMap((prefix) =>
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
    // Unknown translator length: /48 decodes 0.0.0.0, even with a public/private suffix.
    "[64:ff9b:1::808:808]",
    "[64:ff9b:1::c0a8:10a]",
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
