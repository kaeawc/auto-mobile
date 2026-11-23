import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DeviceConfigMirroringIosCameraPosterRegistry } from "../../../../src/features/utility/ios/DeviceConfigMirroringIosCameraPosterRegistry";
import {
  IosCameraPosterDeviceConfig,
  type PosterConfigFileSystem,
} from "../../../../src/features/utility/ios/IosCameraPosterDeviceConfig";
import { FakeIosCameraPosterRegistry } from "../../../fakes/FakeIosCameraPoster";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";

const directory = resolve("/data/ios-camera-poster/devices");
const udid = "A1B2C3D4-0000-4000-8000-000000000001";
const target = join(directory, `${udid}.json`);

class FakeConfigFileSystem implements PosterConfigFileSystem {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  failWrites = false;
  mkdirSync(path: string): void {
    this.calls.push(`mkdir ${path}`);
  }
  writeFileSync(path: string, data: string): void {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.calls.push(`write ${path}`);
    this.files.set(path, data);
  }
  renameSync(from: string, to: string): void {
    this.calls.push(`rename ${from} -> ${to}`);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  rmSync(path: string, options: { force: true; recursive?: boolean }): void {
    this.calls.push(`rm${options.recursive ? " -r" : ""} ${path}`);
    for (const file of [...this.files.keys()]) {
      if (file === path || (options.recursive && file.startsWith(`${path}/`))) {
        this.files.delete(file);
      }
    }
  }
}

function setup() {
  const fs = new FakeConfigFileSystem();
  const config = new IosCameraPosterDeviceConfig(() => directory, fs, new FakeIdGenerator());
  return { fs, config };
}

test("an image poster is written atomically as its host path", () => {
  const { fs, config } = setup();
  config.write(udid, { kind: "image", path: "/posters/receipt.png" });
  expect(fs.calls).toEqual([
    `mkdir ${directory}`,
    `write ${target}.fake-1.tmp`,
    `rename ${target}.fake-1.tmp -> ${target}`,
  ]);
  expect(JSON.parse(fs.files.get(target)!)).toEqual({ path: "/posters/receipt.png" });
});

test("a QR poster is written as its text, not the host preview PNG", () => {
  const { fs, config } = setup();
  config.write(udid, { kind: "qr", text: "WIFI:S:lab;;", path: "/previews/qr.png" });
  expect(JSON.parse(fs.files.get(target)!)).toEqual({ qr: "WIFI:S:lab;;" });
});

test("removeAll drops every device file a previous daemon left", () => {
  const { fs, config } = setup();
  config.write(udid, { kind: "image", path: "/p.png" });
  config.removeAll();
  expect(fs.files.size).toBe(0);
  expect(fs.calls.at(-1)).toBe(`rm -r ${directory}`);
});

test("the mirroring registry writes on set and removes on clear", () => {
  const { fs, config } = setup();
  const inner = new FakeIosCameraPosterRegistry();
  const registry = new DeviceConfigMirroringIosCameraPosterRegistry(inner, config);
  registry.set(udid, { kind: "image", path: "/p.png" });
  expect(registry.get(udid)).toEqual({ kind: "image", path: "/p.png" });
  expect(fs.files.has(target)).toBe(true);
  registry.clear(udid);
  expect(inner.posters.size).toBe(0);
  expect(fs.files.has(target)).toBe(false);
});

test("a config write failure still records the poster for per-launch injection", () => {
  const { fs, config } = setup();
  fs.failWrites = true;
  const registry = new DeviceConfigMirroringIosCameraPosterRegistry(
    new FakeIosCameraPosterRegistry(),
    config,
  );
  expect(() => registry.set(udid, { kind: "image", path: "/p.png" })).not.toThrow();
  expect(registry.get(udid)).toEqual({ kind: "image", path: "/p.png" });
});
