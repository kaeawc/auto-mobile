import type { DaemonManagerLike } from "../../src/daemon/manager";
import type { DbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import type { McpTaskStore } from "../../src/db/mcpTaskRepository";
import type { InstalledAppsStore } from "../../src/db/installedAppsRepository";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import type { AwaitIdle } from "../../src/features/observe/interfaces/AwaitIdle";
import type { ObserveScreen } from "../../src/features/observe/interfaces/ObserveScreen";
import type { IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { FakeAdbClient } from "./FakeAdbClient";
import type { FakeAdbClientFactory } from "./FakeAdbClientFactory";
import type { FakeAdbExecutor } from "./FakeAdbExecutor";
import type { FakeAwaitIdle } from "./FakeAwaitIdle";
import type { FakeDaemonManager } from "./FakeDaemonManager";
import type { FakeDbWriteBarrier } from "./FakeDbWriteBarrier";
import type { FakeDeviceManager } from "./FakeDeviceManager";
import type { FakeDeviceSessionPersistence } from "./FakeDeviceSessionPersistence";
import type { FakeDeviceUtils } from "./FakeDeviceUtils";
import type { FakeGuestInputAdb } from "./FakeGuestInputAdb";
import type { FakeIdGenerator } from "./FakeIdGenerator";
import type { FakeInstalledAppsRepository } from "./FakeInstalledAppsRepository";
import type { FakeMcpTaskStore } from "./FakeMcpTaskStore";
import type { FakeObserveScreen } from "./FakeObserveScreen";
import type { FakeTimer } from "./FakeTimer";

type Assert<Condition extends true> = Condition;
type Conforms<Fake, Contract> = Fake extends Contract ? true : false;

/**
 * Compile-only guard (#11865 / #11868): the most-used shared fakes must stay
 * assignable to the production interface they stand in for, so a test never
 * needs an `as any` / `as unknown as` cast to pass one in. `bun run typecheck`
 * includes this file, which also type-checks each fake module it imports.
 */
export type SharedFakeConformanceChecks = [
  Assert<Conforms<FakeAdbExecutor, AdbExecutor>>,
  Assert<Conforms<FakeAdbClient, AdbExecutor>>,
  Assert<Conforms<FakeGuestInputAdb, AdbExecutor>>,
  Assert<Conforms<FakeAdbClientFactory, AdbClientFactory>>,
  Assert<Conforms<FakeObserveScreen, ObserveScreen>>,
  Assert<Conforms<FakeAwaitIdle, AwaitIdle>>,
  Assert<Conforms<FakeDeviceManager, PlatformDeviceManager>>,
  Assert<Conforms<FakeDeviceUtils, PlatformDeviceManager>>,
  Assert<Conforms<FakeDeviceSessionPersistence, DeviceSessionPersistence>>,
  Assert<Conforms<FakeInstalledAppsRepository, InstalledAppsStore>>,
  Assert<Conforms<FakeDaemonManager, DaemonManagerLike>>,
  Assert<Conforms<FakeDbWriteBarrier, DbWriteBarrier>>,
  Assert<Conforms<FakeIdGenerator, IdGenerator>>,
  Assert<Conforms<FakeMcpTaskStore, McpTaskStore>>,
  Assert<Conforms<FakeTimer, Timer>>,
];
