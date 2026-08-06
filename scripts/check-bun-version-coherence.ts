#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  packageManager?: string;
  engines?: { bun?: string };
};

const packageManagerVersion = packageJson.packageManager?.match(/^bun@(.+)$/)?.[1];
const engineVersion = packageJson.engines?.bun?.match(/^>=(.+)$/)?.[1];

if (!packageManagerVersion || !engineVersion || packageManagerVersion !== engineVersion) {
  throw new Error("package.json Bun packageManager and engines.bun must pin the same version");
}

const workflowPaths = [
  join(root, ".github", "actions", "setup-auto-mobile-npm-package", "action.yml"),
  ...readdirSync(join(root, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(root, ".github", "workflows", name)),
];

const workflowPinPattern = /^\s*bun-version:\s*(\S+)\s*$/gm;
const mismatches = workflowPaths.flatMap((path) => {
  const content = readFileSync(path, "utf8");
  return [...content.matchAll(workflowPinPattern)]
    .filter((match) => match[1] !== packageManagerVersion)
    .map((match) => `${path}:${content.slice(0, match.index).split("\n").length}: ${match[1]}`);
});

const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const dockerPin = dockerfile.match(/^ARG BUN_VERSION=(\S+)$/m)?.[1];
if (dockerPin !== packageManagerVersion) {
  mismatches.push(`${join(root, "Dockerfile")}: ARG BUN_VERSION=${dockerPin ?? "<missing>"}`);
}

const localDev = readFileSync(join(root, "scripts", "local-dev", "lib", "deps.sh"), "utf8");
if (!localDev.includes(`REQUIRED_BUN_VERSION="${packageManagerVersion}"  # fallback`)) {
  mismatches.push(`${join(root, "scripts", "local-dev", "lib", "deps.sh")}: fallback`);
}

if (mismatches.length > 0) {
  throw new Error(`Bun version drift detected:\n${mismatches.join("\n")}`);
}

console.log(`Bun version coherence passed: ${packageManagerVersion}`);
