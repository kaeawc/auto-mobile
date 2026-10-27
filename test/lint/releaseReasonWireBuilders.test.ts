import { readGuardFile } from "./astGuard";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  EXEMPT_RELEASE_REASON_HOLDERS,
  RELEASE_REASON_WIRE_BUILDERS,
  scanReleaseReasonSerialisations,
} from "./releaseReasonWireBuilders";

const root = join(import.meta.dir, "..", "..");
const builderFiles = new Set(RELEASE_REASON_WIRE_BUILDERS.map((owner) => owner.split("#")[0]));
// Parse each src file exactly once, outside timed test bodies; all rules share this inventory.
const inventory = Object.freeze(
  readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const relative = `src/${file.split(sep).join("/")}`;
      return scanReleaseReasonSerialisations(relative, readGuardFile(join(root, relative)), {
        hostsWireBuilder: builderFiles.has(relative),
      });
    }),
);
const ownerKey = (finding: (typeof inventory)[number]): string =>
  `${finding.file}#${finding.owner}`;
const builderSet = new Set(RELEASE_REASON_WIRE_BUILDERS);
const exemptionSet = new Set(EXEMPT_RELEASE_REASON_HOLDERS.map(([owner]) => owner));

test("every release-reason serialization and idleReleaseField call has a classified owner", () => {
  const unlisted = inventory.filter(
    (finding) =>
      !builderSet.has(ownerKey(finding)) &&
      !exemptionSet.has(ownerKey(finding)) &&
      !exemptionSet.has(finding.file),
  );
  expect(
    unlisted.map((finding) => `${ownerKey(finding)}:${finding.line} (${finding.key})`),
    "Unlisted release-reason serialization: add a guarded wire builder and surface row, or a specific exemption",
  ).toEqual([]);
});

test("every builder reason is immediately followed by idleReleaseField in its object", () => {
  const unguarded = inventory.filter(
    (finding) => builderSet.has(ownerKey(finding)) && !finding.guarded,
  );
  expect(
    unguarded.map((finding) => `${ownerKey(finding)}:${finding.line} (${finding.key})`),
    "Unguarded wire reason: spread ...idleReleaseField(reason) immediately after the reason property",
  ).toEqual([]);
});

test("builder and exemption inventories contain no stale or duplicate entries", () => {
  const owners = new Set(inventory.map(ownerKey));
  const files = new Set(inventory.map((finding) => finding.file));
  const stale = [
    ...RELEASE_REASON_WIRE_BUILDERS.filter((owner) => !owners.has(owner)),
    ...EXEMPT_RELEASE_REASON_HOLDERS.map(([owner]) => owner).filter(
      (owner) => !owners.has(owner) && !files.has(owner),
    ),
  ];
  expect(
    stale,
    "Listed owner has no release-reason serialisation left. If a builder stopped spreading idleReleaseField beside its reason, restore the spread; if the producer is gone, remove the entry (and its surface row)",
  ).toEqual([]);
  expect(builderSet.size).toBe(RELEASE_REASON_WIRE_BUILDERS.length);
  expect(exemptionSet.size).toBe(EXEMPT_RELEASE_REASON_HOLDERS.length);
  expect(RELEASE_REASON_WIRE_BUILDERS.filter((owner) => exemptionSet.has(owner))).toEqual([]);
  expect(EXEMPT_RELEASE_REASON_HOLDERS.filter(([, reason]) => reason.trim().length === 0)).toEqual(
    [],
  );
});

test.each([
  ["reason: x.releaseReason", false],
  ["reason: x.releaseReason, ...idleReleaseField(x.releaseReason)", true],
  ["releaseReason", false],
  ["reason: (x.release_reason as string)! ?? 'fallback'", false],
  ["reason: (x.terminalReleaseReason satisfies string) || 'fallback'", false],
  ["reason: ok ? 'fallback' : x.releaseReason", false],
  ["reason: releaseReasonFromError(error)", false],
  ["reason: 'cleanup-expired', idle: true", false],
  ["'releaseReason': 'explicit-release'", false],
  ["...(ok ? { reason: x.releaseReason } : {}), ...idleReleaseField(x.releaseReason)", true],
  ["...(ok ? {} : { reason: x.releaseReason }), ...idleReleaseField(x.releaseReason)", true],
  ["reason: x.releaseReason, other: true, ...idleReleaseField(x.releaseReason)", false],
])("scanner recognizes reason elements and adjacency: %s", (properties, guarded) => {
  const findings = scanReleaseReasonSerialisations(
    "fixture.ts",
    `function build() { return { ${properties} }; }`,
  );
  expect(findings.filter((finding) => finding.key !== "idleReleaseField")).toEqual([
    expect.objectContaining({ file: "fixture.ts", line: 1, owner: "build", guarded }),
  ]);
});

test.each([
  "const value = { reason: errorMessage(error) };",
  "const schema = z.object({ reason: z.string(), releaseReason: z.string().optional() });",
  "const value = { reason: x['releaseReason'] };",
  "// const value = { releaseReason };",
])("scanner ignores unrelated reasons and schemas: %s", (source) => {
  expect(scanReleaseReasonSerialisations("fixture.ts", source)).toEqual([]);
});

test.each([
  ['code: "x", reason: error.reason', true, false],
  ["sessionUuid, reason", true, false],
  ["sessionId, reason", true, false],
  ["nextAction, reason", true, false],
  ['code: "x", reason: "literal"', false, false],
  ['code: "x", reason: `template ${reason}`', false, false],
  ['code: "x", reason: z.string()', false, false],
  ["sessionUuid: { reason }", false, false],
  ['code: "x", reason, ...idleReleaseField(reason)', true, true],
])("scanner recognizes hosting-file wire shapes: %s", (properties, detected, guarded) => {
  const findings = scanReleaseReasonSerialisations(
    "fixture.ts",
    `function build() { return { ${properties} }; }`,
    { hostsWireBuilder: true },
  ).filter((finding) => finding.key !== "idleReleaseField");
  expect(findings).toEqual(
    detected ? [{ file: "fixture.ts", line: 1, owner: "build", key: "reason", guarded }] : [],
  );
});

test("scanner does not widen wire shapes outside builder-hosting files by default", () => {
  const source = 'function build() { return { code: "x", reason: error.reason }; }';
  expect(scanReleaseReasonSerialisations("fixture.ts", source)).toEqual([]);
  expect(
    scanReleaseReasonSerialisations("fixture.ts", source, { hostsWireBuilder: false }),
  ).toEqual([]);
});

test("scanner follows releaseReasons imports, including aliases", () => {
  const findings = scanReleaseReasonSerialisations(
    "fixture.ts",
    `
    import { IDLE_WINDOW_RELEASE_REASON as idleEnd } from './releaseReasons.ts';
    const build = () => ({ reason: idleEnd });
  `,
  );
  expect(findings).toEqual([
    { file: "fixture.ts", line: 3, owner: "build", key: "reason", guarded: false },
  ]);
});

test("scanner records calls and the nearest named owners through anonymous callbacks", () => {
  const findings = scanReleaseReasonSerialisations(
    "fixture.ts",
    `
    const top = { releaseReason };
    function outer() {
      const inner = () => [1].map(() => ({ releaseReason }));
      return { releaseReason };
    }
    class Wire {
      constructor() { const x = { releaseReason }; }
      send() { function nested() { return { releaseReason }; } idleReleaseField(reason); }
    }
    const object = { send() { return { releaseReason }; } };
  `,
  );
  expect(findings.map(({ owner, key }) => [owner, key])).toEqual([
    ["<module>", "releaseReason"],
    ["inner", "releaseReason"],
    ["outer", "releaseReason"],
    ["Wire.constructor", "releaseReason"],
    ["nested", "releaseReason"],
    ["Wire.send", "idleReleaseField"],
    ["send", "releaseReason"],
  ]);
});

test("scanner rejects invalid syntax instead of dropping source from coverage", () => {
  expect(() => scanReleaseReasonSerialisations("fixture.ts", "function broken( {")).toThrow(
    "fixture.ts:",
  );
});
