import { describe, expect, test } from "bun:test";
import {
  applyPrototypeAuthSessionExpired,
  applyPrototypeAuthSignIn,
  applyPrototypeAuthSignOut,
  prototypeAuthPlatformState,
  restorePrototypeAuthSession,
  type PrototypeAuthBlock,
} from "../../../src/features/prototype/prototypeAuthSession";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakePrototypeAuthSessionStore } from "../../fakes/FakePrototypeAuthSessionStore";
import { FakeTimer } from "../../fakes/FakeTimer";

const auth: PrototypeAuthBlock = {
  provider: "fake",
  accounts: [
    { id: "u1", name: "Ada Lovelace", email: "ada@example.test", avatar: "ada" },
    { id: "u2", name: "Grace Hopper", email: "grace@example.test" },
  ],
  sessionTtlSeconds: 60,
};

function setup(block: PrototypeAuthBlock = auth) {
  const store = new FakePrototypeAuthSessionStore();
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000_000);
  const ids = new FakeIdGenerator(["tok-1", "tok-2"]);
  const context = () => ({ auth: block, store, nowMs: timer.now(), ids });
  return { store, timer, context };
}

describe("applyPrototypeAuthSignIn", () => {
  test("writes the chosen account to the default into and stores the session", () => {
    const { store, context } = setup();
    const result = applyPrototypeAuthSignIn(
      { other: 1 },
      undefined,
      { ok: true, userId: "u2" },
      context(),
    );
    expect(result).toEqual({
      status: "success",
      data: {
        other: 1,
        session: { userId: "u2", name: "Grace Hopper", email: "grace@example.test" },
      },
      platform: { signedIn: true, userId: "u2" },
    });
    expect(store.session).toEqual({ token: "fake-tok-1", userId: "u2", expiresAtMs: 1_060_000 });
  });

  test("honours an authored into and the default TTL", () => {
    const { store, context } = setup({ provider: "fake", accounts: auth.accounts });
    const result = applyPrototypeAuthSignIn({}, "/data/me", { ok: true, userId: "u1" }, context());
    expect(result.data).toEqual({
      me: { userId: "u1", name: "Ada Lovelace", email: "ada@example.test" },
    });
    expect(store.session?.expiresAtMs).toBe(1_000_000 + 3_600_000);
  });

  test("cancelled keeps its code and leaves data and the prior session alone", () => {
    const { store, context } = setup();
    applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u1" }, context());
    const before = store.session;
    const data = { session: { userId: "u1" } };
    const result = applyPrototypeAuthSignIn(
      data,
      undefined,
      { ok: false, error: { code: "cancelled", message: "dismissed" } },
      context(),
    );
    expect(result).toEqual({
      status: "error",
      data,
      platform: { signedIn: true, userId: "u1" },
      error: { code: "cancelled", message: "dismissed" },
    });
    expect(store.session).toBe(before);
  });

  test("unavailable is kept and unknown codes become platform_error", () => {
    const { context } = setup();
    const unavailable = applyPrototypeAuthSignIn(
      {},
      undefined,
      { ok: false, error: { code: "unavailable", message: "no credentials" } },
      context(),
    );
    const other = applyPrototypeAuthSignIn(
      {},
      undefined,
      { ok: false, error: { code: "rate_limited", message: "x" } },
      context(),
    );
    expect(unavailable.status === "error" && unavailable.error.code).toBe("unavailable");
    expect(other.status === "error" && other.error.code).toBe("platform_error");
  });

  test("an account the spec does not list is platform_error and stores nothing", () => {
    const { store, context } = setup();
    const result = applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u9" }, context());
    expect(result.status).toBe("error");
    expect(result.data).toEqual({});
    expect(result.platform).toEqual({ signedIn: false });
    expect(store.session).toBeUndefined();
  });

  test("an unwritable into is platform_error and stores nothing", () => {
    const { store, context } = setup();
    const result = applyPrototypeAuthSignIn({}, "/state/x", { ok: true, userId: "u1" }, context());
    expect(result.status === "error" && result.error.code).toBe("platform_error");
    expect(store.session).toBeUndefined();
  });

  test("a store failure rolls back data and does not echo the store message", () => {
    const { store, context } = setup();
    store.writeError = new Error("could not save fake-tok-1");
    const result = applyPrototypeAuthSignIn(
      { a: 1 },
      undefined,
      { ok: true, userId: "u1" },
      context(),
    );
    expect(result.status).toBe("error");
    expect(result.data).toEqual({ a: 1 });
    expect(result.platform).toEqual({ signedIn: false });
    expect(JSON.stringify(result)).not.toContain("fake-tok-1");
  });
});

describe("sign-out, expiry and restore", () => {
  test("signOut clears the store and removes into", () => {
    const { store, context } = setup();
    const signedIn = applyPrototypeAuthSignIn(
      { k: 1 },
      undefined,
      { ok: true, userId: "u1" },
      context(),
    );
    const result = applyPrototypeAuthSignOut(signedIn.data, undefined, context());
    expect(result).toEqual({ status: "success", data: { k: 1 }, platform: { signedIn: false } });
    expect(store.session).toBeUndefined();
  });

  test("signOut without a session or into value still succeeds", () => {
    const { context } = setup();
    expect(applyPrototypeAuthSignOut({}, "/data/me", context())).toEqual({
      status: "success",
      data: {},
      platform: { signedIn: false },
    });
  });

  test("sessionExpired clears the store and leaves data to the handlers", () => {
    const { store, context } = setup();
    applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u2" }, context());
    expect(applyPrototypeAuthSessionExpired(context())).toEqual({ signedIn: false });
    expect(store.session).toBeUndefined();
  });

  test("a relaunch within the TTL stays signed in", () => {
    const { timer, context } = setup();
    applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u2" }, context());
    timer.advanceTime(59_999);
    expect(restorePrototypeAuthSession(context())).toEqual({
      platform: { signedIn: true, userId: "u2" },
      expired: false,
    });
    expect(prototypeAuthPlatformState(context())).toEqual({ signedIn: true, userId: "u2" });
  });

  test("a relaunch at the TTL clears the session and reports it expired", () => {
    const { store, timer, context } = setup();
    applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u2" }, context());
    timer.advanceTime(60_000);
    expect(prototypeAuthPlatformState(context())).toEqual({ signedIn: false });
    expect(restorePrototypeAuthSession(context())).toEqual({
      platform: { signedIn: false },
      expired: true,
    });
    expect(store.session).toBeUndefined();
  });

  test("a stored account the spec dropped is cleared without an expiry", () => {
    const { store, context } = setup();
    store.session = { token: "fake-old", userId: "gone", expiresAtMs: 9_000_000 };
    expect(restorePrototypeAuthSession(context())).toEqual({
      platform: { signedIn: false },
      expired: false,
    });
    expect(store.clearCount).toBe(1);
  });

  test("no stored session restores signed out without touching the store", () => {
    const { store, context } = setup();
    expect(restorePrototypeAuthSession(context())).toEqual({
      platform: { signedIn: false },
      expired: false,
    });
    expect(store.clearCount).toBe(0);
  });
});

describe("token redaction", () => {
  test("the token appears only in the store, never in a result, data or platform state", () => {
    const { store, timer, context } = setup();
    const results: unknown[] = [];
    const signIn = applyPrototypeAuthSignIn({}, undefined, { ok: true, userId: "u1" }, context());
    results.push(signIn, prototypeAuthPlatformState(context()));
    const token = store.session?.token;
    expect(token).toBe("fake-tok-1");
    timer.advanceTime(1000);
    results.push(restorePrototypeAuthSession(context()));
    results.push(applyPrototypeAuthSignOut(signIn.data, undefined, context()));
    expect(JSON.stringify(results)).not.toContain(token!);
  });
});
