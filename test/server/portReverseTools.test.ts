import { describe, expect, test } from "bun:test";
import { PortReverseManager } from "../../src/features/portReverse/PortReverseManager";
import type { BootedDevice } from "../../src/models";
import {
  createPortReverseHandler,
  subscribePortReverseCleanup,
  type PortReverseLifecycle,
} from "../../src/server/portReverseTools";
import { portReverseResultSchema } from "../../src/server/portReverseToolOutputSchemas";
import { FakeHostLoopbackProbe } from "../fakes/FakeHostLoopbackProbe";
import { FakeTimer } from "../fakes/FakeTimer";

const android: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
const ios: BootedDevice = { deviceId: "SIM-1", platform: "ios", name: "iPhone" };

/** An executor that answers `adb reverse` like a device holding `mappings`. */
function fakeExecutor(mappings: Map<number, number>) {
  return {
    commands: [] as string[],
    async executeCommand(command: string) {
      this.commands.push(command);
      const add = /^reverse (?:--no-rebind )?tcp:(\d+) tcp:(\d+)$/.exec(command);
      if (add) {
        mappings.set(Number(add[1]), Number(add[2]));
      }
      const remove = /^reverse --remove tcp:(\d+)$/.exec(command);
      if (remove) {
        mappings.delete(Number(remove[1]));
      }
      const stdout =
        command === "reverse --list"
          ? [...mappings].map(([d, h]) => `host-19 tcp:${d} tcp:${h}`).join("\n")
          : "";
      return { stdout, stderr: "" } as never;
    },
  };
}

const structured = (response: unknown) =>
  portReverseResultSchema.parse((response as { structuredContent: unknown }).structuredContent);

const setup = (sessionUuid?: string) => {
  const mappings = new Map<number, number>();
  const executor = fakeExecutor(mappings);
  const manager = new PortReverseManager(
    () => undefined,
    new FakeTimer(),
    new FakeHostLoopbackProbe(),
  );
  const handler = createPortReverseHandler({
    manager,
    policy: {},
    adbFactory: { create: () => executor },
    sessionUuid: () => sessionUuid,
  });
  return { mappings, executor, manager, handler };
};

describe("portReverse tool", () => {
  test("ensure defaults hostPort to devicePort and owns the mapping for the session", async () => {
    const { mappings, manager, handler } = setup("session-a");
    const result = structured(
      await handler(android, { action: "ensure", ports: [{ devicePort: 8080 }] }),
    );
    expect(result).toMatchObject({ success: true, status: "ok", action: "ensure" });
    expect(result.mappings).toEqual([
      { devicePort: 8080, host: "tcp:8080", hostPort: 8080, owned: true, status: "added" },
    ]);
    expect([...mappings]).toEqual([[8080, 8080]]);
    await manager.releaseOwner("session-a");
    expect(mappings.size).toBe(0);
  });

  test("a privileged port is refused with a typed error and no adb call", async () => {
    const { executor, handler } = setup();
    const response = await handler(android, { action: "ensure", ports: [{ devicePort: 80 }] });
    expect(response).toMatchObject({ isError: true });
    expect(structured(response)).toMatchObject({
      success: false,
      status: "failed",
      errorCode: "port_reverse_port_refused",
      ports: [80],
    });
    expect(executor.commands).toEqual([]);
  });

  test("remove of a mapping the session did not create is refused", async () => {
    const { mappings, handler } = setup("session-a");
    mappings.set(3000, 3000);
    const response = await handler(android, { action: "remove", ports: [{ devicePort: 3000 }] });
    expect(structured(response).errorCode).toBe("port_reverse_not_owned");
    expect(mappings.get(3000)).toBe(3000);
  });

  test("an explicit sessionUuid argument is the owner", async () => {
    const { manager, mappings, handler } = setup("routed");
    await handler(android, {
      action: "ensure",
      ports: [{ devicePort: 8080 }],
      sessionUuid: "explicit",
    });
    await manager.releaseOwner("routed");
    expect(mappings.size).toBe(1);
    await manager.releaseOwner("explicit");
    expect(mappings.size).toBe(0);
  });

  test("iOS is not_applicable without touching adb", async () => {
    const { executor, handler } = setup();
    const result = structured(await handler(ios, { action: "list" }));
    expect(result).toMatchObject({ success: true, status: "not_applicable" });
    expect(executor.commands).toEqual([]);
  });

  test("device removal forgets only sessionless ownership and sends no command", async () => {
    const { mappings, executor, manager, handler } = setup("session-a");
    await handler(android, { action: "ensure", ports: [{ devicePort: 8080 }] });
    const sessionless = createPortReverseHandler({
      manager,
      policy: {},
      adbFactory: { create: () => executor },
      sessionUuid: () => undefined,
    });
    await sessionless(android, { action: "ensure", ports: [{ devicePort: 9090 }] });
    let onRemoval: (deviceId: string) => void = () => undefined;
    const lifecycle: PortReverseLifecycle = {
      subscribeDeviceRemoval: (listener) => {
        onRemoval = listener;
        return () => undefined;
      },
    };
    subscribePortReverseCleanup(lifecycle, manager);
    executor.commands.length = 0;
    onRemoval("emulator-5554");
    // Queued behind the removal on the same device, so it observes its result.
    await handler(android, { action: "list" });
    // The session's 8080 survives (recovery keeps the session bound); sessionless 9090 is no
    // longer owned, and the removal itself sent no command (the serial may name a new device).
    expect(manager.ownedPorts("emulator-5554")).toEqual([8080]);
    expect(executor.commands).not.toContain("reverse --remove tcp:9090");
    expect(mappings.has(9090)).toBe(true);
  });

  test("an aborted call creates no mapping", async () => {
    const { mappings, handler } = setup("session-a");
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler(
        android,
        { action: "ensure", ports: [{ devicePort: 8080 }] },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(mappings.size).toBe(0);
  });

  test("ensure reclaimStale reclaims for a session and refuses a sessionless caller", async () => {
    const sessionless = setup();
    sessionless.mappings.set(3000, 4000);
    const refused = structured(
      await sessionless.handler(android, {
        action: "ensure",
        ports: [{ devicePort: 3000 }],
        reclaimStale: true,
      }),
    );
    expect(refused).toMatchObject({
      errorCode: "port_reverse_conflict",
      conflictKind: "external_unknown",
      conflicts: [{ devicePort: 3000, conflictKind: "external_unknown" }],
    });
    expect(sessionless.mappings.get(3000)).toBe(4000);

    const held = setup("session-a");
    held.mappings.set(3000, 4000);
    const result = structured(
      await held.handler(android, {
        action: "ensure",
        ports: [{ devicePort: 3000 }],
        reclaimStale: true,
      }),
    );
    expect(result.mappings?.[0]).toMatchObject({
      status: "added",
      reclaimed: { host: "tcp:4000", reason: "host_refused" },
    });
    expect(held.mappings.get(3000)).toBe(3000);
  });
});
