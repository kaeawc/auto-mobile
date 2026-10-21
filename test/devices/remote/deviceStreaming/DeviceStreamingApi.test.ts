import { describe, expect, test } from "bun:test";
import {
  parseDeviceSession,
  RestDeviceStreamingApi,
} from "../../../../src/devices/remote/deviceStreaming/DeviceStreamingApi";
import { DeviceStreamingApiError } from "../../../../src/devices/remote/deviceStreaming/DeviceStreamingApiError";
import { FakeTimer } from "../../../fakes/FakeTimer";

interface RecordedRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
}

function apiWith(...responses: Response[]) {
  const requests: RecordedRequest[] = [];
  const timer = new FakeTimer();
  const api = new RestDeviceStreamingApi({
    tokens: { accessToken: async () => "token-1" },
    timer,
    fetch: async (url, init) => {
      requests.push({
        url,
        method: init.method,
        headers: init.headers,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const response = responses.shift();
      if (!response) {
        throw new Error("no scripted response");
      }
      return response;
    },
  });
  return { api, requests, timer };
}

const NAME = "projects/p1/deviceSessions/s-1";

describe("RestDeviceStreamingApi", () => {
  test("create posts the device and ttl under the project with the chosen session id", async () => {
    const { api, requests } = apiWith(Response.json({ name: NAME, state: "REQUESTED" }));

    const session = await api.create({
      projectId: "p1",
      sessionId: "s-1",
      modelId: "tokay",
      osVersionId: "34",
      ttlMinutes: 20,
    });

    expect(session).toEqual({ id: NAME, state: "requested" });
    expect(requests[0]?.url).toBe(
      "https://devicestreaming.googleapis.com/v1/projects/p1/deviceSessions?deviceSessionId=s-1",
    );
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers).toMatchObject({ authorization: "Bearer token-1" });
    expect(requests[0]?.body).toEqual({
      ttl: "1200s",
      androidDevice: { androidModelId: "tokay", androidVersionId: "34" },
    });
  });

  test("setExpireTime patches only expireTime", async () => {
    const { api, requests } = apiWith(
      Response.json({ name: NAME, state: "ACTIVE", expireTime: "2026-10-21T10:30:00Z" }),
    );

    const session = await api.setExpireTime(NAME, Date.parse("2026-10-21T10:30:00Z"));

    expect(requests[0]?.url).toBe(
      `https://devicestreaming.googleapis.com/v1/${NAME}?updateMask=expireTime`,
    );
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.body).toEqual({ expireTime: "2026-10-21T10:30:00.000Z" });
    expect(session.expireTimeMs).toBe(Date.parse("2026-10-21T10:30:00Z"));
  });

  test("cancel posts to the :cancel custom method", async () => {
    const { api, requests } = apiWith(Response.json({}));

    await api.cancel(NAME);

    expect(requests[0]?.url).toBe(`https://devicestreaming.googleapis.com/v1/${NAME}:cancel`);
    expect(requests[0]?.method).toBe("POST");
  });

  test("a Google error body becomes a DeviceStreamingApiError with its status", async () => {
    const { api } = apiWith(
      Response.json(
        {
          error: { code: 400, message: "Session already finished", status: "FAILED_PRECONDITION" },
        },
        { status: 400 },
      ),
    );

    const failure = await api.cancel(NAME).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DeviceStreamingApiError);
    expect(failure).toMatchObject({ httpStatus: 400, status: "FAILED_PRECONDITION" });
    expect(String(failure)).toContain(
      `POST ${NAME}:cancel failed with HTTP 400 FAILED_PRECONDITION: Session already finished`,
    );
  });

  test("a non-JSON error body is reported by its HTTP status", async () => {
    const { api } = apiWith(new Response("<html>bad gateway</html>", { status: 502 }));

    const failure = await api.get(NAME).catch((error: unknown) => error);

    expect(failure).toMatchObject({ httpStatus: 502, status: undefined });
  });

  test("clears the request timeout once the response arrives", async () => {
    const { api, timer } = apiWith(Response.json({ name: NAME, state: "PENDING" }));

    await api.get(NAME);

    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});

describe("parseDeviceSession", () => {
  test("maps state, the latest state message and timestamps", () => {
    expect(
      parseDeviceSession({
        name: NAME,
        state: "UNAVAILABLE",
        stateHistories: [{ stateMessage: "queued" }, { stateMessage: "model not in catalog" }],
        activeStartTime: "2026-10-21T10:00:00Z",
      }),
    ).toEqual({
      id: NAME,
      state: "unavailable",
      stateMessage: "model not in catalog",
      activeStartTimeMs: Date.parse("2026-10-21T10:00:00Z"),
      expireTimeMs: undefined,
    });
  });

  test("an unrecognized state is unknown rather than terminal", () => {
    expect(parseDeviceSession({ name: NAME, state: "WARMING_UP" }).state).toBe("unknown");
  });

  test("a body without a name is rejected", () => {
    expect(() => parseDeviceSession({ state: "ACTIVE" })).toThrow(/unexpected session/);
  });
});
