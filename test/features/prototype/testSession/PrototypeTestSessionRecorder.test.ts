import { expect, test, spyOn } from "bun:test";
import { PrototypeTestSessionRecorder } from "../../../../src/features/prototype/testSession/PrototypeTestSessionRecorder";
import { PrototypeEventCoordinator } from "../../../../src/features/prototype/PrototypeEventCoordinator";
import { InMemoryPrototypeStatusStore } from "../../../../src/features/prototype/PrototypeStatusStore";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { logger } from "../../../../src/utils/logger";
import { FakePrototypeTestSessionStore } from "../../../fakes/FakePrototypeTestSessionStore";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { event } from "../../../helpers/prototypeTestEvent";

const scope = { deviceId: "device", sessionUuid: "one" };
function fixture() {
  const timer = new FakeTimer(),
    store = new FakePrototypeTestSessionStore();
  const recorder = new PrototypeTestSessionRecorder({
    store,
    timer,
    ids: new CountingIdGenerator(),
    secureKeys: () => new Set(["password"]),
    startScreen: () => "(root)",
    deadTapsEnabled: () => false,
  });
  const client = new FakeCtrlProxy(timer);
  const events = new PrototypeEventCoordinator(timer, new InMemoryPrototypeStatusStore(timer), {
    recorder,
  });
  events.show(scope, "panel", client);
  return { timer, store, recorder, client, events };
}
test("coordinator records accepted events once, in order; end flushes and returns report", async () => {
  const f = fixture();
  try {
    const begin = await f.recorder.begin(scope, "panel", { cohort: "new" });
    expect(begin.deadTaps).toBe("off");
    expect(begin.warning).toContain("window.deadTaps: true");
    f.client.emitPrototypeEvent(event(2));
    f.client.emitPrototypeEvent(event(2));
    f.client.emitPrototypeEvent(event(1));
    f.client.emitPrototypeEvent(event(3));
    const end = await f.recorder.end(scope, "panel");
    expect(
      (await f.store.listEvents(begin.session.test_session_id)).map((e) => e.event_sequence),
    ).toEqual([2, 3]);
    expect(end.report.eventCount).toBe(2);
    expect(end.report.status).toBe("ended");
    expect(end.markdown).toContain("No text values are recorded");
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});
test("one active session per device/id, including other routing sessions; latest reports enforce scope", async () => {
  const f = fixture();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const begun = await f.recorder.begin(scope, "panel");
    await expect(f.recorder.begin({ ...scope, sessionUuid: "other" }, "panel")).rejects.toThrow(
      "already active",
    );
    await expect(
      f.recorder.report({ ...scope, sessionUuid: "other" }, { id: "panel" }),
    ).rejects.toThrow("No stored");
    expect(
      (
        await f.recorder.report(
          { deviceId: "other", sessionUuid: "other" },
          { testSessionId: begun.session.test_session_id },
        )
      ).session.test_session_id,
    ).toBe(begun.session.test_session_id);
    const report = await f.recorder.report(scope, { id: "panel" });
    expect(report.session.status).toBe("active");
  } finally {
    f.events.dispose();
    await f.recorder.flush();
    warn.mockRestore();
  }
});
test("begin ends an active row no recording in this daemon owns (left by a restart)", async () => {
  const f = fixture();
  try {
    const stale = await f.recorder.begin(scope, "panel");
    // A restarted daemon has the row but no in-memory recording.
    const restarted = new PrototypeTestSessionRecorder({
      store: f.store,
      timer: f.timer,
      ids: new CountingIdGenerator("fresh"),
      secureKeys: () => new Set(),
      startScreen: () => "(root)",
      deadTapsEnabled: () => false,
    });
    const next = await restarted.begin({ ...scope, sessionUuid: "two" }, "panel");
    expect(next.session.test_session_id).not.toBe(stale.session.test_session_id);
    const old = await f.store.findById(stale.session.test_session_id);
    expect([old?.status, old?.ended_reason]).toEqual(["ended", "released"]);
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});
test("device dismissal ends at host receive time, not the skewed device timestamp, and excludes subsequent events", async () => {
  const f = fixture();
  try {
    await f.recorder.begin(scope, "panel");
    f.timer.advanceTime(45);
    f.client.emitPrototypeEvent({ ...event(1, "panel", "dismissed"), timestamp: 999_999 });
    f.client.emitPrototypeEvent(event(2));
    const end = await f.recorder.report(scope, { id: "panel" });
    expect(end.report.endedReason).toBe("dismissed");
    expect(end.report.endedAt).toBe(45);
    expect(end.report.eventCount).toBe(1);
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});
test.each(["session", "device", "dismiss"] as const)(
  "%s lifecycle auto-ends recording",
  async (mode) => {
    const f = fixture();
    try {
      await f.recorder.begin(scope, "panel");
      if (mode === "session") {
        f.events.releaseSession("one");
      } else if (mode === "device") {
        f.events.releaseDevice("device");
      } else {
        f.events.dismiss("device", "panel");
      }
      const report = await f.recorder.report(scope, { id: "panel" });
      expect(report.report.endedReason).toBe(mode === "dismiss" ? "dismissed" : "released");
    } finally {
      f.events.dispose();
      await f.recorder.flush();
    }
  },
);
test("DB failure cannot break event delivery and serial queue recovers", async () => {
  const f = fixture();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await f.recorder.begin(scope, "panel");
    f.store.failure = new Error("disk full");
    expect(() => f.client.emitPrototypeEvent(event(1))).not.toThrow();
    await f.recorder.flush();
    expect(warn).toHaveBeenCalled();
    expect((await f.events.awaitEvent(scope, "panel", f.client, {})).event?.sequence).toBe(1);
    f.store.failure = undefined;
    f.client.emitPrototypeEvent(event(2));
    expect((await f.recorder.end(scope, "panel")).report.eventCount).toBe(1);
  } finally {
    f.store.failure = undefined;
    f.events.dispose();
    await f.recorder.flush();
    warn.mockRestore();
  }
});
test("unstarted recorder never touches a failing store", async () => {
  const f = fixture();
  f.store.failure = new Error("must remain lazy");
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    f.client.emitPrototypeEvent(event(1));
    f.events.dispose();
    await f.recorder.flush();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("release also ends a host-only recording without an event subscription", async () => {
  const f = fixture();
  try {
    await f.recorder.begin(scope, "not-shown");
    f.events.releaseSession("one");
    const report = await f.recorder.report(scope, { id: "not-shown" });
    expect(report.report.endedReason).toBe("released");
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});

test("queued events cannot cross an end/begin boundary into the next session", async () => {
  const f = fixture();
  try {
    await f.recorder.begin(scope, "panel");
    const ending = f.recorder.end(scope, "panel");
    const beginning = f.recorder.begin(scope, "panel");
    f.client.emitPrototypeEvent(event(1));
    await ending;
    const next = await beginning;
    await f.recorder.flush();
    expect(await f.store.listEvents(next.session.test_session_id)).toEqual([]);
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});

test("a failed append still permits dismissal to end the recording", async () => {
  const f = fixture();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const append = spyOn(f.store, "appendEvents").mockRejectedValue(new Error("write failed"));
  try {
    await f.recorder.begin(scope, "panel");
    f.client.emitPrototypeEvent(event(1, "panel", "dismissed"));
    const report = await f.recorder.report(scope, { id: "panel" });
    expect(report.report.endedReason).toBe("dismissed");
    expect(warn).toHaveBeenCalled();
  } finally {
    f.events.dispose();
    await f.recorder.flush();
    append.mockRestore();
    warn.mockRestore();
  }
});

test("events arriving while begin persists queue behind the session insert", async () => {
  const f = fixture();
  try {
    const beginning = f.recorder.begin(scope, "panel");
    f.client.emitPrototypeEvent(event(1));
    await beginning;
    expect((await f.recorder.end(scope, "panel")).report.eventCount).toBe(1);
  } finally {
    f.events.dispose();
    await f.recorder.flush();
  }
});
