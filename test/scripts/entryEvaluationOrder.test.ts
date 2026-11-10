import { expect, test } from "bun:test";
import {
  builtEntryPath,
  EARLY_EVALUATED_ENTRYPOINTS,
  findEntryEvaluationOrderViolations,
  staticImportSpecifiers,
} from "../../scripts/build/entry-evaluation-order";

const early = ["runtime/guard.js", "daemon/entry.js"];

function reader(modules: Record<string, string>) {
  return (path: string): string => {
    const text = modules[path];
    if (text === undefined) {
      throw new Error(`unexpected read: ${path}`);
    }
    return text;
  };
}

const ordered: Record<string, string> = {
  "index.js": 'import"./chunk-guard.js";import{p}from"./chunk-pid.js";import"./chunk-big.js";',
  "runtime/guard.js": 'import{g}from"../chunk-guard.js";export{g};',
  "daemon/entry.js": 'import{p}from"../chunk-pid.js";export{p};',
  "chunk-guard.js": "export function g(){}",
  "chunk-pid.js": "var p=process.ppid;export{p};",
};

test("built entry paths mirror the source tree under the bundle dir", () => {
  expect(EARLY_EVALUATED_ENTRYPOINTS.map(builtEntryPath)).toEqual([
    "runtime/bunRuntimeGuard.js",
    "daemon/processEntry.js",
  ]);
});

test("static imports are top-level declarations in source order", () => {
  expect(
    staticImportSpecifiers(
      "a.js",
      'import"./b.js";const x=()=>import("./lazy.js");export{y}from"./c.js";export{x};',
    ),
  ).toEqual(["./b.js", "./c.js"]);
});

test("accepts dependency-free early chunks imported first, in order", () => {
  expect(findEntryEvaluationOrderViolations("index.js", early, reader(ordered))).toEqual([]);
});

test("reports an early chunk imported after another chunk", () => {
  const modules = {
    ...ordered,
    "index.js": 'import"./chunk-big.js";import"./chunk-guard.js";import"./chunk-pid.js";',
  };
  expect(findEntryEvaluationOrderViolations("index.js", early, reader(modules))).toEqual([
    "index.js import #1 is chunk-big.js, expected chunk-guard.js (runtime/guard.js)",
    "index.js import #2 is chunk-guard.js, expected chunk-pid.js (daemon/entry.js)",
  ]);
});

test("reports an early chunk that imports another module first", () => {
  const modules = { ...ordered, "chunk-guard.js": 'import"./chunk-big.js";export function g(){}' };
  expect(findEntryEvaluationOrderViolations("index.js", early, reader(modules))).toEqual([
    "chunk-guard.js (runtime/guard.js) must import nothing; imports ./chunk-big.js",
  ]);
});

test("reports an early module Bun inlined instead of splitting", () => {
  const modules = { ...ordered, "runtime/guard.js": "export function g(){}" };
  expect(findEntryEvaluationOrderViolations("index.js", early, reader(modules))).toEqual([
    "runtime/guard.js was not split into one shared chunk (found 0 imports)",
  ]);
});
