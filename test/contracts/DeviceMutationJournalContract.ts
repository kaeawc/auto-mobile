import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import type {
  DeviceBaseline,
  DeviceMutationInput,
  DeviceMutationJournal,
  DeviceMutationScope,
  MutationValue,
} from "../../src/daemon/sessionBroker/mutations/types";
import type { FakeTimer } from "../fakes/FakeTimer";

export interface DeviceMutationJournalHandle {
  journal: DeviceMutationJournal;
  timer: FakeTimer;
  dispose?: () => Promise<void> | void;
}

const SCOPE: DeviceMutationScope = {
  sessionUuid: "session-a",
  deviceId: "emulator-5554",
  incarnation: "generation-1",
};
const LOCALE: DeviceMutationInput = {
  kind: "device-setting",
  key: "locale",
  priorValue: { state: "present", value: "en-US" },
  toolName: "changeLocalization",
};
const BASELINE: DeviceBaseline = {
  completeKinds: ["device-setting"],
  observations: [{ kind: "device-setting", key: "locale", value: { state: "absent" } }],
  unobservable: ["keychain"],
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * Shared behavioural contract for {@link DeviceMutationJournal} (#11868): the in-memory fake the
 * broker reset tests use and the SQLite journal over an in-memory test database run the same
 * record/list/delete/baseline scenarios, so revert planning tested against the fake sees the
 * first-write-wins, ordering and identity rules the durable journal enforces.
 */
export function runDeviceMutationJournalContract(
  name: string,
  make: () => Promise<DeviceMutationJournalHandle>,
): void {
  const withJournal = async (
    body: (journal: DeviceMutationJournal, timer: FakeTimer) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.journal, handle.timer);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`DeviceMutationJournal contract: ${name}`, () => {
    test("a scope with no records lists nothing and has no baseline", () =>
      withJournal(async (journal) => {
        expect(await journal.list(SCOPE)).toEqual([]);
        expect(await journal.getBaseline(SCOPE)).toBeNull();
      }));

    test("strays include only other incarnations for the exact session and device in sequence order", () =>
      withJournal(async (journal) => {
        expect(await journal.listStrayIncarnations(SCOPE)).toEqual([]);
        for (const [index, scope] of [
          { ...SCOPE, incarnation: "legacy" },
          SCOPE,
          { ...SCOPE, sessionUuid: "other", incarnation: "legacy" },
          { ...SCOPE, deviceId: "other", incarnation: "legacy" },
          { ...SCOPE, incarnation: "replacement" },
        ].entries()) {
          await journal.record(scope, { ...LOCALE, key: `key-${index}` });
        }
        const entries = await journal.listStrayIncarnations(SCOPE);
        expect(entries.map((entry) => entry.key)).toEqual(["key-0", "key-4"]);
        expect(entries[0].sequence).toBeLessThan(entries[1].sequence);
        entries[0].key = "mutated-result";
        expect((await journal.listStrayIncarnations(SCOPE))[0].key).toBe("key-0");
      }));

    test("a recorded mutation lists exactly its journal fields, stamped with the clock", () =>
      withJournal(async (journal, timer) => {
        timer.setCurrentTime(42_000);
        await journal.record(SCOPE, LOCALE);
        const [entry, ...rest] = await journal.list(SCOPE);
        expect(rest).toEqual([]);
        expect(entry).toEqual({
          sequence: entry.sequence,
          kind: "device-setting",
          key: "locale",
          priorValue: { state: "present", value: "en-US" },
          toolName: "changeLocalization",
          appliedAt: 42_000,
        });
        expect(typeof entry.sequence).toBe("number");
      }));

    test("extra input properties are not stored or echoed back", () =>
      withJournal(async (journal) => {
        const withExtras = { ...LOCALE, note: "not a journal column", sequence: -1 };
        await journal.record(SCOPE, withExtras);
        const [entry] = await journal.list(SCOPE);
        expect(Object.keys(entry).sort()).toEqual(
          ["appliedAt", "key", "kind", "priorValue", "sequence", "toolName"].sort(),
        );
        expect(entry.sequence).not.toBe(-1);
      }));

    test("the first prior value wins and later keys append in record order", () =>
      withJournal(async (journal, timer) => {
        await journal.record(SCOPE, LOCALE);
        timer.advanceTime(10);
        await journal.record(SCOPE, { ...LOCALE, priorValue: { state: "present", value: "fr" } });
        await journal.record(SCOPE, {
          ...LOCALE,
          key: "nightMode",
          priorValue: { state: "absent" },
        });
        await journal.record(SCOPE, { ...LOCALE, kind: "permission" });
        const entries = await journal.list(SCOPE);
        expect(entries.map((entry) => [entry.kind, entry.key, entry.priorValue])).toEqual([
          ["device-setting", "locale", { state: "present", value: "en-US" }],
          ["device-setting", "nightMode", { state: "absent" }],
          ["permission", "locale", { state: "present", value: "en-US" }],
        ]);
        const sequences = entries.map((entry) => entry.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
        expect(new Set(sequences).size).toBe(3);
      }));

    test("session, device and incarnation each scope the journal independently", () =>
      withJournal(async (journal) => {
        const scopes: DeviceMutationScope[] = [
          SCOPE,
          { ...SCOPE, sessionUuid: "session-b" },
          { ...SCOPE, deviceId: "emulator-5556" },
          { ...SCOPE, incarnation: "generation-2" },
        ];
        for (const [index, scope] of scopes.entries()) {
          await journal.record(scope, {
            ...LOCALE,
            priorValue: { state: "present", value: `locale-${index}` },
          });
        }
        for (const [index, scope] of scopes.entries()) {
          expect((await journal.list(scope)).map((entry) => entry.priorValue)).toEqual([
            { state: "present", value: `locale-${index}` },
          ]);
        }
      }));

    test("deleteSession clears only its own scope", () =>
      withJournal(async (journal) => {
        const other = { ...SCOPE, sessionUuid: "session-b" };
        await journal.record(SCOPE, LOCALE);
        await journal.record(other, LOCALE);
        await journal.deleteSession(SCOPE);
        await journal.deleteSession(SCOPE);
        expect(await journal.list(SCOPE)).toEqual([]);
        expect(await journal.list(other)).toHaveLength(1);
        await journal.record(SCOPE, { ...LOCALE, priorValue: { state: "absent" } });
        expect((await journal.list(SCOPE))[0].priorValue).toEqual({ state: "absent" });
      }));

    test("listed entries and recorded inputs are not aliased to the stored rows", () =>
      withJournal(async (journal) => {
        const input: DeviceMutationInput = {
          ...LOCALE,
          priorValue: { state: "present", value: { languages: ["en"] } },
        };
        await journal.record(SCOPE, input);
        input.key = "mutated";
        const [listed] = await journal.list(SCOPE);
        listed.key = "also-mutated";
        expect((await journal.list(SCOPE)).map((entry) => [entry.key, entry.priorValue])).toEqual([
          ["locale", { state: "present", value: { languages: ["en"] } }],
        ]);
      }));

    test("an invalid prior value is rejected and nothing is recorded", () =>
      withJournal(async (journal) => {
        const invalid: MutationValue = JSON.parse('{"state":"maybe"}');
        expect(
          await rejection(journal.record(SCOPE, { ...LOCALE, priorValue: invalid })),
        ).toBeInstanceOf(Error);
        expect(await journal.list(SCOPE)).toEqual([]);
      }));

    test("a blank identity part is refused by every operation", () =>
      withJournal(async (journal) => {
        const blanks: DeviceMutationScope[] = [
          { ...SCOPE, sessionUuid: " " },
          { ...SCOPE, deviceId: "" },
          { ...SCOPE, incarnation: "\t" },
        ];
        for (const scope of blanks) {
          expect(await rejection(journal.record(scope, LOCALE))).toBeInstanceOf(ActionableError);
          expect(await rejection(journal.list(scope))).toBeInstanceOf(ActionableError);
          expect(await rejection(journal.deleteSession(scope))).toBeInstanceOf(ActionableError);
        }
        const blankDevice = { deviceId: " ", incarnation: "generation-1" };
        expect(await rejection(journal.captureBaseline(blankDevice, BASELINE))).toBeInstanceOf(
          ActionableError,
        );
        expect(await rejection(journal.getBaseline(blankDevice))).toBeInstanceOf(ActionableError);
      }));

    test("the first baseline per device incarnation wins, whatever the session", () =>
      withJournal(async (journal) => {
        // Session scopes are valid device scopes; the session part must not key the baseline.
        const sessionB: DeviceMutationScope = { ...SCOPE, sessionUuid: "session-b" };
        const sessionC: DeviceMutationScope = { ...SCOPE, sessionUuid: "session-c" };
        await journal.captureBaseline(SCOPE, BASELINE);
        await journal.captureBaseline(sessionB, { ...BASELINE, unobservable: [] });
        expect(await journal.getBaseline(sessionC)).toEqual(BASELINE);
        expect(await journal.getBaseline({ ...SCOPE, incarnation: "generation-2" })).toBeNull();
        const read = await journal.getBaseline(SCOPE);
        read?.unobservable.push("mutated");
        expect(await journal.getBaseline(SCOPE)).toEqual(BASELINE);
      }));

    test("deleteResource removes rows and baselines of that resource across sessions and devices", () =>
      withJournal(async (journal) => {
        const resource = "binding-1";
        const doomed: DeviceMutationScope[] = [
          { ...SCOPE, incarnation: resource },
          { sessionUuid: "session-b", deviceId: "emulator-5556", incarnation: resource },
          { ...SCOPE, incarnation: JSON.stringify([resource, "generation-7"]) },
        ];
        const kept: DeviceMutationScope[] = [
          { ...SCOPE, incarnation: `${resource}-2` },
          { ...SCOPE, incarnation: JSON.stringify(["other", resource]) },
          { ...SCOPE, incarnation: "generation-1" },
        ];
        for (const scope of [...doomed, ...kept]) {
          await journal.record(scope, LOCALE);
          await journal.captureBaseline(scope, BASELINE);
        }
        await journal.deleteResource(resource);
        for (const scope of doomed) {
          expect(await journal.list(scope)).toEqual([]);
          expect(await journal.getBaseline(scope)).toBeNull();
        }
        for (const scope of kept) {
          expect(await journal.list(scope)).toHaveLength(1);
          expect(await journal.getBaseline(scope)).toEqual(BASELINE);
        }
      }));

    test("deleteResource is idempotent and skips an unparsable array-looking incarnation", () =>
      withJournal(async (journal) => {
        const malformed: DeviceMutationScope = { ...SCOPE, incarnation: "[not json" };
        await journal.record(malformed, LOCALE);
        await journal.deleteResource("binding-1");
        await journal.deleteResource("binding-1");
        expect(await journal.list(malformed)).toHaveLength(1);
      }));

    test("deleteResource refuses a blank resource id and deletes nothing", () =>
      withJournal(async (journal) => {
        await journal.record(SCOPE, LOCALE);
        expect(await rejection(journal.deleteResource("  "))).toBeInstanceOf(ActionableError);
        expect(await journal.list(SCOPE)).toHaveLength(1);
      }));

    test("an invalid baseline is rejected and none is stored", () =>
      withJournal(async (journal) => {
        expect(
          await rejection(journal.captureBaseline(SCOPE, { ...BASELINE, completeKinds: [""] })),
        ).toBeInstanceOf(Error);
        expect(await journal.getBaseline(SCOPE)).toBeNull();
      }));
  });
}
