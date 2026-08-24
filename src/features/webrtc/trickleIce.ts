/**
 * Trickle-ICE helpers for the WHIP publisher.
 *
 * WHIP's trickle extension exchanges ICE candidates incrementally as
 * `application/trickle-ice-sdpfrag` bodies via HTTP PATCH to the session
 * resource, instead of blocking on ICE gathering before the offer is POSTed.
 *
 * Standards: [Trickle ICE (RFC 8838)](https://www.rfc-editor.org/rfc/rfc8838.html),
 * [SDP fragments (RFC 8840)](https://www.rfc-editor.org/rfc/rfc8840.html), and
 * [WHIP §4.3 (RFC 9725)](https://www.rfc-editor.org/rfc/rfc9725.html#section-4.3).
 * These functions are pure/serialization-only so they can be unit-tested without
 * a peer connection or HTTP.
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

/** SDP context required by RFC 8840 for a media-level candidate fragment. */
export interface TrickleIceMediaContext {
  mLine: string;
  mid: string;
  ice: Required<IceCredentials>;
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
  context: TrickleIceMediaContext,
): string {
  const lines = [
    context.mLine,
    `a=mid:${candidate.sdpMid ?? context.mid}`,
    `a=ice-ufrag:${context.ice.ufrag}`,
    `a=ice-pwd:${context.ice.pwd}`,
  ];
  lines.push(`a=${normalizeCandidateLine(candidate.candidate)}`);
  return `${lines.join("\r\n")}\r\n`;
}

/** Serialize the terminal marker for one Trickle-ICE media section. */
export function serializeEndOfCandidates(context: TrickleIceMediaContext): string {
  return [
    context.mLine,
    `a=mid:${context.mid}`,
    `a=ice-ufrag:${context.ice.ufrag}`,
    `a=ice-pwd:${context.ice.pwd}`,
    "a=end-of-candidates",
    "",
  ].join("\r\n");
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
    private readonly contexts: Map<string, TrickleIceMediaContext>,
  ) {}

  addCandidate(candidate: TrickleCandidate): void {
    if (this.stopped) {
      return;
    }
    const context = this.contextFor(candidate.sdpMid);
    if (!context) {
      return;
    }
    const fragment = serializeTrickleFragment(candidate, context);
    if (this.resourceUrl === null) {
      this.buffered.push(fragment);
    } else {
      this.send(this.resourceUrl, fragment);
    }
  }

  /** Forward the RFC 8838 end-of-candidates marker once gathering completes. */
  completeGathering(mid?: string): void {
    if (this.stopped) {
      return;
    }
    const context = this.contextFor(mid);
    if (!context) {
      return;
    }
    const fragment = serializeEndOfCandidates(context);
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

  private contextFor(mid: string | undefined): TrickleIceMediaContext | undefined {
    return mid === undefined ? this.contexts.values().next().value : this.contexts.get(mid);
  }
}

/** Extract media-level pseudo-section context from a locally generated SDP offer. */
export function parseTrickleIceMediaContexts(sdp: string): Map<string, TrickleIceMediaContext> {
  const sessionIce = extractIceCredentials(sdp.split(/\r?\n(?=m=)/)[0]);
  const contexts = new Map<string, TrickleIceMediaContext>();
  for (const section of sdp.split(/\r?\n(?=m=)/).slice(1)) {
    const lines = section.split(/\r?\n/).filter(Boolean);
    const mLine = lines[0];
    const mid = lines.find((line) => line.startsWith("a=mid:"))?.slice("a=mid:".length);
    const ice = { ...sessionIce, ...extractIceCredentials(section) };
    if (mLine && mid && ice.ufrag && ice.pwd) {
      contexts.set(mid, { mLine, mid, ice: { ufrag: ice.ufrag, pwd: ice.pwd } });
    }
  }
  return contexts;
}

function extractIceCredentials(sdp: string): IceCredentials {
  const ufrag = sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim();
  const pwd = sdp.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim();
  return { ufrag, pwd };
}
