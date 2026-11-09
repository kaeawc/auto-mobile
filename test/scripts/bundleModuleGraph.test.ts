import { expect, test } from "bun:test";
import {
  findMissingBundleModules,
  isBundleModule,
  relativeModuleSpecifiers,
} from "../../scripts/build/bundle-module-graph";

test("collects every relative module form Bun emits for split chunks", () => {
  const source = [
    'import{a}from"./chunk-static.js";',
    'import"./chunk-side-effect.js";',
    'export{b}from"./chunk-reexport.js";',
    'const c=()=>import("./chunk-dynamic.js");',
    'const d=import.meta.require("./chunk-meta-require.js");',
    'const e=require("../../chunk-require.js");',
    'import f from"sharp";import"node:fs";const g=import("jimp");',
    '// import "./chunk-comment.js"',
  ].join("\n");
  expect(relativeModuleSpecifiers("dist/src/index.js", source)).toEqual([
    "../../chunk-require.js",
    "./chunk-dynamic.js",
    "./chunk-meta-require.js",
    "./chunk-reexport.js",
    "./chunk-side-effect.js",
    "./chunk-static.js",
  ]);
});

test("walks transitively from nested entrypoints and reports each missing edge once", () => {
  const modules: Record<string, string> = {
    "dist/src/index.js": 'import"./chunk-a.js";import"./chunk-a.js";',
    "dist/src/utils/workers/w.js": 'import"../../chunk-a.js";import"../../chunk-gone.js";',
    "dist/src/chunk-a.js": 'import"./chunk-b.js";import"./chunk-index-cycle.js";',
    "dist/src/chunk-index-cycle.js": 'import"./chunk-a.js";',
  };
  const read = (path: string): string => {
    const text = modules[path];
    if (text === undefined) {
      throw new Error(`walked an unpacked module: ${path}`);
    }
    return text;
  };
  expect(
    findMissingBundleModules(
      Object.keys(modules),
      ["dist/src/index.js", "dist/src/utils/workers/w.js", "dist/src/not-packed-entry.js"],
      read,
    ),
  ).toEqual([
    "Missing bundle module: dist/src/chunk-b.js (imported by dist/src/chunk-a.js)",
    "Missing bundle module: dist/src/chunk-gone.js (imported by dist/src/utils/workers/w.js)",
  ]);
});

test("bundle modules are JavaScript under dist/src only", () => {
  expect(isBundleModule("dist/src/chunk-x.js")).toBe(true);
  expect(isBundleModule("dist/src/utils/workers/w.js")).toBe(true);
  expect(isBundleModule("dist/src/index.js.map")).toBe(false);
  expect(isBundleModule("node_modules/x/index.js")).toBe(false);
});
