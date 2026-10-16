import { describe, expect, test } from "bun:test";
import { extractDeviceLoopbackPorts } from "../../../src/features/prototype/prototypeLoopbackPorts";

const specOf = (...actions: object[]) => ({
  root: { type: "box", children: [{ type: "box", onTap: actions }] },
});

const request = (url: string, via?: string, extra: object = {}) => ({
  type: "request",
  method: "GET",
  url,
  ...(via ? { via } : {}),
  ...extra,
});

describe("extractDeviceLoopbackPorts", () => {
  test("collects literal ports on the three loopback hosts, sorted and deduplicated", () => {
    const spec = {
      root: {
        onTap: [
          request("http://localhost:8080/feed", "device"),
          request("http://127.0.0.1:3000/a", "device"),
          request("http://[::1]:9000/b", "device"),
          request("http://localhost:8080/again", "device"),
        ],
      },
    };
    expect(extractDeviceLoopbackPorts(spec)).toEqual({
      ports: [3000, 8080, 9000],
      unreversible: [],
    });
  });

  test("an implicit port reverses the scheme default", () => {
    const spec = specOf(
      request("http://localhost/", "device"),
      request("https://localhost/", "device"),
    );
    expect(extractDeviceLoopbackPorts(spec).ports).toEqual([80, 443]);
  });

  test("an explicit default port is the same as an implicit one", () => {
    expect(
      extractDeviceLoopbackPorts(specOf(request("http://localhost:80/", "device"))).ports,
    ).toEqual([80]);
  });

  test("via host, absent via and non-loopback hosts are ignored", () => {
    const spec = specOf(
      request("http://localhost:8080/", "host"),
      request("http://localhost:8081/"),
      request("http://example.com:8082/", "device"),
      request("http://localhost.example.com:8083/", "device"),
    );
    expect(extractDeviceLoopbackPorts(spec)).toEqual({ ports: [], unreversible: [] });
  });

  test("finds requests in nested onSuccess and onError lists", () => {
    const spec = specOf(
      request("http://localhost:1111/", "device", {
        onSuccess: [request("http://localhost:2222/", "device", { onError: [] })],
        onError: [request("http://[::1]:3333/", "device")],
      }),
    );
    expect(extractDeviceLoopbackPorts(spec).ports).toEqual([1111, 2222, 3333]);
  });

  test("a templated port is unreversible, not reversed", () => {
    const url = "http://localhost:{state:port}/feed";
    expect(extractDeviceLoopbackPorts(specOf(request(url, "device")))).toEqual({
      ports: [],
      unreversible: [
        {
          url,
          reason: "the host or port is a binding, so the port is unknown before the request runs",
        },
      ],
    });
  });

  test("a fully templated or unparseable URL is unreversible", () => {
    const result = extractDeviceLoopbackPorts(
      specOf(request("{data:/base}/feed", "device"), request("not a url", "device")),
    );
    expect(result.ports).toEqual([]);
    expect(result.unreversible.map((entry) => entry.url)).toEqual([
      "{data:/base}/feed",
      "not a url",
    ]);
    expect(result.unreversible[1].reason).toBe("the URL cannot be parsed");
  });

  test("a binding only in the path of a loopback URL still reverses its port", () => {
    expect(
      extractDeviceLoopbackPorts(specOf(request("http://localhost:8080/{data:/x}", "device")))
        .ports,
    ).toEqual([8080]);
  });

  test("non-spec input yields nothing", () => {
    for (const input of [undefined, null, 5, "x", [], {}]) {
      expect(extractDeviceLoopbackPorts(input)).toEqual({ ports: [], unreversible: [] });
    }
  });

  const lookalike = request("http://localhost:4567/", "device");

  test("request-shaped JSON in data, a request body and emit context is not an action", () => {
    const spec = {
      data: { saved: lookalike },
      root: {
        type: "box",
        onTap: [
          request("http://localhost:1111/", "device", { body: { value: lookalike } }),
          { type: "emit", name: "go", context: { a: { value: lookalike } } },
        ],
      },
    };
    expect(extractDeviceLoopbackPorts(spec).ports).toEqual([1111]);
  });

  test("finds requests in node, part and refresh action slots", () => {
    const spec = {
      root: {
        type: "column",
        children: [
          {
            type: "textField",
            stateKey: "q",
            onSubmit: [request("http://localhost:1/", "device")],
          },
          {
            type: "scroll",
            refresh: { stateKey: "r", onRefresh: [request("http://localhost:2/", "device")] },
            child: { type: "box", onLongPress: [request("http://localhost:3/", "device")] },
          },
          {
            type: "dialog",
            confirm: { label: "ok", onTap: [request("http://localhost:4/", "device")] },
          },
        ],
      },
    };
    expect(extractDeviceLoopbackPorts(spec).ports).toEqual([1, 2, 3, 4]);
  });
});
