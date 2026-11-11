import { CarAppTemplateReader } from "../features/observe/android/CarAppTemplateReader";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";

let defaultCarAppTemplateReader: CarAppTemplateReader | undefined;

/** Shared by observation, head-unit actions and install invalidation. Construction runs no adb. */
export function carAppTemplateReader(): CarAppTemplateReader {
  defaultCarAppTemplateReader ??= new CarAppTemplateReader((target) =>
    defaultAdbClientFactory.create(target),
  );
  return defaultCarAppTemplateReader;
}
