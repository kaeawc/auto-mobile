import { expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import {
  FileIosCameraPosterActivationStore,
  type ActivationFileSystem,
} from "../../../../src/features/utility/ios/IosCameraPosterActivationStore";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const directory = resolve("/data/ios-camera-poster-active");
const udid = "A1B2C3D4-0000-4000-8000-000000000001";

class FakeActivationFileSystem implements ActivationFileSystem {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  mkdirSync(path: string): void {
    this.calls.push(`mkdir ${path}`);
  }
  readFileSync(path: string): string {
    return this.files.get(path)!;
  }
  writeFileSync(path: string, data: string): void {
    this.files.set(path, data);
  }
  renameSync(from: string, to: string): void {
    this.calls.push(`rename ${from} -> ${to}`);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  rmSync(path: string): void {
    this.files.delete(path);
  }
  readdirSync(path: string): string[] {
    return [...this.files.keys()]
      .filter((file) => file.startsWith(`${path}${sep}`))
      .map((file) => file.slice(path.length + 1));
  }
  copyFileSync(from: string, to: string): void {
    this.calls.push(`copy ${from} -> ${to}`);
    this.files.set(to, `copy of ${from}`);
  }
  existsSync(path: string): boolean {
    return (
      this.files.has(path) || [...this.files.keys()].some((f) => f.startsWith(`${path}${sep}`))
    );
  }
}

function setup() {
  const fs = new FakeActivationFileSystem();
  const store = new FileIosCameraPosterActivationStore(() => directory, fs, new FakeIdGenerator());
  return { fs, store };
}

test("the gate is copied atomically to one stable path outside the build cache", () => {
  const { fs, store } = setup();
  const built = "/data/ios-camera-poster/abc-sim-universal/libAMCameraPosterGate.dylib";
  const stable = join(directory, "libAMCameraPosterGate.dylib");
  expect(store.installGate(built)).toBe(stable);
  expect(fs.calls).toEqual([
    `mkdir ${directory}`,
    `copy ${built} -> ${stable}.fake-1.tmp`,
    `rename ${stable}.fake-1.tmp -> ${stable}`,
  ]);
  expect(fs.files.get(stable)).toBe(`copy of ${built}`);
});

test("activations round-trip per simulator and list by udid", () => {
  const { store } = setup();
  expect(store.list()).toEqual([]);
  store.write(udid, { gate: "/g.dylib", launchctlBefore: "/a.dylib" });
  expect(store.read(udid)).toEqual({ gate: "/g.dylib", launchctlBefore: "/a.dylib" });
  expect(store.list()).toEqual([udid]);
  store.remove(udid);
  expect(store.read(udid)).toBeUndefined();
  expect(store.list()).toEqual([]);
});

test("a malformed record reads as no activation", () => {
  const { fs, store } = setup();
  fs.files.set(join(directory, "devices", `${udid}.json`), JSON.stringify({ gate: 1 }));
  expect(store.read(udid)).toBeUndefined();
});
