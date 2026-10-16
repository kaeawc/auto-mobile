import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager, type SessionManagerOptions } from "../../src/daemon/sessionManager";
import {
  defaultBiometricEnrollmentRestorer,
  defaultKeepScreenAwakeRestorer,
  defaultNetworkConditionRestorer,
  defaultScreenReaderRestorer,
} from "../../src/daemon/sessionDefaultRestorers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

const managers: SessionManager[] = [];

function create(options?: SessionManagerOptions): SessionManager {
  const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), options);
  managers.push(manager);
  return manager;
}

function field<T>(manager: SessionManager, name: string): T {
  // The screen-reader restorer and backoff are owned by SessionDeviceStateRestore (#11795).
  const owner = name.startsWith("screenReader")
    ? (Reflect.get(manager, "stateRestore") as object)
    : manager;
  return Reflect.get(
    owner,
    name === "screenReaderRestorerFactory" ? "screenReaderRestorer" : name,
  ) as T;
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

describe("SessionManager options object (#11796)", () => {
  test("every collaborator defaults to the production wiring", () => {
    const manager = create();
    expect(field(manager, "keepScreenAwakeRestorerFactory")).toBe(defaultKeepScreenAwakeRestorer);
    expect(field(manager, "biometricEnrollmentRestorerFactory")).toBe(
      defaultBiometricEnrollmentRestorer,
    );
    expect(field(manager, "networkConditionRestorerFactory")).toBe(defaultNetworkConditionRestorer);
    expect(field(manager, "screenReaderRestorerFactory")).toBe(defaultScreenReaderRestorer);
  });

  test("an empty options object equals omitting it", () => {
    const bare = create();
    const empty = create({ restorers: {} });
    for (const name of [
      "keepScreenAwakeRestorerFactory",
      "biometricEnrollmentRestorerFactory",
      "networkConditionRestorerFactory",
      "screenReaderRestorerFactory",
      "screenReaderRestoreBackoff",
      "rotationRestoreBackoff",
    ]) {
      expect(field(empty, name)).toBe(field(bare, name));
    }
  });

  test("a partial restorers override replaces only the named restorer", () => {
    const networkCondition = () => ({ restore: async () => {} });
    const manager = create({ restorers: { networkCondition } });
    expect(field(manager, "networkConditionRestorerFactory")).toBe(networkCondition);
    expect(field(manager, "screenReaderRestorerFactory")).toBe(defaultScreenReaderRestorer);
    expect(field(manager, "keepScreenAwakeRestorerFactory")).toBe(defaultKeepScreenAwakeRestorer);
  });

  test("named options reach their collaborators", () => {
    const barrier = () => new FakeDbWriteBarrier();
    const keepScreenAwakeRestorer = () => ({
      restore: async () => ({ status: "restored" as const }),
    });
    const biometricEnrollmentRestorer = () => ({ restore: async () => {} });
    const screenReaderBackoff = { next: () => 1 } as never;
    const manager = create({
      barrier,
      keepScreenAwakeRestorer,
      biometricEnrollmentRestorer,
      restorers: { screenReaderBackoff },
    });
    expect(field(manager, "getBarrier")).toBe(barrier);
    expect(field(manager, "keepScreenAwakeRestorerFactory")).toBe(keepScreenAwakeRestorer);
    expect(field(manager, "biometricEnrollmentRestorerFactory")).toBe(biometricEnrollmentRestorer);
    expect(field(manager, "screenReaderRestoreBackoff")).toBe(screenReaderBackoff);
  });
});
