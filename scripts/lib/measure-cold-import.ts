#!/usr/bin/env bun
// Imports one module in this fresh process and prints "<ms> <loadedModules>".
// Driven by scripts/measure-cold-imports.sh, one process per sample.
import { resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: measure-cold-import.ts <module>");
  process.exit(2);
}

const startedAt = performance.now();
await import(resolve(target));
const elapsedMs = performance.now() - startedAt;
console.log(`${elapsedMs.toFixed(1)} ${Object.keys(require.cache).length}`);
