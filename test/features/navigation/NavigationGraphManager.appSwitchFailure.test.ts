import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import type { Database } from "../../../src/db/types";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_A = "com.example.a";
const APP_B = "com.example.b";

/** Repository whose app-row insert can be made to reject once (a busy/locked shared DB). */
class FlakyAppInsertRepository extends NavigationRepository {
  appInsertCalls = 0;
  private failNext = false;

  constructor(db: Kysely<Database>) {
    super(db);
  }

  rejectNextAppInsert(): void {
    this.failNext = true;
  }

  override async getOrCreateApp(appId: string): ReturnType<NavigationRepository["getOrCreateApp"]> {
    this.appInsertCalls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("database is locked");
    }
    return super.getOrCreateApp(appId);
  }
}

describe("NavigationGraphManager app switch when the app-row insert rejects (#9992)", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: FlakyAppInsertRepository;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    repository = new FlakyAppInsertRepository(harness.db);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      new FakeTimer(),
    );
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function navigate(appId: string, destination: string): Promise<void> {
    return manager.recordNavigationEvent({
      applicationId: appId,
      destination,
      timestamp: 1_000,
      source: "sdk",
      arguments: {},
      metadata: {},
      sequenceNumber: 1,
    });
  }

  test("a rejected insert leaves currentAppId unchanged and the next event retries the switch", async () => {
    repository.rejectNextAppInsert();
    await expect(navigate(APP_A, "Home")).rejects.toThrow("database is locked");
    expect(manager.getCurrentAppId()).toBeNull();

    await navigate(APP_A, "Home");

    expect(manager.getCurrentAppId()).toBe(APP_A);
    expect(manager.getCurrentScreen()).toBe("Home");
    expect(repository.appInsertCalls).toBe(2);
  });

  test("a failed switch away from an app keeps the previous app and screen", async () => {
    await navigate(APP_A, "Home");

    repository.rejectNextAppInsert();
    await expect(navigate(APP_B, "Settings")).rejects.toThrow("database is locked");

    expect(manager.getCurrentAppId()).toBe(APP_A);
    expect(manager.getCurrentScreen()).toBe("Home");

    await navigate(APP_B, "Settings");
    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect(manager.getCurrentScreen()).toBe("Settings");
  });

  test("a successful switch still resets the screen and does not re-insert for the same app", async () => {
    await navigate(APP_A, "Home");
    await navigate(APP_A, "Detail");
    expect(repository.appInsertCalls).toBe(1);
    expect(manager.getCurrentScreen()).toBe("Detail");

    await manager.setCurrentApp(APP_B);
    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect(manager.getCurrentScreen()).toBeNull();
  });
});
