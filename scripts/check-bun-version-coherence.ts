#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const root = join(import.meta.dir, "..");
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

interface WorkflowNode {
  uses?: unknown;
  with?: {
    "bun-version"?: unknown;
  };
  [key: string]: unknown;
}

function findBunSetupSteps(value: unknown): WorkflowNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(findBunSetupSteps);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }

  const node = value as WorkflowNode;
  const steps = typeof node.uses === "string" && node.uses.startsWith("oven-sh/setup-bun@") ? [node] : [];
  return steps.concat(Object.values(node).flatMap(findBunSetupSteps));
}

function lineForBunSetup(content: string, occurrence: number): number {
  const lines = content.split("\n");
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*uses:\s*["']?oven-sh\/setup-bun@/.test(lines[index])) {
      if (seen === occurrence) {
        return index + 1;
      }
      seen += 1;
    }
  }
  return 1;
}

const mismatches = workflowPaths.flatMap((path) => {
  const content = readFileSync(path, "utf8");
  const document = load(content);
  return findBunSetupSteps(document).flatMap((step, index) => {
    const version = step.with?.["bun-version"];
    const normalizedVersion = version === undefined || version === null ? "<missing>" : String(version);
    return normalizedVersion === packageManagerVersion
      ? []
      : `${path}:${lineForBunSetup(content, index)}: ${normalizedVersion}`;
  });
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
