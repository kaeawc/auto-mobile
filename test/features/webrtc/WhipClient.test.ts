import { describe, expect, test } from "bun:test";
import { WhipClient, type FetchLike } from "../../../src/features/webrtc/WhipClient";
import { FakeTimer } from "../../fakes/FakeTimer";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(
  handler: (recorded: Recorded) => {
    status: number;
    body?: string;
    location?: string | null;
  }
): { fetchImpl: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const recorded: Recorded = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(recorded);
    const result = handler(recorded);
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location" ? result.location ?? null : null,
      },
      text: async () => result.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

describe("WhipClient.publish", () => {
  test("POSTs the offer as application/sdp and returns answer + resolved resource URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 201,
      body: "v=0\r\n(answer)",
      location: "/whip/session/abc123",
    }));
    const client = new WhipClient({
      endpoint: "https://coord.example.com/whip",
      bearerToken: "secret",
      fetchImpl,
    });

    const session = await client.publish("v=0\r\n(offer)");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["Content-Type"]).toBe("application/sdp");
    expect(calls[0].headers["Authorization"]).toBe("Bearer secret");
    expect(calls[0].body).toBe("v=0\r\n(offer)");
    expect(session.answerSdp).toContain("(answer)");
    // Relative Location resolved against the endpoint origin.
    expect(session.resourceUrl).toBe("https://coord.example.com/whip/session/abc123");
  });

  test("keeps an absolute Location header as-is", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 201,
      body: "answer",
      location: "https://edge2.example.com/r/xyz",
    }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    const session = await client.publish("offer");
    expect(session.resourceUrl).toBe("https://edge2.example.com/r/xyz");
  });

  test("throws an actionable error on non-201 status", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 401, body: "unauthorized" }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    await expect(client.publish("offer")).rejects.toThrow(/401/);
  });

  test("throws when the answer SDP is empty", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 201, body: "   ", location: "/r/1" }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    await expect(client.publish("offer")).rejects.toThrow(/empty SDP/);
  });

  test("rejects a missing Location header because the session could not be cleaned up", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 201, body: "answer", location: null }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    await expect(client.publish("offer")).rejects.toThrow(/required Location/);
  });

  test("aborts a stalled request at the configured timeout", async () => {
    const timer = new FakeTimer();
    let aborted = false;
    const fetchImpl: FetchLike = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const client = new WhipClient({
      endpoint: "https://coord.example.com/whip",
      fetchImpl,
      timer,
      requestTimeoutMs: 10,
    });

    const publishing = client.publish("offer");
    timer.advanceTime(10);

    await expect(publishing).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
  });
});

describe("WhipClient.delete", () => {
  test("DELETEs the resource URL with the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200 }));
    const client = new WhipClient({
      endpoint: "https://coord.example.com/whip",
      bearerToken: "tok",
      fetchImpl,
    });
    await client.delete("https://coord.example.com/whip/session/abc123");
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://coord.example.com/whip/session/abc123");
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok");
  });

  test("does not throw on 404 (already gone)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404 }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    await expect(client.delete("https://coord.example.com/whip/session/x")).resolves.toBeUndefined();
  });
});

describe("WhipClient.patchCandidate", () => {
  test("PATCHes the trickle fragment as application/trickle-ice-sdpfrag", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }));
    const client = new WhipClient({
      endpoint: "https://coord.example.com/whip",
      bearerToken: "tok",
      fetchImpl,
    });
    await client.patchCandidate("https://coord.example.com/whip/s", "a=candidate:1 1 udp ...\r\n");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe("https://coord.example.com/whip/s");
    expect(calls[0].headers["Content-Type"]).toBe("application/trickle-ice-sdpfrag");
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok");
    expect(calls[0].body).toContain("a=candidate:1 1 udp");
  });

  test("does not throw when the server does not support trickle (405)", async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 405 }));
    const client = new WhipClient({ endpoint: "https://coord.example.com/whip", fetchImpl });
    await expect(
      client.patchCandidate("https://coord.example.com/whip/s", "a=candidate:...")
    ).resolves.toBeUndefined();
  });
});

describe("WhipClient construction", () => {
  test("requires an endpoint", () => {
    expect(() => new WhipClient({ endpoint: "", fetchImpl: (async () => ({})) as unknown as FetchLike })).toThrow(
      /endpoint/
    );
  });
});
