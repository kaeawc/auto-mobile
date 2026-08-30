import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { BaseActionResult } from "../../src/models/BaseActionResult";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type {
  ClearTextResult,
  SelectAllTextResult,
  TapResult,
  LaunchAppResult,
  PressButtonResult,
  SwipeResult,
} from "../../src/models";

const MODELS_DIR = join(__dirname, "..", "..", "src", "models");

const read = (name: string): string => readFileSync(join(MODELS_DIR, `${name}.ts`), "utf8");

/**
 * Extracts the body of `export interface <name> extends BaseActionResult { ... }`
 * using balanced-brace matching, so nested inline object types and sibling
 * interfaces in the same file are not misattributed to the target interface.
 */
const interfaceBody = (src: string, name: string): string => {
  const header = new RegExp(`interface ${name} extends BaseActionResult\\s*\\{`);
  const match = header.exec(src);
  if (!match) {
    return "";
  }
  let depth = 0;
  let start = -1;
  for (let i = match.index; i < src.length; i++) {
    if (src[i] === "{") {
      if (depth === 0) {
        start = i + 1;
      }
      depth++;
    } else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i);
      }
    }
  }
  return "";
};

/**
 * The exact-trio results that must become bare aliases of BaseActionResult.
 */
const ALIAS_TYPES = ["ClearTextResult", "SelectAllTextResult"] as const;

/**
 * Results that must `extends BaseActionResult`, mapped to a representative extra
 * field that must survive the refactor.
 */
const EXTENDS_TYPES: Record<string, string> = {
  AppStatusResult: "isInstalled",
  BiometricAuthResult: "modality",
  ClearAppDataResult: "packageName",
  CrashAppResult: "supported",
  DragAndDropResult: "distance",
  ExitDialogResult: "elementFound",
  InstallAppResult: "artifactPath",
  LaunchAppResult: "packageName",
  LongPressResult: "pressRecognized",
  OpenURLResult: "url",
  PinchOnResult: "distanceStart",
  PinchResult: "startingMagnitude",
  PressButtonResult: "keyCode",
  RecentAppsResult: "method",
  RotateResult: "orientation",
  SendKeyEventResult: "keyCode",
  SendTextResult: "text",
  SetUIStateResult: "totalAttempts",
  ShakeResult: "intensity",
  SwipeOnResult: "targetType",
  SwipeResult: "x1",
  TapOnElementResult: "action",
  TapResult: "x",
  TerminateAppResult: "wasForeground",
  UninstallAppResult: "keepData",
};

/**
 * Results that must be left untouched — they legitimately do not fit the trio.
 */
const UNTOUCHED_TYPES = [
  "FocusOnResult", // no `error?` — different failure model
  "IntentChooserResult", // observation?: any, not ObserveResult
  "ImeActionResult", // observation?: any
  "HomeScreenResult", // observation?: any
];

describe("BaseActionResult definition", () => {
  test("declares the shared trio and imports ObserveResult", () => {
    const src = read("BaseActionResult");
    expect(src).toMatch(/import\s+\{\s*ObserveResult\s*\}\s+from\s+"\.\/ObserveResult"/);
    expect(src).toMatch(/export\s+interface\s+BaseActionResult\s*\{/);
    expect(src).toMatch(/success:\s*boolean;/);
    expect(src).toMatch(/observation\?:\s*ObserveResult;/);
    expect(src).toMatch(/error\?:\s*string;/);
  });

  test("is barrel-exported from src/models/index.ts", () => {
    expect(read("index")).toMatch(/export \* from "\.\/BaseActionResult";/);
  });

  test("type-level: matches the exact trio shape", () => {
    const value: BaseActionResult = {
      success: true,
      observation: undefined as ObserveResult | undefined,
      error: undefined,
    };
    expect(value.success).toBe(true);
  });
});

describe("exact-trio results alias BaseActionResult", () => {
  for (const name of ALIAS_TYPES) {
    test(`${name} is a bare alias of BaseActionResult`, () => {
      const src = read(name);
      expect(src).toMatch(
        new RegExp(`import\\s+\\{[^}]*BaseActionResult[^}]*\\}\\s+from\\s+"\\./BaseActionResult"`),
      );
      expect(src).toMatch(new RegExp(`export type ${name} = BaseActionResult;`));
      // The trio must no longer be hand-rolled inline.
      expect(src).not.toMatch(/success:\s*boolean;/);
      expect(src).not.toMatch(/observation\?:\s*ObserveResult;/);
    });
  }

  test("type-level: alias is mutually assignable with BaseActionResult", () => {
    const base: BaseActionResult = { success: false, error: "x" };
    const clear: ClearTextResult = base;
    const selectAll: SelectAllTextResult = base;
    const back: BaseActionResult = clear;
    expect(clear.success).toBe(false);
    expect(selectAll.error).toBe("x");
    expect(back.error).toBe("x");
  });
});

describe("with-extras results extend BaseActionResult", () => {
  for (const [name, extraField] of Object.entries(EXTENDS_TYPES)) {
    test(`${name} extends BaseActionResult and keeps '${extraField}'`, () => {
      const src = read(name);
      expect(src).toMatch(
        new RegExp(`import\\s+\\{[^}]*BaseActionResult[^}]*\\}\\s+from\\s+"\\./BaseActionResult"`),
      );
      expect(src).toMatch(new RegExp(`interface ${name} extends BaseActionResult`));
      // The shared trio moved to the base — no inline redeclaration in THIS
      // interface's own body (nested/sibling interfaces are unaffected).
      const body = interfaceBody(src, name);
      expect(body).not.toMatch(/^\s*success:\s*boolean;/m);
      expect(body).not.toMatch(/^\s*observation\?:\s*ObserveResult;/m);
      expect(body).not.toMatch(/^\s*error\?:\s*string;/m);
      // Extra field preserved — anchored to an actual property declaration so a
      // mention inside a comment can't satisfy the assertion.
      expect(body).toMatch(new RegExp(`^\\s*${extraField}\\??:`, "m"));
    });
  }

  test("type-level: extended results remain assignable to BaseActionResult", () => {
    const tap: TapResult = { success: true, x: 1, y: 2 };
    const launch: LaunchAppResult = { success: true, packageName: "com.x" };
    const press: PressButtonResult = { success: true, button: "back", keyCode: 4 };
    const swipe: SwipeResult = { success: true, x1: 0, y1: 0, x2: 1, y2: 1, duration: 100 };
    const bases: BaseActionResult[] = [tap, launch, press, swipe];
    expect(bases.every((b) => b.success)).toBe(true);
    expect(tap.x).toBe(1);
  });
});

describe("out-of-scope results are left untouched", () => {
  for (const name of UNTOUCHED_TYPES) {
    test(`${name} does not adopt BaseActionResult`, () => {
      expect(read(name)).not.toMatch(/BaseActionResult/);
    });
  }
});

describe("coverage is exhaustive (self-enforcing lists)", () => {
  // Discover, from source, every model that adopts BaseActionResult so the
  // hardcoded ALIAS_TYPES/EXTENDS_TYPES lists cannot silently miss a future
  // result type — a new adopter that isn't listed fails one of these tests.
  const modelFiles = readdirSync(MODELS_DIR).filter(
    (f) => f.endsWith(".ts") && f !== "BaseActionResult.ts",
  );

  const actualAliases: string[] = [];
  const actualExtends: string[] = [];
  for (const file of modelFiles) {
    const src = readFileSync(join(MODELS_DIR, file), "utf8");
    const alias = /export type (\w+) = BaseActionResult;/.exec(src);
    if (alias) {
      actualAliases.push(alias[1]);
    }
    for (const m of src.matchAll(/interface (\w+) extends BaseActionResult\b/g)) {
      actualExtends.push(m[1]);
    }
  }

  test("every source-level alias is listed in ALIAS_TYPES", () => {
    expect([...actualAliases].sort()).toEqual([...ALIAS_TYPES].sort());
  });

  test("every source-level `extends BaseActionResult` is listed in EXTENDS_TYPES", () => {
    expect([...actualExtends].sort()).toEqual(Object.keys(EXTENDS_TYPES).sort());
  });
});
