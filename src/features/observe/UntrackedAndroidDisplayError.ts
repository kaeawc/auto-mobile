import { AndroidDisplayReadError } from "./AndroidDisplayReadError";

/**
 * The display service lists this display, but Android's accessibility service does not track it
 * (a private virtual display), so it has no readable view hierarchy. Retrying cannot help.
 */
export class UntrackedAndroidDisplayError extends AndroidDisplayReadError {
  constructor(
    readonly displayId: number,
    readonly detail: { uniqueId?: string; ownerPackage?: string } = {},
  ) {
    const owner = detail.ownerPackage ? ` owned by ${detail.ownerPackage}` : "";
    const unique = detail.uniqueId ? ` (${detail.uniqueId})` : "";
    super(
      `Display ${displayId}${unique} is a private virtual display${owner}. Android's accessibility ` +
        `service does not track private virtual displays, so this display has no view hierarchy ` +
        `and cannot be observed. Input injected with "input -d ${displayId}" still reaches it. ` +
        `On an emulator, create the display public (the last -multidisplay field set to 1).`,
    );
  }
}
