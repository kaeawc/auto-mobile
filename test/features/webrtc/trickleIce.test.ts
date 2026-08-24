import { describe, expect, test } from "bun:test";
import {
  TrickleIceForwarder,
  parseTrickleFragment,
  serializeTrickleFragment,
} from "../../../src/features/webrtc/trickleIce";

const context = {
  mLine: "m=video 9 UDP/TLS/RTP/SAVPF 102",
  mid: "0",
  ice: { ufrag: "abc", pwd: "def" },
};
const contexts = new Map([[context.mid, context]]);

describe("serializeTrickleFragment / parseTrickleFragment", () => {
  test("round-trips a candidate with mid and ICE credentials", () => {
    const fragment = serializeTrickleFragment(
      { candidate: "candidate:1 1 udp 2113 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 },
      context,
    );
    expect(fragment).toContain("a=ice-ufrag:abc");
    expect(fragment).toContain("a=ice-pwd:def");
    expect(fragment).toContain("a=mid:0");
    expect(fragment).toContain("a=candidate:1 1 udp 2113 1.2.3.4 5000 typ host");

    const parsed = parseTrickleFragment(fragment);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].candidate).toBe("candidate:1 1 udp 2113 1.2.3.4 5000 typ host");
    expect(parsed[0].sdpMid).toBe("0");
  });

  test("adds the candidate: prefix when missing", () => {
    const fragment = serializeTrickleFragment(
      { candidate: "1 1 udp 2113 1.2.3.4 5000 typ host" },
      context,
    );
    expect(fragment).toContain("a=candidate:1 1 udp");
  });

  test("parses multiple candidates under one mid", () => {
    const fragment = [
      "a=mid:1",
      "a=candidate:a 1 udp 1 h 1 typ host",
      "a=candidate:b 1 udp 1 h 2 typ host",
    ].join("\r\n");
    const parsed = parseTrickleFragment(fragment);
    expect(parsed.map((c) => c.sdpMid)).toEqual(["1", "1"]);
    expect(parsed).toHaveLength(2);
  });
});

describe("TrickleIceForwarder", () => {
  test("buffers candidates until the resource URL is known, then flushes in order", () => {
    const sent: Array<{ url: string; fragment: string }> = [];
    const forwarder = new TrickleIceForwarder(
      (url, fragment) => sent.push({ url, fragment }),
      contexts,
    );

    forwarder.addCandidate({ candidate: "candidate:a 1 udp 1 h 1 typ host" });
    forwarder.addCandidate({ candidate: "candidate:b 1 udp 1 h 2 typ host" });
    expect(sent).toHaveLength(0); // buffered — no resource URL yet

    forwarder.setResource("https://coord/whip/s");
    expect(sent).toHaveLength(2);
    expect(sent[0].url).toBe("https://coord/whip/s");
    expect(sent[0].fragment).toContain("candidate:a");
    expect(sent[1].fragment).toContain("candidate:b");
  });

  test("sends immediately once the resource URL is set", () => {
    const sent: string[] = [];
    const forwarder = new TrickleIceForwarder((_url, fragment) => sent.push(fragment), contexts);
    forwarder.setResource("https://coord/whip/s");
    forwarder.addCandidate({ candidate: "candidate:c 1 udp 1 h 3 typ host" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("candidate:c");
  });

  test("stop() drops buffered candidates and ignores further ones", () => {
    const sent: string[] = [];
    const forwarder = new TrickleIceForwarder((_url, fragment) => sent.push(fragment), contexts);
    forwarder.addCandidate({ candidate: "candidate:a 1 udp 1 h 1 typ host" });
    forwarder.stop();
    forwarder.setResource("https://coord/whip/s");
    forwarder.addCandidate({ candidate: "candidate:b 1 udp 1 h 2 typ host" });
    expect(sent).toHaveLength(0);
  });

  test("null resource (no Location header) keeps candidates unsent without error", () => {
    const sent: string[] = [];
    const forwarder = new TrickleIceForwarder((_url, fragment) => sent.push(fragment), contexts);
    forwarder.addCandidate({ candidate: "candidate:a 1 udp 1 h 1 typ host" });
    expect(() => forwarder.setResource(null)).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});
