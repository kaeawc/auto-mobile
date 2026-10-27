import { describe, expect, test } from "bun:test";
import {
  FetchPrototypeHttpExecutor,
  type FetchPrototypeHttpExecutorOptions,
  type PrototypeFetch,
  type PrototypeHttpRequest,
} from "../../../src/features/prototype/PrototypeHttpExecutor";
import type { ResolvedHostAddress } from "../../../src/features/prototype/prototypeEgressPolicy";
import { StrictEgressPolicy } from "../../../src/features/prototype/prototypeEgressPolicy";
import {
  prototypeDaemonPorts,
  registerPrototypeDaemonPort,
} from "../../../src/features/prototype/prototypeDaemonPorts";
import {
  DAEMON_PORT_RANGE_END,
  DAEMON_PORT_RANGE_START,
  DEFAULT_DAEMON_PORT,
} from "../../../src/daemon/wire/constants";
import { PortManager } from "../../../src/utils/PortManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { prototypeResponseMessageSchema } from "../../../src/features/prototype/prototypeRequestProtocol";
import { applyPrototypeRequestOutcome } from "../../../src/features/prototype/prototypeRequestOutcome";

const publicAddress = { address: "8.8.8.8", family: 4 };
const request: PrototypeHttpRequest = { method: "GET", url: "https://public.test/path" };
const signal = () => new AbortController().signal;
const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { Location: location } });

class FakeTransport {
  readonly calls: { url: string; init: RequestInit; pinned: ResolvedHostAddress }[] = [];
  readonly fetch: PrototypeFetch = async (url, init, pinned) => {
    this.calls.push({ url, init, pinned });
    return this.respond(this.calls.length);
  };
  constructor(readonly respond: (call: number) => Response = () => Response.json({ ok: true })) {}
}

function executor(
  transport: FakeTransport,
  options: Partial<FetchPrototypeHttpExecutorOptions> = {},
) {
  return new FetchPrototypeHttpExecutor({
    fetch: transport.fetch,
    resolver: async () => [publicAddress],
    timer: new FakeTimer(),
    ...options,
  });
}

describe("FetchPrototypeHttpExecutor egress hardening", () => {
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
    "[64:ff9b:1::808:808]",
    "[64:ff9b:1::c0a8:10a]",
    "[64:ff9b:1:abcd:1234:5678:a9fe:a9fe]",
    "[2001::808:808]",
    "[2001:0:ffff:ffff:ffff:ffff:ffff:ffff]",
    "[fec0::1]",
    "[feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "[fe80::1]",
    "169.254.169.254",
    "0.0.0.0",
    "10.0.2.1",
    "10.0.2.2",
    "10.0.2.3",
    "10.0.2.4",
    "10.0.2.5",
    "10.0.2.6",
    "10.0.3.2",
    "localhost",
    "LOCALHOST.",
    "foo.localhost",
    "foo.localhost.",
  ])("refuses %s before resolution or transport", async (host) => {
    const transport = new FakeTransport();
    let resolutions = 0;
    const subject = executor(transport, {
      resolver: async () => {
        resolutions++;
        return [publicAddress];
      },
    });
    expect(await subject.execute({ ...request, url: `http://${host}/` }, signal())).toMatchObject({
      ok: false,
      error: { code: "blocked_destination" },
    });
    expect(resolutions).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  test("refuses when any resolved address is blocked", async () => {
    const transport = new FakeTransport();
    const subject = executor(transport, {
      resolver: async () => [publicAddress, { address: "127.0.0.1", family: 4 }],
    });
    expect(await subject.execute(request, signal())).toMatchObject({
      ok: false,
      error: { code: "blocked_destination" },
    });
    expect(transport.calls).toHaveLength(0);
  });

  test("pins the validated answer and resolves afresh for each connection", async () => {
    const transport = new FakeTransport();
    let resolutions = 0;
    const subject = executor(transport, {
      resolver: async () => {
        resolutions++;
        return resolutions === 1 ? [publicAddress] : [{ address: "127.0.0.1", family: 4 }];
      },
    });
    expect(await subject.execute(request, signal())).toMatchObject({ ok: true });
    expect(transport.calls[0]?.pinned).toEqual(publicAddress);
    expect(resolutions).toBe(1);
    expect(await subject.execute(request, signal())).toMatchObject({
      ok: false,
      error: { code: "blocked_destination" },
    });
    expect(transport.calls).toHaveLength(1);
    expect(resolutions).toBe(2);
  });

  test.each(["8.8.8.8", "10.0.2.15", "10.1.2.3", "192.168.1.10", "10.0.2.7"])(
    "allows literal %s without DNS",
    async (host) => {
      const transport = new FakeTransport();
      const subject = executor(transport, {
        resolver: async () => {
          throw new Error("Literal must not resolve");
        },
      });
      expect(await subject.execute({ ...request, url: `http://${host}/` }, signal())).toMatchObject(
        {
          ok: true,
        },
      );
      expect(transport.calls[0]?.pinned).toEqual({ address: host, family: 4 });
    },
  );

  test("public host success uses a normalized URL and manual redirect semantics", async () => {
    const transport = new FakeTransport();
    expect(
      await executor(transport).execute(
        { ...request, url: "HTTP://PUBLIC.TEST:80/a/../path" },
        signal(),
      ),
    ).toMatchObject({ ok: true, body: { ok: true } });
    expect(transport.calls[0]?.url).toBe("http://public.test/path");
    expect(transport.calls[0]?.init.redirect).toBe("manual");
  });

  test("normalizes alternate public IPv4 notation before forwarding", async () => {
    const transport = new FakeTransport();
    await executor(transport).execute({ ...request, url: "http://134744072/" }, signal());
    expect(transport.calls[0]?.url).toBe("http://8.8.8.8/");
    expect(transport.calls[0]?.pinned).toEqual(publicAddress);
  });

  test("blocked_destination survives wire validation and outcome metadata", async () => {
    const outcome = await executor(new FakeTransport()).execute(
      { ...request, url: "http://127.1/" },
      signal(),
    );
    const response = prototypeResponseMessageSchema.parse({
      type: "prototype_response",
      requestId: "r",
      ...outcome,
    });
    expect(applyPrototypeRequestOutcome({}, "/data/feed", response).meta.error).toEqual({
      code: "blocked_destination",
      message: "The destination is not permitted.",
    });
  });

  test.each(["127.0.0.1", "[::ffff:7f00:1]", "localhost"])(
    "checks redirect destination %s",
    async (host) => {
      const transport = new FakeTransport(() => redirect(`https://${host}/`));
      expect(await executor(transport).execute(request, signal())).toMatchObject({
        ok: false,
        error: { code: "blocked_destination" },
      });
      expect(transport.calls).toHaveLength(1);
    },
  );

  test("rechecks all DNS answers on a same-origin redirect", async () => {
    const transport = new FakeTransport(() => redirect("/next"));
    let resolutions = 0;
    const subject = executor(transport, {
      resolver: async () =>
        ++resolutions === 1
          ? [publicAddress]
          : [publicAddress, { address: "169.254.169.254", family: 4 }],
    });
    expect(await subject.execute(request, signal())).toMatchObject({
      ok: false,
      error: { code: "blocked_destination" },
    });
    expect(resolutions).toBe(2);
    expect(transport.calls).toHaveLength(1);
  });

  test("refuses a scheme downgrade", async () => {
    const transport = new FakeTransport(() => redirect("http://public.test/"));
    expect(await executor(transport).execute(request, signal())).toMatchObject({
      ok: false,
      error: { code: "blocked_destination", message: expect.stringContaining("scheme downgrade") },
    });
    expect(transport.calls).toHaveLength(1);
  });

  test("allows an http to https redirect", async () => {
    const transport = new FakeTransport((call) =>
      call === 1 ? redirect(request.url) : Response.json("ok"),
    );
    expect(
      await executor(transport).execute({ ...request, url: "http://public.test/" }, signal()),
    ).toMatchObject({ ok: true });
    expect(transport.calls).toHaveLength(2);
  });

  test("allows five hops and refuses a sixth", async () => {
    const allowed = new FakeTransport((call) =>
      call <= 5 ? redirect(`/hop${call}`) : Response.json("ok"),
    );
    expect(await executor(allowed).execute(request, signal())).toMatchObject({ ok: true });
    expect(allowed.calls).toHaveLength(6);
    const excessive = new FakeTransport(() => redirect("/next"));
    expect(await executor(excessive).execute(request, signal())).toMatchObject({
      ok: false,
      error: { code: "network" },
    });
    expect(excessive.calls).toHaveLength(6);
  });

  test.each(
    (["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const).flatMap((method) =>
      [301, 302, 303, 307, 308].map((status) => ({ method, status })),
    ),
  )("applies method/body rules for $method through $status", async ({ method, status }) => {
    const transport = new FakeTransport((call) =>
      call === 1 ? redirect("/next", status) : new Response(null),
    );
    const bodied = method !== "GET" && method !== "HEAD";
    const rewrite =
      (status === 303 && bodied) || ((status === 301 || status === 302) && method === "POST");
    expect(
      await executor(transport).execute(
        { ...request, method, body: bodied ? { x: 1 } : undefined },
        signal(),
      ),
    ).toMatchObject({ ok: true });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.init.method).toBe(rewrite ? "GET" : method);
    expect(transport.calls[1]?.init.body).toBe(bodied && !rewrite ? '{"x":1}' : undefined);
  });

  test.each(["POST", "PUT"] as const)(
    "applies same-origin body-header rules for %s through 302",
    async (method) => {
      const transport = new FakeTransport((call) =>
        call === 1 ? redirect("/next", 302) : new Response(null),
      );
      const headers = {
        "Content-Type": "application/merge-patch+json",
        "content-language": "en",
        "Content-Encoding": "identity",
        "Content-Location": "/x",
        "X-Trace": "1",
        Authorization: "secret",
      };
      expect(
        await executor(transport).execute(
          { ...request, method, body: { x: 1 }, headers },
          signal(),
        ),
      ).toMatchObject({ ok: true });
      expect(transport.calls).toHaveLength(2);
      expect(transport.calls[1]?.init.headers).toEqual(
        method === "POST" ? { "X-Trace": "1", Authorization: "secret" } : headers,
      );
      expect(transport.calls[1]?.init.method).toBe(method === "POST" ? "GET" : "PUT");
      expect(transport.calls[1]?.init.body).toBe(method === "POST" ? undefined : '{"x":1}');
      expect(headers["Content-Type"]).toBe("application/merge-patch+json");
    },
  );

  test.each(["https://other.test/", "https://public.test:8443/", "http://public.test/"])(
    "drops authored credential headers on origin change to %s",
    async (next) => {
      const transport = new FakeTransport((call) =>
        call === 1 ? redirect(next, 307) : Response.json("ok"),
      );
      await executor(transport).execute(
        {
          ...request,
          url: "http://public.test:8080/",
          method: "POST",
          body: { x: 1 },
          headers: {
            Authorization: "secret",
            "X-Api-Key": "secret",
            "Unusual-Credential": "secret",
          },
        },
        signal(),
      );
      const forwarded = new Headers(transport.calls[1]?.init.headers);
      expect(forwarded.has("authorization")).toBe(false);
      expect(forwarded.has("x-api-key")).toBe(false);
      expect(forwarded.has("unusual-credential")).toBe(false);
      expect(forwarded.get("content-type")).toBe("application/json");
    },
  );

  test("preserves Authorization for a same-origin redirect", async () => {
    const transport = new FakeTransport((call) =>
      call === 1 ? redirect("/next") : Response.json("ok"),
    );
    await executor(transport).execute(
      { ...request, headers: { Authorization: "secret" } },
      signal(),
    );
    expect(new Headers(transport.calls[1]?.init.headers).get("authorization")).toBe("secret");
  });

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
    "pRoXy-Custom",
  ])("refuses header %s before any network", async (name) => {
    const transport = new FakeTransport();
    let resolutions = 0;
    const subject = executor(transport, {
      resolver: async () => {
        resolutions++;
        return [publicAddress];
      },
    });
    expect(
      await subject.execute({ ...request, headers: { [name]: "secret" } }, signal()),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(resolutions).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  test.each([
    DEFAULT_DAEMON_PORT,
    ...Array.from(
      { length: DAEMON_PORT_RANGE_END - DAEMON_PORT_RANGE_START + 1 },
      (_, index) => DAEMON_PORT_RANGE_START + index,
    ),
    PortManager.DEVICE_PORT,
  ])("restricts default daemon port %s on private addresses", async (port) => {
    const transport = new FakeTransport();
    const subject = executor(transport, {
      resolver: async () => [{ address: "192.168.1.5", family: 4 }],
    });
    expect(
      await subject.execute({ ...request, url: `http://private.test:${port}/` }, signal()),
    ).toMatchObject({ ok: false, error: { code: "blocked_destination" } });
    expect(
      await executor(transport).execute(
        { ...request, url: `http://public.test:${port}/` },
        signal(),
      ),
    ).toMatchObject({ ok: true });
  });

  test("configured and injected daemon-port sets are enforced", async () => {
    const transport = new FakeTransport();
    const subject = executor(transport);
    registerPrototypeDaemonPort(43210);
    expect(prototypeDaemonPorts.has(43210)).toBe(true);
    expect(
      await subject.execute({ ...request, url: "http://10.0.2.15:43210/" }, signal()),
    ).toMatchObject({ ok: false, error: { code: "blocked_destination" } });
    const injected = executor(transport, { policy: new StrictEgressPolicy(new Set([54321])) });
    expect(
      await injected.execute({ ...request, url: "http://10.0.2.15:54321/" }, signal()),
    ).toMatchObject({ ok: false, error: { code: "blocked_destination" } });
  });

  test.each([
    { addresses: [], code: "network" },
    { addresses: [{ address: "public.test", family: 4 }], code: "blocked_destination" },
    { addresses: [{ address: "8.8.8.8", family: 6 }], code: "blocked_destination" },
  ])("refuses an unusable resolver answer %j", async ({ addresses, code }) => {
    const transport = new FakeTransport();
    const outcome = await executor(transport, { resolver: async () => [...addresses] }).execute(
      request,
      signal(),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code } });
    expect(transport.calls).toHaveLength(0);
  });

  test("timeout covers a pending resolver and prevents a later connection", async () => {
    const timer = new FakeTimer();
    const transport = new FakeTransport();
    let answer: (addresses: ResolvedHostAddress[]) => void = () => {};
    const subject = executor(transport, {
      timer,
      resolver: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const pending = subject.execute({ ...request, timeoutMs: 10 }, signal());
    timer.advanceTime(10);
    expect(await pending).toMatchObject({ ok: false, error: { code: "timeout" } });
    answer([publicAddress]);
    await Promise.resolve();
    expect(transport.calls).toHaveLength(0);
  });

  test.each([
    { response: new Response(null, { status: 302 }), code: "invalid_response" },
    { response: redirect("http://["), code: "invalid_response" },
    { response: redirect("file:///path"), code: "invalid_url" },
    { response: redirect("https://user:secret@public.test/"), code: "invalid_request" },
  ])("refuses invalid redirect response %#", async ({ response, code }) => {
    const transport = new FakeTransport(() => response);
    expect(await executor(transport).execute(request, signal())).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(transport.calls).toHaveLength(1);
  });

  test("network failures never echo URL query strings or header values", async () => {
    const subject = new FetchPrototypeHttpExecutor({
      timer: new FakeTimer(),
      resolver: async () => [publicAddress],
      fetch: async () => {
        throw new Error("secret query and header values");
      },
    });
    const outcome = await subject.execute(
      {
        ...request,
        url: "https://public.test/?secret=value",
        headers: { Authorization: "secret" },
      },
      signal(),
    );
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "network", message: "The request could not complete." },
    });
  });
});
