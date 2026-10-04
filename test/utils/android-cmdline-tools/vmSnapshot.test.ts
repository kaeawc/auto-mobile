import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  buildVmSnapshotCommand,
  formatVmSnapshotExecutionError,
  type VmSnapshotAction,
} from "../../../src/utils/android-cmdline-tools/vmSnapshot";

const actions: Array<{ action: VmSnapshotAction; verb: string }> = [
  { action: "save", verb: "save" },
  { action: "load", verb: "load" },
  { action: "delete", verb: "del" },
];

const invalidNames = [
  { kind: "space", name: "a b" },
  { kind: "newline", name: "a\nb" },
  { kind: "tab", name: "a\tb" },
  { kind: "carriage return", name: "a\rb" },
  { kind: "NUL", name: "a\0b" },
  { kind: "DEL", name: "a\u007fb" },
  { kind: "C1 control", name: "a\u0085b" },
  { kind: "non-breaking space", name: "a\u00a0b" },
];

describe("buildVmSnapshotCommand", () => {
  for (const { action, verb } of actions) {
    test(`${action} preserves a snapshot name as one console token`, () => {
      expect(buildVmSnapshotCommand(action, "ab1_-")).toBe(`emu avd snapshot ${verb} ab1_-`);
      expect(buildVmSnapshotCommand(action, "v1.0")).toBe(`emu avd snapshot ${verb} v1.0`);
    });

    test(`${action} preserves empty snapshot name behavior`, () => {
      expect(buildVmSnapshotCommand(action, "")).toBe(`emu avd snapshot ${verb} `);
    });

    for (const { kind, name } of invalidNames) {
      test(`${action} rejects a snapshot name containing ${kind} before building the console command`, () => {
        const buildCommand = () => buildVmSnapshotCommand(action, name);
        expect(buildCommand).toThrow(ActionableError);
        expect(buildCommand).toThrow(
          "is not valid: it must not contain whitespace or control characters. Use letters, numbers, dots, underscores and hyphens.",
        );
      });
    }
  }

  test("truncates a long invalid name to 64 characters followed by an ellipsis", () => {
    expect(() => buildVmSnapshotCommand("delete", `${"a".repeat(100)} b`)).toThrow(
      `VM snapshot name "${"a".repeat(64)}…" is not valid: it must not contain whitespace or control characters. Use letters, numbers, dots, underscores and hyphens.`,
    );
  });

  test("preserves complete surrogate pairs when truncating an invalid name", () => {
    expect(() => buildVmSnapshotCommand("delete", `${"a".repeat(63)}😀 b`)).toThrow(
      `VM snapshot name "${"a".repeat(63)}…" is not valid: it must not contain whitespace or control characters. Use letters, numbers, dots, underscores and hyphens.`,
    );
  });

  test("escapes control characters and quotes in the validation message", () => {
    expect(() => buildVmSnapshotCommand("delete", 'a"\n\0\u007f\u0085b')).toThrow(
      'VM snapshot name "a\\"\\n\\u0000\\u007f\\u0085b" is not valid: it must not contain whitespace or control characters. Use letters, numbers, dots, underscores and hyphens.',
    );
  });
});

describe("VM snapshot error classification", () => {
  const categories = [
    { detail: "timed out", phrase: "command timed out" },
    { detail: "timeout", phrase: "command timed out" },
    { detail: "device offline", phrase: "emulator is offline or not responding" },
    { detail: "offline", phrase: "emulator is offline or not responding" },
    { detail: "device not found", phrase: "emulator not found" },
    { detail: "no devices", phrase: "emulator not found" },
    { detail: "no emulators", phrase: "emulator not found" },
    { detail: "unknown command", phrase: "emulator does not support snapshot commands" },
    { detail: "not supported", phrase: "emulator does not support snapshot commands" },
    { detail: "unknown avd", phrase: "emulator does not support snapshot commands" },
    { detail: "snapshot not found", phrase: "snapshot not found" },
    { detail: "snapshot does not exist", phrase: "snapshot not found" },
  ];

  test.each(categories)("preserves the exact message for $detail", ({ detail, phrase }) => {
    expect(formatVmSnapshotExecutionError("delete", "ab1_-", `  KO: ${detail}  `)).toBe(
      `VM snapshot delete failed for 'ab1_-': ${phrase} (${detail})`,
    );
  });

  test("uses the first matching category when details overlap", () => {
    for (let i = 0; i < categories.length; i++) {
      const { detail, phrase } = categories[i];
      const combined = [detail, ...categories.slice(i + 1).map((category) => category.detail)].join(
        "; ",
      );
      expect(formatVmSnapshotExecutionError("load", "ab1_-", combined)).toBe(
        `VM snapshot load failed for 'ab1_-': ${phrase} (${combined})`,
      );
    }
  });

  test("preserves empty and unclassified details", () => {
    expect(formatVmSnapshotExecutionError("save", "ab1_-", " KO: ")).toBe(
      "VM snapshot save failed for 'ab1_-': no response from emulator",
    );
    expect(formatVmSnapshotExecutionError("save", "ab1_-", " KO: failed ")).toBe(
      "VM snapshot save failed for 'ab1_-': failed",
    );
  });
});
