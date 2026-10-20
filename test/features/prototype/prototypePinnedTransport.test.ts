import { beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Agent as HttpAgent, IncomingMessage } from "node:http";
import { Agent as HttpsAgent, type RequestOptions } from "node:https";
import { Socket } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  createPinnedPrototypeFetch,
  type PrototypeRequestFactory,
} from "../../../src/features/prototype/prototypePinnedTransport";
import { FetchPrototypeHttpExecutor } from "../../../src/features/prototype/PrototypeHttpExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { fakePublicHostResolver } from "../../fakes/FakePrototypeEgressPolicy";

const pinned = { address: "8.8.8.8", family: 4 };
const signal = () => new AbortController().signal;
const encodings = [
  { encoding: "gzip", compress: gzipSync },
  { encoding: "deflate", compress: deflateSync },
  { encoding: "br", compress: brotliCompressSync },
];

class FakeRequest extends EventEmitter {
  constructor(private readonly respond: () => void) {
    super();
  }
  end(): this {
    queueMicrotask(this.respond);
    return this;
  }
  destroy(): this {
    return this;
  }
}

function fixture(bytes: Uint8Array, headers: Record<string, string>, end = true) {
  // An unconnected Socket only supplies IncomingMessage's constructor contract.
  const incoming = new IncomingMessage(new Socket());
  incoming.statusCode = 200;
  incoming.headers = headers;
  incoming.rawHeaders = Object.entries(headers).flat();
  incoming._read = () => {};
  incoming.push(bytes);
  if (end) {
    incoming.complete = true;
    incoming.push(null);
  }
  const calls: RequestOptions[] = [];
  const send: PrototypeRequestFactory = (options, onResponse) => {
    calls.push(options);
    return new FakeRequest(() => onResponse(incoming));
  };
  return { incoming, calls, send };
}

function executor(send: PrototypeRequestFactory, maxResponseBytes: number) {
  return new FetchPrototypeHttpExecutor({
    timer: new FakeTimer(),
    resolver: fakePublicHostResolver,
    fetch: createPinnedPrototypeFetch(send, {}),
    maxResponseBytes,
  });
}

describe("pinned prototype transport", () => {
  beforeAll(async () => {
    // Initialize Bun's native codec workers in setup. Tests still create fresh decoders
    // and responses, so their timing measures transport behavior rather than worker startup.
    for (const { encoding, compress } of encodings) {
      const { send } = fixture(compress(Buffer.from("fixture")), {
        "content-encoding": encoding,
      });
      const response = await createPinnedPrototypeFetch(send, {})(
        "https://public.test/",
        {},
        pinned,
        1024,
      );
      await response.arrayBuffer();
    }
  });

  test.each(encodings)(
    "counts decoded $encoding UTF-8 bytes rather than characters",
    async ({ encoding, compress }) => {
      const text = "é";
      const bytes = compress(Buffer.from(text));
      const { send, incoming } = fixture(bytes, {
        "content-encoding": encoding,
        "content-length": String(bytes.byteLength),
      });
      expect(
        await executor(send, text.length).execute(
          { method: "GET", url: "https://public.test/" },
          signal(),
        ),
      ).toMatchObject({ ok: false, error: { code: "too_large" } });
      expect(incoming.destroyed).toBe(true);
    },
  );

  test.each(encodings)(
    "decodes $encoding and removes wire headers",
    async ({ encoding, compress }) => {
      const text = '{"text":"é"}';
      const bytes = compress(Buffer.from(text));
      const { send } = fixture(bytes, {
        "content-encoding": encoding.toUpperCase(),
        "content-length": String(bytes.byteLength),
        "x-id": "kept",
      });
      // The compressed length exceeds this exact decoded-byte cap for each encoding.
      const cap = Buffer.byteLength(text);
      expect(bytes.byteLength).toBeGreaterThan(cap);
      const result = await executor(send, cap).execute(
        { method: "GET", url: "https://public.test/" },
        signal(),
      );
      expect(result).toMatchObject({ ok: true, body: { text: "é" }, headers: { "x-id": "kept" } });
      if (result.ok) {
        expect(result.headers["content-encoding"]).toBeUndefined();
        expect(result.headers["content-length"]).toBeUndefined();
      }
    },
  );

  test.each(encodings)(
    "caps decoded $encoding bytes before input ends",
    async ({ encoding, compress }) => {
      const bytes = compress(Buffer.alloc(4096, 97));
      const { send, incoming } = fixture(
        bytes,
        {
          "content-encoding": encoding,
          "content-length": String(bytes.byteLength),
        },
        false,
      );
      expect(bytes.byteLength).toBeLessThan(128);
      expect(
        await executor(send, 128).execute({ method: "GET", url: "https://public.test/" }, signal()),
      ).toMatchObject({ ok: false, error: { code: "too_large" } });
      expect(incoming.destroyed).toBe(true);
    },
  );

  test.each(encodings)("maps malformed $encoding to a transport failure", async ({ encoding }) => {
    const { send, incoming } = fixture(Buffer.from("invalid"), { "content-encoding": encoding });
    expect(
      await executor(send, 1024).execute({ method: "GET", url: "https://public.test/" }, signal()),
    ).toMatchObject({ ok: false, error: { code: "network" } });
    expect(incoming.destroyed).toBe(true);
  });

  test.each(["http:", "https:"])("uses a plain direct agent for %s", async (protocol) => {
    const { send, calls } = fixture(Buffer.from("ok"), {});
    const fetch = createPinnedPrototypeFetch(
      send,
      {
        HTTP_PROXY: "http://proxy.invalid:8080",
        http_proxy: "http://proxy.invalid:8080",
        HTTPS_PROXY: "http://proxy.invalid:8080",
        https_proxy: "http://proxy.invalid:8080",
        ALL_PROXY: "http://proxy.invalid:8080",
        all_proxy: "http://proxy.invalid:8080",
        NO_PROXY: "other.invalid",
        no_proxy: "other.invalid",
        NODE_USE_ENV_PROXY: "1",
      },
      "node",
    );
    const response = await fetch(
      `${protocol}//public.test:8443/path?x=1`,
      { signal: signal() },
      pinned,
      1024,
    );
    expect(await response.text()).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: pinned.address,
      family: 4,
      port: "8443",
      protocol,
      path: "/path?x=1",
      headers: { host: "public.test:8443" },
      servername: "public.test",
    });
    const agent = calls[0]?.agent;
    expect(agent).toBeInstanceOf(protocol === "https:" ? HttpsAgent : HttpAgent);
    if (agent instanceof HttpAgent) {
      expect(Reflect.get(agent, "options")).toMatchObject({ proxyEnv: {} });
    }
  });

  test.each(
    ["http:", "https:"].flatMap((protocol) =>
      [
        "HTTP_PROXY",
        "http_proxy",
        "HtTp_PrOxY",
        "HTTPS_PROXY",
        "https_proxy",
        "HtTpS_PrOxY",
        "ALL_PROXY",
        "all_proxy",
        "AlL_PrOxY",
      ].map((name) => ({ protocol, name })),
    ),
  )("refuses Bun $name for $protocol before creating a request", async ({ name, protocol }) => {
    const { send, calls } = fixture(Buffer.from("ok"), {});
    const fetch = createPinnedPrototypeFetch(
      send,
      {
        [name]: "http://proxy.invalid:8080",
        NO_PROXY: "*",
        no_proxy: "*",
      },
      "bun",
    );
    await expect(fetch(`${protocol}//public.test/`, {}, pinned, 1024)).rejects.toThrow(
      "direct connection",
    );
    expect(calls).toHaveLength(0);
  });

  test.each(["NO_PROXY", "no_proxy", "No_PrOxY"])(
    "allows direct Bun requests with only %s",
    async (name) => {
      const { send, calls } = fixture(Buffer.from("ok"), {});
      const fetch = createPinnedPrototypeFetch(send, { [name]: "*" }, "bun");
      expect(await (await fetch("http://public.test/", {}, pinned, 1024)).text()).toBe("ok");
      expect(calls[0]?.host).toBe(pinned.address);
    },
  );

  test.each(["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])(
    "refuses Bun's non-enumerable proxy getter %s",
    async (name) => {
      const environment = {};
      Object.defineProperty(environment, name, { get: () => "http://proxy.invalid:8080" });
      const { send, calls } = fixture(Buffer.from("ok"), {});
      await expect(
        createPinnedPrototypeFetch(send, environment, "bun")(
          "http://public.test/",
          {},
          pinned,
          1024,
        ),
      ).rejects.toThrow("direct connection");
      expect(calls).toHaveLength(0);
    },
  );
});
