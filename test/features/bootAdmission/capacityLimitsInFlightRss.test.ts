import { expect, test } from "bun:test";
import {
  estimateSettledPerDeviceBytes,
  type PerDeviceMemoryPolicy,
  resolveBootCapacityLimits,
  type EmulatorMemoryRow,
  type InFlightBootMemory,
} from "../../../src/features/bootAdmission/capacityLimits";

const GIB = 1024 ** 3;
// The matcher is policy-generic; a fixed policy keeps these cases independent of per-platform defaults.
const POLICY: PerDeviceMemoryPolicy = {
  defaultBytes: 3 * GIB,
  minBytes: 1.5 * GIB,
  maxBytes: 6 * GIB,
};
const settled = { pid: 100, rssBytes: 1.5 * GIB };
const boot = { processId: 200, handedOff: true };

test("a 6 GiB in-flight boot beside a settled 1.5 GiB device keeps the limit at two", () => {
  const bytes = estimateSettledPerDeviceBytes(
    [settled, { pid: 200, rssBytes: 6 * GIB }],
    [boot],
    POLICY,
  );
  expect(bytes).toBe(3.75 * GIB);
  expect(
    resolveBootCapacityLimits(
      {},
      "MAX_BOOTED",
      { totalMemoryBytes: 16 * GIB, cpuCount: 16 },
      { perDeviceBytes: bytes },
    ),
  ).toEqual({ maxBooted: 2, source: "derived" });
});

const cases: {
  name: string;
  rows: EmulatorMemoryRow[] | undefined;
  boots: InFlightBootMemory[];
  expectedGiB: number;
}[] = [
  {
    name: "RSS below default is still charged at default",
    rows: [settled, { pid: 200, rssBytes: 2.5 * GIB }],
    boots: [boot],
    expectedGiB: 2.25,
  },
  {
    name: "parent pid matches preserve high RSS",
    rows: [settled, { pid: 201, ppid: 200, rssBytes: 6 * GIB }],
    boots: [boot],
    expectedGiB: 3.75,
  },
  {
    name: "all matching rows are summed and a pid plus ppid match counts once",
    rows: [
      settled,
      { pid: 200, ppid: 200, rssBytes: 2 * GIB },
      { pid: 201, ppid: 200, rssBytes: 4 * GIB },
    ],
    boots: [boot],
    expectedGiB: 3.75,
  },
  {
    name: "a boot without a process id gets the default",
    rows: [settled],
    boots: [{ handedOff: false }],
    expectedGiB: 2.25,
  },
  {
    name: "a boot without a matching row gets the default",
    rows: [settled],
    boots: [boot],
    expectedGiB: 2.25,
  },
  {
    name: "each boot gets its own measured or default charge",
    rows: [settled, { pid: 200, rssBytes: 6 * GIB }],
    boots: [boot, { processId: 300, handedOff: false }],
    expectedGiB: 3.5,
  },
  {
    name: "high RSS is preserved without settled rows",
    rows: [{ pid: 200, rssBytes: 6 * GIB }],
    boots: [boot],
    expectedGiB: 6,
  },
  {
    name: "in-flight RSS retains the maximum clamp",
    rows: [{ pid: 200, rssBytes: 12 * GIB }],
    boots: [boot],
    expectedGiB: 6,
  },
  {
    name: "an unavailable table keeps the default",
    rows: undefined,
    boots: [boot],
    expectedGiB: 3,
  },
];

test.each(cases)("$name", ({ rows, boots, expectedGiB }) => {
  expect(estimateSettledPerDeviceBytes(rows, boots, POLICY)).toBe(expectedGiB * GIB);
});
