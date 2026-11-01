import {
  importBundle,
  openEntry,
  type SmokeBundle,
  type SmokeCheck,
  type SmokeDriver,
} from "./flows";

export type DuoPosture = "closed" | "opened";
export interface PostureSetter {
  /** Resolves only once the requested posture is reached. */
  set(posture: DuoPosture): Promise<void>;
}
export interface DuoScreens {
  enumerate(): Promise<readonly { readonly name: string | null }[]>;
  screenshot(display: string): Promise<Uint8Array>;
}
export interface DuoArtifacts {
  /** Writes the image and returns bytes read back from the saved file. */
  save(name: string, bytes: Uint8Array): Promise<Uint8Array>;
}
interface DuoDependencies {
  readonly posture: PostureSetter;
  readonly screens: DuoScreens;
  readonly artifacts: DuoArtifacts;
}

export function validateDuoOptions(options: {
  duo?: boolean;
  platform: string;
  postureCommand?: string;
}): string | undefined {
  if (options.duo && options.platform !== "ios") {
    return "--duo requires platform ios";
  }
  if (options.duo && !options.postureCommand) {
    return "--duo requires --posture-command";
  }
  return undefined;
}

async function postureCheck(name: string, run: () => Promise<void>): Promise<SmokeCheck> {
  try {
    await run();
    return { name, status: "pass", detail: "complete" };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function capture(dependencies: DuoDependencies, posture: DuoPosture): Promise<SmokeCheck> {
  const display = posture === "closed" ? "primary" : "primary-1";
  return postureCheck(`Duo ${posture} screenshot ${display}`, async () => {
    const displays = await dependencies.screens.enumerate();
    if (!displays.some((entry) => entry.name === display)) {
      throw new Error(
        `missing display ${display}; available displays: ${displays.map((entry) => entry.name ?? "<unnamed>").join(", ") || "<none>"}`,
      );
    }
    const bytes = await dependencies.screens.screenshot(display);
    const written = await dependencies.artifacts.save(`${posture}.png`, bytes);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      written.length <= signature.length ||
      !signature.every((byte, index) => written[index] === byte)
    ) {
      throw new Error(`${posture}.png is empty or missing PNG image data/signature`);
    }
  });
}

/** The candidate is already installed. Every failure is a verdict, including fold-back. */
export async function runDuoSmoke(
  driver: SmokeDriver,
  bundle: SmokeBundle,
  dependencies: DuoDependencies,
): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  try {
    for (const posture of ["closed", "opened"] as const) {
      const set = await postureCheck(`Duo posture ${posture}`, () =>
        dependencies.posture.set(posture),
      );
      checks.push(set);
      if (set.status === "fail") {
        continue;
      }
      const imported = await importBundle(driver, bundle);
      checks.push({ ...imported.check, name: `Duo ${posture} ${imported.check.name}` });
      if (imported.libraryId === undefined) {
        continue;
      }
      const opened = await openEntry(
        driver,
        `Duo ${posture} open ${bundle.label}`,
        imported.libraryId,
        bundle.label,
      );
      checks.push(opened);
      if (opened.status === "fail") {
        continue;
      }
      checks.push(await capture(dependencies, posture));
    }
  } finally {
    checks.push(
      await postureCheck("Duo fold back closed", () => dependencies.posture.set("closed")),
    );
  }
  return checks;
}
