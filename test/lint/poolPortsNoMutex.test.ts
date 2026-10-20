import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { type TSInterfaceDeclaration } from "oxc-parser";
import { parseGuardSource, readGuardFile, GuardVisitor as Visitor } from "./astGuard";

// Collaborator ports of the device pool (and the binding fields they see are readonly) expose verbs (`withAssignmentLock`), never the mutex
// itself, so a collaborator cannot lock without going through the pool (#11804).
const DAEMON_DIR = path.resolve(import.meta.dir, "../../src/daemon");

interface PortShape {
  readonly name: string;
  readonly source: string;
  readonly members: readonly {
    readonly name: string;
    readonly text: string;
    /** Identifier name of the member's declared return/property type reference, e.g. `Map`. */
    readonly typeName: string;
  }[];
}

/** Every `interface *Port` declaration with its members' names and member source text. */
export function portInterfaces(file: string, source: string): PortShape[] {
  if (!source.includes("Port")) {
    return [];
  }
  const program = parseGuardSource(file, source);
  const found: PortShape[] = [];
  new Visitor({
    TSInterfaceDeclaration(node: TSInterfaceDeclaration) {
      if (!/Port$/.test(node.id.name)) {
        return;
      }
      found.push({
        name: node.id.name,
        source: source.slice(node.body.start, node.body.end),
        members: node.body.body.flatMap((member) => {
          const key = "key" in member && member.key.type === "Identifier" ? member.key.name : "";
          const annotation = "returnType" in member ? member.returnType : member.typeAnnotation;
          const type = annotation?.typeAnnotation;
          const typeName =
            type?.type === "TSTypeReference" && type.typeName.type === "Identifier"
              ? type.typeName.name
              : "";
          return [{ name: key, text: source.slice(member.start, member.end), typeName }];
        }),
      });
    },
  }).visit(program);
  return found;
}

export function poolPortMutexLeaks(file: string, source: string): string[] {
  return portInterfaces(file, source)
    .filter((port) => /PoolPort$/.test(port.name))
    .filter((port) => /\bMutex\b|getAssignmentMutex/.test(port.source))
    .map((port) => `${file}:${port.name}`);
}

export function liveDeviceMapLeaks(file: string, source: string): string[] {
  return portInterfaces(file, source)
    .filter((port) =>
      port.members.some((member) => member.name === "getDevices" && /:\s*Map</.test(member.text)),
    )
    .map((port) => `${file}:${port.name}`);
}

// These collaborators only read these collections, so the port must not hand out a mutable view.
const READ_ONLY_GETTERS: Readonly<Record<string, readonly string[]>> = {
  "adbServerResetQuarantine.ts": [
    "getStartedDeviceProcesses",
    "getRecoveringAndroidImages",
    "getRecoveringAndroidDeviceIds",
    "getRecoveringSessionLosses",
    "getFailedTerminalRecoveryReleases",
  ],
  "deviceShutdownReservations.ts": ["getIntentionalShutdowns"],
};

export function mutableReadOnlyGetters(
  file: string,
  source: string,
  names: readonly string[],
): string[] {
  return portInterfaces(file, source).flatMap((port) =>
    port.members
      .filter((member) => names.includes(member.name) && /^(Map|Set)$/.test(member.typeName))
      .map((member) => `${file}:${member.name}`),
  );
}

describe("device pool ports", () => {
  let sourceCount: number;
  let mutexLeaks: string[];
  let mapLeaks: string[];

  // Parsing is captured once, outside the per-test budget.
  beforeAll(() => {
    const sources = [
      ...readdirSync(DAEMON_DIR),
      ...readdirSync(path.join(DAEMON_DIR, "daemonRequestHandlersParts")).map((name) =>
        path.join("daemonRequestHandlersParts", name),
      ),
    ]
      .filter((name) => name.endsWith(".ts"))
      .map((name): [string, string] => [name, readGuardFile(path.join(DAEMON_DIR, name))]);
    sourceCount = sources.length;
    mutexLeaks = sources.flatMap(([file, source]) => poolPortMutexLeaks(file, source));
    mapLeaks = sources.flatMap(([file, source]) => liveDeviceMapLeaks(file, source));
  }, 30_000);

  test("no *PoolPort interface mentions Mutex or returns the assignment mutex", () => {
    expect(sourceCount).toBeGreaterThan(20);
    expect(mutexLeaks).toEqual([]);
  });

  test("no *Port interface hands out the live, mutable device map", () => {
    expect(mapLeaks).toEqual([]);
  });

  test("the guards fail on a violating port and ignore unrelated interfaces", () => {
    expect(
      poolPortMutexLeaks(
        "f.ts",
        "export interface FooPoolPort extends Base<X> { getAssignmentMutex(): Mutex }",
      ),
    ).toEqual(["f.ts:FooPoolPort"]);
    expect(
      poolPortMutexLeaks("f.ts", "export interface FooPoolPort { withAssignmentLock(): void }"),
    ).toEqual([]);
    expect(
      poolPortMutexLeaks("f.ts", "export interface Other { getAssignmentMutex(): Mutex }"),
    ).toEqual([]);
    expect(
      liveDeviceMapLeaks("f.ts", "export interface BarPort { getDevices(): Map<string, D> }"),
    ).toEqual(["f.ts:BarPort"]);
    expect(
      liveDeviceMapLeaks(
        "f.ts",
        "export interface BarPort { getDevices(): ReadonlyMap<string, D> }",
      ),
    ).toEqual([]);
  });

  test("read-only collaborator state getters return ReadonlyMap/ReadonlySet", () => {
    for (const [file, names] of Object.entries(READ_ONLY_GETTERS)) {
      const source = readGuardFile(path.join(DAEMON_DIR, file));
      expect(mutableReadOnlyGetters(file, source, names)).toEqual([]);
    }
  });

  test("the read-only getter guard fails on a mutable Map/Set getter", () => {
    const names = ["getA", "getB", "getC"];
    expect(
      mutableReadOnlyGetters(
        "f.ts",
        "export interface XPort { getA(): Map<string, D>; getB(): Set<string>; getC(): ReadonlyMap<string, D> }",
        names,
      ),
    ).toEqual(["f.ts:getA", "f.ts:getB"]);
  });
});
