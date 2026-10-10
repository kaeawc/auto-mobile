import type { BootAdmission } from "../../models/BootAdmission";

/** What holding an admission needs from a spawned device process: its exit. */
export interface ExitingProcess {
  once(event: "exit", listener: () => void): unknown;
}

/**
 * Reports the child process the moment it exists, before any startup validation, with the serial
 * reserved for it when one is.
 */
export type OnAdmittedSpawn<P extends ExitingProcess> = (
  process: P,
  reservedDeviceId: string | undefined,
) => void;

/**
 * Holds a boot admission (#11181) across one spawn.
 *
 * The slot is handed off the moment the child process exists, not when the spawn settles: startup
 * validation takes up to 5 s, and for that long a process table shows the emulator while its
 * admission still read as "not launched", so the gate counted one boot twice and refused a
 * parallel cold boot that fit (#11564). The hand-off is repeated when the spawn settles, which
 * supplies the serial if only the settled launch knows it.
 *
 * The slot is freed, once, when the spawn fails, when it settles without a process (a duplicate of
 * an emulator started elsewhere), or when the process exits, before or after validation.
 * `release` is idempotent, so the exit and a rejected spawn may both report.
 */
export async function spawnUnderBootAdmission<
  P extends ExitingProcess,
  L extends { process: P | null; reservedDeviceId?: string },
>(
  admission: BootAdmission,
  fallbackDeviceId: string | undefined,
  spawn: (onSpawn: OnAdmittedSpawn<P>) => Promise<L>,
): Promise<L> {
  try {
    const launch = await spawn((process, reservedDeviceId) => {
      process.once("exit", () => admission.release());
      admission.handOff(reservedDeviceId ?? fallbackDeviceId);
    });
    if (launch.process) {
      admission.handOff(launch.reservedDeviceId ?? fallbackDeviceId);
    } else {
      admission.release();
    }
    return launch;
  } catch (error) {
    admission.release();
    throw error;
  }
}
