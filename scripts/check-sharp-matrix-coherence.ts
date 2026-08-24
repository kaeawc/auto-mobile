import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * sharp ships libvips as a separately-linked native matrix: the top-level
 * `sharp` package plus one `@img/sharp-<platform>` binary per target and one
 * `@img/sharp-libvips-<platform>` shared library per target. sharp pins every
 * `@img/sharp-<platform>` to its own version and every `@img/sharp-libvips-*`
 * to a single libvips version via its own `optionalDependencies`. If our pins
 * drift out of lockstep — e.g. a Dependabot group PR that bumps only the
 * packages currently eligible for an update — the installed matrix is
 * incoherent and sharp can fail to load at runtime.
 *
 * `.github/dependabot.yml` groups these so they *tend* to bump together, but a
 * `groups` rule does not enforce completeness. This check is the actual gate:
 * it rejects any partial bump so the invariant holds regardless of how the
 * update arrived. See docs/design-docs/image-backend.md.
 */

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

const packageJsonPath = join(import.meta.dir ?? ".", "..", "package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;

const sharpVersion = pkg.dependencies?.sharp;
const optional = pkg.optionalDependencies ?? {};

const errors: string[] = [];

if (!sharpVersion) {
  errors.push("`sharp` is not pinned in dependencies.");
}

const platformPins = Object.entries(optional).filter(
  ([name]) => name.startsWith("@img/sharp-") && !name.startsWith("@img/sharp-libvips-"),
);
const libvipsPins = Object.entries(optional).filter(([name]) =>
  name.startsWith("@img/sharp-libvips-"),
);

if (platformPins.length === 0) {
  errors.push("no `@img/sharp-<platform>` binaries are pinned in optionalDependencies.");
}
if (libvipsPins.length === 0) {
  errors.push("no `@img/sharp-libvips-<platform>` libraries are pinned in optionalDependencies.");
}

// Every @img/sharp-<platform> binary must match the top-level sharp version.
if (sharpVersion) {
  for (const [name, version] of platformPins) {
    if (version !== sharpVersion) {
      errors.push(
        `${name} is ${version} but sharp is ${sharpVersion} — the platform binary matrix must move with sharp.`,
      );
    }
  }
}

// Every @img/sharp-libvips-<platform> library must share one libvips version.
const libvipsVersions = new Set(libvipsPins.map(([, version]) => version));
if (libvipsVersions.size > 1) {
  const detail = libvipsPins.map(([name, version]) => `${name}@${version}`).join(", ");
  errors.push(
    `@img/sharp-libvips-* pins are not uniform (${[...libvipsVersions].join(", ")}): ${detail}`,
  );
}

if (errors.length > 0) {
  console.error(
    "error: sharp native matrix is incoherent — a partial bump would break `sharp` at runtime:",
  );
  for (const message of errors) {
    console.error(`  - ${message}`);
  }
  console.error(
    "Bump `sharp` + every `@img/sharp-*` (and `@img/sharp-libvips-*`) together. See docs/design-docs/image-backend.md.",
  );
  process.exit(1);
}

const libvipsVersion = [...libvipsVersions][0];
console.log(
  `sharp-matrix: coherent — sharp ${sharpVersion}, ${platformPins.length} platform binaries @ ${sharpVersion}, ` +
    `${libvipsPins.length} libvips libraries @ ${libvipsVersion}.`,
);
