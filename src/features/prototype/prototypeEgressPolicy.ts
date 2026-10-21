import { isIP } from "node:net";

export interface ResolvedHostAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedHostAddress[]>;
export type AddressClass = "public" | "blocked" | "private";

export interface EgressPolicy {
  permitsHostname(hostname: string): boolean;
  permitsAddress(address: string, port: number): boolean;
}

const BLOCKED_V4_RANGES = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16
  [0x0a000201, 0x0a000206], // Emulator router, host and DNS aliases
  [0x0a000302, 0x0a000302], // Genymotion host alias
  [0xe0000000, 0xffffffff], // Multicast and reserved non-unicast
] as const;
const PRIVATE_V4_RANGES = [
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0x64400000, 0x647fffff], // 100.64.0.0/10
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 documentation
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 documentation
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 documentation
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
] as const;

function classifyV4(bytes: number[]): AddressClass {
  const value = bytes.reduce((address, byte) => address * 256 + byte, 0);
  if (BLOCKED_V4_RANGES.some(([start, end]) => value >= start && value <= end)) {
    return "blocked";
  }
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= start && value <= end)
    ? "private"
    : "public";
}

/** isIP validates syntax first; WHATWG URL supplies the canonical hexadecimal IPv6 form. */
function ipv6Words(ip: string): number[] {
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const head = left ? left.split(":").map((word) => Number.parseInt(word, 16)) : [];
  if (right === undefined) {
    return head;
  }
  const tail = right ? right.split(":").map((word) => Number.parseInt(word, 16)) : [];
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

// These /96 forms carry IPv4 in the low 32 bits; 6to4 uses words 1-2.
// Local-use NAT64 64:ff9b:1::/48 may contain /48, /56, /64 or /96 translators:
// RFC 6052 layouts skip the u octet (byte 8), whose value is not constrained here.
const EMBEDDED_V4_PREFIXES = [
  [0, 0, 0, 0, 0, 0], // IPv4-compatible
  [0, 0, 0, 0, 0, 0xffff], // IPv4-mapped
  [0, 0, 0, 0, 0xffff, 0], // SIIT IPv4-translated
  [0x64, 0xff9b, 0, 0, 0, 0], // Well-known NAT64 /96
] as const;

const LOCAL_NAT64_V4_LAYOUTS = [
  [6, 7, 9, 10], // /48
  [7, 9, 10, 11], // /56
  [9, 10, 11, 12], // /64
  [12, 13, 14, 15], // /96
] as const;

function ipv6Bytes(words: number[]): number[] {
  return words.flatMap((word) => [word >>> 8, word & 255]);
}

function embeddedV4(words: number[]): AddressClass | undefined {
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) {
    const bytes = ipv6Bytes(words);
    const classes = LOCAL_NAT64_V4_LAYOUTS.map((layout) =>
      classifyV4(layout.map((index) => bytes[index]!)),
    );
    // The translator prefix length is unknown: fail closed across every legal layout.
    return classes.includes("blocked")
      ? "blocked"
      : classes.includes("private")
        ? "private"
        : "public";
  }
  const lowBits = EMBEDDED_V4_PREFIXES.some((prefix) =>
    prefix.every((word, index) => words[index] === word),
  );
  const pair = words[0] === 0x2002 ? words.slice(1, 3) : lowBits ? words.slice(6, 8) : undefined;
  return pair === undefined ? undefined : classifyV4(ipv6Bytes(pair));
}

const PRIVATE_V6_PREFIXES = [
  [0x100, 0, 0, 0], // 100::/64 discard-only
  [0x2001, 2, 0], // 2001:2::/48 benchmarking
  [0x2001, 0xdb8], // 2001:db8::/32 documentation
  [0x5f00], // 5f00::/16 SRv6 SIDs
] as const;

function isPrivateV6(words: number[]): boolean {
  return (
    (words[0]! & 0xfe00) === 0xfc00 ||
    (words[0] === 0x3fff && (words[1]! & 0xf000) === 0) || // 3fff::/20 documentation
    PRIVATE_V6_PREFIXES.some((prefix) => prefix.every((word, index) => words[index] === word))
  );
}

/** Unknown syntax and non-unicast destinations are refused as well as the local ranges. */
export function classifyAddress(ip: string): AddressClass {
  const family = isIP(ip);
  if (family === 4) {
    return classifyV4(ip.split(".").map(Number));
  }
  if (family !== 6 || ip.includes("%")) {
    return "blocked";
  }
  const words = ipv6Words(ip);
  const embedded = embeddedV4(words);
  if (embedded !== undefined) {
    return embedded;
  }
  if (
    (words[0] === 0x2001 && words[1] === 0) ||
    (words[0]! & 0xffc0) === 0xfec0 ||
    (words[0]! & 0xffc0) === 0xfe80 ||
    (words[0]! & 0xff00) === 0xff00
  ) {
    return "blocked";
  }
  return isPrivateV6(words) ? "private" : "public";
}

export class StrictEgressPolicy implements EgressPolicy {
  constructor(private readonly daemonPorts: ReadonlySet<number>) {}

  permitsHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return host !== "localhost" && !host.endsWith(".localhost");
  }

  permitsAddress(address: string, port: number): boolean {
    const kind = classifyAddress(address);
    return kind === "public" || (kind === "private" && !this.daemonPorts.has(port));
  }
}

/** Call only with a WHATWG-normalized URL; literals are checked before any resolver runs. */
export function checkUrl(url: URL, policy: EgressPolicy): string | undefined {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!policy.permitsHostname(hostname)) {
    return "The destination is not permitted.";
  }
  if (isIP(hostname) && !policy.permitsAddress(hostname, destinationPort(url))) {
    return "The destination is not permitted.";
  }
  return undefined;
}

export function destinationPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

const FORBIDDEN_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "content-length",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
  "origin",
  "expect",
]);

export function forbiddenHeaderOf(headers: Record<string, string> = {}): string | undefined {
  return Object.keys(headers).find((name) => {
    const lower = name.toLowerCase();
    return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-");
  });
}
