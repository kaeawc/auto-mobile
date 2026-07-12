/**
 * Trickle-ICE helpers for the WHIP publisher.
 *
 * WHIP's trickle extension exchanges ICE candidates incrementally as
 * `application/trickle-ice-sdpfrag` bodies (RFC 8840) via HTTP PATCH to the
 * session resource, instead of blocking on ICE gathering before the offer is
 * POSTed. These functions are pure/serialization-only so they can be unit-tested
 * without a peer connection or HTTP.
 */

/** Minimal candidate shape (matches the fields werift's RTCIceCandidate exposes). */
export interface TrickleCandidate {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
}

/** Optional ICE credentials identifying the generation the candidate belongs to. */
export interface IceCredentials {
  ufrag?: string;
  pwd?: string;
}

/** Ensure the candidate value carries the `candidate:` prefix exactly once. */
function normalizeCandidateLine(candidate: string): string {
  const trimmed = candidate.trim();
  return trimmed.startsWith("candidate:") ? trimmed : `candidate:${trimmed}`;
}

/**
 * Serialize one candidate into a trickle-ICE SDP fragment. Includes the ICE
 * ufrag/pwd (when known) and the media `mid` so the receiver can attribute the
 * candidate to the correct m-line.
 */
export function serializeTrickleFragment(
  candidate: TrickleCandidate,
  ice: IceCredentials = {}
): string {
  const lines: string[] = [];
  if (ice.ufrag) {
    lines.push(`a=ice-ufrag:${ice.ufrag}`);
  }
  if (ice.pwd) {
    lines.push(`a=ice-pwd:${ice.pwd}`);
  }
  if (candidate.sdpMid !== undefined && candidate.sdpMid !== null) {
    lines.push(`a=mid:${candidate.sdpMid}`);
  }
  lines.push(`a=${normalizeCandidateLine(candidate.candidate)}`);
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Parse a trickle-ICE SDP fragment back into candidate inits. Lenient: it reads
 * the `a=mid:` (applied to following candidates) and every `a=candidate:` line,
 * ignoring anything else.
 */
export function parseTrickleFragment(fragment: string): TrickleCandidate[] {
  const candidates: TrickleCandidate[] = [];
  let mid: string | undefined;
  for (const rawLine of fragment.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("a=mid:")) {
      mid = line.slice("a=mid:".length).trim() || undefined;
    } else if (line.startsWith("a=candidate:")) {
      candidates.push({ candidate: line.slice("a=".length), sdpMid: mid });
    }
  }
  return candidates;
}

/**
 * Buffers local ICE candidates until the WHIP resource URL is known, then sends
 * them (and every later candidate) as trickle fragments. Pure of any transport:
 * `send` performs the actual PATCH. Safe to call `addCandidate` before or after
 * `setResource`; `stop` drops anything not yet sent.
 */
export class TrickleIceForwarder {
  private resourceUrl: string | null = null;
  private buffered: string[] = [];
  private stopped = false;

  constructor(
    private readonly send: (resourceUrl: string, fragment: string) => void,
    private readonly ice: IceCredentials = {}
  ) {}

  addCandidate(candidate: TrickleCandidate): void {
    if (this.stopped) {
      return;
    }
    const fragment = serializeTrickleFragment(candidate, this.ice);
    if (this.resourceUrl === null) {
      this.buffered.push(fragment);
    } else {
      this.send(this.resourceUrl, fragment);
    }
  }

  /** Record the resource URL and flush any candidates buffered before it. */
  setResource(resourceUrl: string | null): void {
    if (this.stopped) {
      return;
    }
    this.resourceUrl = resourceUrl;
    if (resourceUrl === null) {
      return;
    }
    const pending = this.buffered;
    this.buffered = [];
    for (const fragment of pending) {
      this.send(resourceUrl, fragment);
    }
  }

  stop(): void {
    this.stopped = true;
    this.buffered = [];
  }
}
