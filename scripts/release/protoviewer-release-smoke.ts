#!/usr/bin/env bun
/**
 * ProtoViewer release-artifact device checks (issue #15387), the device half of #14154.
 *
 *   bun scripts/release/protoviewer-release-smoke.ts <android|ios> --device <serial|udid>
 *       --candidate <apk|.app> [--previous <apk|.app>] [--mode upgrade|smoke|all]
 *       [--duo --posture-command <executable>] [--screenshots-dir <dir>]
 *   duo      iOS only: closed primary / opened primary-1 PNGs, then fold back closed.
 *            The posture command receives closed/opened and must wait until reached.
 *
 *   upgrade  installs --previous, imports a prototype, installs --candidate over it (no
 *            uninstall) and checks the version moved, app data was kept and the saved entry opens.
 *   smoke    installs --candidate (the R8-minified APK or the stripped iOS release), imports and
 *            opens a bundled and an imported prototype, and on Android shows Settings and
 *            Open-source licenses.
 *
 * Needs a booted emulator or simulator; it only touches the device it is given. Exit 0 when no
 * check failed (skipped checks are listed), 1 on a failed check, 2 on usage errors. Local use and
 * artifact defaults: scripts/release/protoviewer-release-smoke.sh.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runDuoSmoke, validateDuoOptions } from "./lib/protoviewer-smoke/duoFlow";
import { parseArgs } from "node:util";
import { ExecFileToolRunner } from "./lib/artifact-policy/toolRunner";
import { createAndroidDriver } from "./lib/protoviewer-smoke/androidDriver";
import { smokeBundles } from "./lib/protoviewer-smoke/bundles";
import { runMinifiedSmoke, runUpgradeInPlace, summarize } from "./lib/protoviewer-smoke/flows";
import {
  createIosDriver,
  createDuoScreens,
  createPostureSetter,
} from "./lib/protoviewer-smoke/iosDriver";

const MODES = ["upgrade", "smoke", "all"] as const;
type Mode = (typeof MODES)[number];

function usage(message: string): never {
  console.error(
    `${message}\nusage: protoviewer-release-smoke.ts <android|ios> --device <id> --candidate <path> [--previous <path>] [--mode upgrade|smoke|all] [--duo --posture-command <executable>] [--screenshots-dir <dir>]`,
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      duo: { type: "boolean" },
      "posture-command": { type: "string" },
      "screenshots-dir": { type: "string", default: "scratch/protoviewer-smoke/duo" },
      device: { type: "string" },
      candidate: { type: "string" },
      previous: { type: "string" },
      mode: { type: "string", default: "all" },
    },
  });
  const platform = positionals[0];
  if (platform !== "android" && platform !== "ios") {
    usage("platform must be android or ios");
  }
  const duoError = validateDuoOptions({
    duo: values.duo,
    platform,
    postureCommand: values["posture-command"],
  });
  if (duoError) {
    usage(duoError);
  }
  const mode = values.mode as Mode;
  if (!MODES.includes(mode)) {
    usage(`unknown --mode ${values.mode}`);
  }
  if (!values.device) {
    usage("--device is required");
  }
  if (!values.candidate) {
    usage("--candidate is required");
  }
  if (mode !== "smoke" && !values.previous) {
    usage("--previous is required for upgrade");
  }

  const runner = new ExecFileToolRunner();
  const driver =
    platform === "android"
      ? createAndroidDriver(values.device, runner)
      : createIosDriver(values.device, runner);
  const bundles = smokeBundles();
  const checks = [];
  if (mode !== "smoke") {
    checks.push(
      ...(await runUpgradeInPlace(
        driver,
        { previous: values.previous as string, candidate: values.candidate },
        bundles.imported,
      )),
    );
  }
  if (mode !== "upgrade") {
    checks.push(...(await runMinifiedSmoke(driver, values.candidate, bundles)));
  }
  if (values.duo) {
    const directory = resolve(values["screenshots-dir"]);
    checks.push(
      ...(await runDuoSmoke(driver, bundles.imported, {
        posture: createPostureSetter(values["posture-command"]!, runner),
        screens: createDuoScreens(values.device),
        artifacts: {
          async save(name, bytes) {
            await mkdir(directory, { recursive: true });
            const path = resolve(directory, name);
            await writeFile(path, bytes);
            return readFile(path);
          },
        },
      })),
    );
  }
  const { text, failed } = summarize(checks);
  console.log(text);
  process.exit(failed ? 1 : 0);
}

await main();
