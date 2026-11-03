import { describe, expect, test } from "bun:test";
import {
  applyPrototypePermissions,
  DEFAULT_PROTOTYPE_PERMISSION_MODE,
  planPrototypePermissions,
  type PrototypePermissionBackend,
} from "../../../src/features/prototype/prototypePermissionGrants";
import type {
  PrototypePermissionName,
  PrototypePermissionState,
} from "../../../src/features/prototype/prototypePermissionMap";

/** Records each call and keeps per-name state the way the device would. */
class FakePermissionBackend implements PrototypePermissionBackend {
  readonly calls: string[] = [];
  private readonly states = new Map<PrototypePermissionName, PrototypePermissionState>();

  constructor(
    readonly target: PrototypePermissionBackend["target"],
    private readonly failOn?: string,
  ) {}

  async grant(name: PrototypePermissionName): Promise<void> {
    this.record(`grant ${name}`);
    this.states.set(name, "granted");
  }

  async deny(name: PrototypePermissionName): Promise<void> {
    this.record(`deny ${name}`);
    this.states.set(name, this.target === "android" ? "blocked" : "denied");
  }

  async read(name: PrototypePermissionName): Promise<PrototypePermissionState> {
    return this.states.get(name) ?? "notDetermined";
  }

  preset(name: PrototypePermissionName, state: PrototypePermissionState): void {
    this.states.set(name, state);
  }

  private record(call: string): void {
    if (call === this.failOn) {
      throw new Error(`device refused ${call}`);
    }
    this.calls.push(call);
  }
}

const declared: PrototypePermissionName[] = ["camera", "location", "notifications"];

describe("prototype permission plan", () => {
  test("interactive shows prompt by default", () => {
    expect(DEFAULT_PROTOTYPE_PERMISSION_MODE).toBe("prompt");
  });

  test("grant and deny lists must name declared permissions, once each", () => {
    expect(() => planPrototypePermissions(declared, { grant: ["contacts"] })).toThrow(
      "Permission contacts is not declared in requires.permissions",
    );
    expect(() =>
      planPrototypePermissions(declared, { grant: ["camera"], deny: ["camera"] }),
    ).toThrow("Permission camera is in both grant and deny");
  });
});

describe("prototype permission grants on Android", () => {
  test("prompt touches nothing and verifies each permission is still undetermined", async () => {
    const backend = new FakePermissionBackend("android");
    backend.preset("location", "granted");
    const results = await applyPrototypePermissions(declared, "prompt", backend);
    expect(backend.calls).toEqual([]);
    expect(results).toEqual([
      { name: "camera", state: "notDetermined", verified: true },
      { name: "location", state: "granted", verified: false },
      { name: "notifications", state: "notDetermined", verified: true },
    ]);
  });

  test("grantDeclared grants every declared permission in order", async () => {
    const backend = new FakePermissionBackend("android");
    const results = await applyPrototypePermissions(declared, "grantDeclared", backend);
    expect(backend.calls).toEqual(["grant camera", "grant location", "grant notifications"]);
    expect(results.every((result) => result.state === "granted" && result.verified)).toBe(true);
  });

  test("a denial reads blocked, so no dialog appears", async () => {
    const backend = new FakePermissionBackend("android");
    const results = await applyPrototypePermissions(
      declared,
      { grant: ["camera"], deny: ["location"] },
      backend,
    );
    expect(backend.calls).toEqual(["grant camera", "deny location"]);
    expect(results).toEqual([
      { name: "camera", state: "granted", verified: true },
      { name: "location", state: "blocked", verified: true },
      { name: "notifications", state: "notDetermined", verified: true },
    ]);
  });

  test("photosAdd has no runtime permission: grant is a no-op and deny is not revocable", async () => {
    const backend = new FakePermissionBackend("android");
    backend.preset("photosAdd", "granted");
    expect(await applyPrototypePermissions(["photosAdd"], "grantDeclared", backend)).toEqual([
      { name: "photosAdd", state: "granted", verified: true },
    ]);
    expect(
      await applyPrototypePermissions(["photosAdd"], { deny: ["photosAdd"] }, backend),
    ).toEqual([{ name: "photosAdd", state: "granted", verified: false, reason: "notRevocable" }]);
    expect(backend.calls).toEqual([]);
  });

  test("a backend failure stops the run instead of launching half-applied", async () => {
    const backend = new FakePermissionBackend("android", "grant location");
    await expect(applyPrototypePermissions(declared, "grantDeclared", backend)).rejects.toThrow(
      "device refused grant location",
    );
    expect(backend.calls).toEqual(["grant camera"]);
  });
});

describe("prototype permission grants on an iOS simulator", () => {
  test("a denial reads denied after simctl privacy revoke", async () => {
    const backend = new FakePermissionBackend("iosSimulator");
    const results = await applyPrototypePermissions(declared, { deny: ["camera"] }, backend);
    expect(backend.calls).toEqual(["deny camera"]);
    expect(results[0]).toEqual({ name: "camera", state: "denied", verified: true });
  });

  test("notifications are reported notGrantableOnSimulator and never sent to simctl", async () => {
    const backend = new FakePermissionBackend("iosSimulator");
    const results = await applyPrototypePermissions(declared, "grantDeclared", backend);
    expect(backend.calls).toEqual(["grant camera", "grant location"]);
    expect(results[2]).toEqual({
      name: "notifications",
      state: "notDetermined",
      verified: false,
      reason: "notGrantableOnSimulator",
    });
  });
});
