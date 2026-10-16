import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Collaborator ports of the device pool (and the binding fields they see are readonly) expose verbs (`withAssignmentLock`), never the mutex
// itself, so a collaborator cannot lock without going through the pool (#11804).
const DAEMON_DIR = path.resolve(import.meta.dir, "../../src/daemon");
const PORT_INTERFACE = /export interface \w*PoolPort\b[^{]*\{([\s\S]*?)\n\}/g;
const ANY_PORT_INTERFACE = /export interface \w*Port\b[^{]*\{([\s\S]*?)\n\}/g;

describe("device pool ports", () => {
  test("no *PoolPort interface mentions Mutex or returns the assignment mutex", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DAEMON_DIR).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(DAEMON_DIR, file), "utf8");
      for (const match of source.matchAll(PORT_INTERFACE)) {
        if (/\bMutex\b|getAssignmentMutex/.test(match[1] ?? "")) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no *Port interface hands out the live, mutable device map", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DAEMON_DIR).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join(DAEMON_DIR, file), "utf8");
      for (const match of source.matchAll(ANY_PORT_INTERFACE)) {
        if (/getDevices\(\): Map</.test(match[1] ?? "")) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
