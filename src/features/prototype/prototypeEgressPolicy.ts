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

// Each prefix carries its IPv4 destination in the low 32 bits. The local-use
// NAT64 /48 intentionally permits arbitrary words between its prefix and those bits.
const EMBEDDED_V4_PREFIXES = [
  [0, 0, 0, 0, 0, 0], // IPv4-compatible
  [0, 0, 0, 0, 0, 0xffff], // IPv4-mapped
  [0, 0, 0, 0, 0xffff, 0], // SIIT IPv4-translated
  [0x64, 0xff9b, 0, 0, 0, 0], // Well-known NAT64 /96
  [0x64, 0xff9b, 1], // Local-use NAT64 /48
] as const;

function embeddedV4(words: number[]): number[] | undefined {
  const lowBits = EMBEDDED_V4_PREFIXES.some((prefix) =>
    prefix.every((word, index) => words[index] === word),
  );
  const pair = words[0] === 0x2002 ? words.slice(1, 3) : lowBits ? words.slice(6, 8) : undefined;
  return pair?.flatMap((word) => [word >>> 8, word & 255]);
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
    return classifyV4(embedded);
  }
  if (
    (words[0] === 0x2001 && words[1] === 0) ||
    (words[0]! & 0xffc0) === 0xfec0 ||
    (words[0]! & 0xffc0) === 0xfe80 ||
    (words[0]! & 0xff00) === 0xff00
  ) {
    return "blocked";
  }
  return (words[0]! & 0xfe00) === 0xfc00 ? "private" : "public";
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
