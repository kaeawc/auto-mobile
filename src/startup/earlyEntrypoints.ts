import { hasGlobalHelpFlag } from "../cli/helpFlag";
import { startupBenchmark } from "../utils/startupBenchmark";

/**
 * Entry points that must run before every normal server import and startup side effect: each one
 * ends the process itself (`process.exit`), so reaching the end of this function means none
 * applied and the server bootstrap goes on.
 */
export async function runEarlyEntrypoints(rawArgs: string[]): Promise<void> {
  if (hasGlobalHelpFlag(rawArgs)) {
    const { runCliCommand } = await import("../cli");
    await runCliCommand(["help"]);
    process.exit(0);
  }
  const bootDeviceIndex = rawArgs.indexOf("--boot-device");
  if (bootDeviceIndex >= 0) {
    // The daemon-free boot entrypoint must remain before every normal server
    // import and startup side effect: no database, daemon, CtrlProxy, or media
    // cache work is needed to launch and await a device.
    const { runBootDeviceCommand } = await import("../cli/bootDevice");
    startupBenchmark.endPhase("moduleImports");
    await runBootDeviceCommand(rawArgs.slice(bootDeviceIndex + 1));
    // Android launch owns a live emulator child; the one-shot caller only
    // needs the already-flushed JSON result, not that child as its own event
    // loop responsibility.
    process.exit(0);
  }

  const templatesIndex = rawArgs.indexOf("--ios-templates");
  if (templatesIndex >= 0) {
    const { runIosTemplatesCommand } = await import("../cli/iosTemplates");
    startupBenchmark.endPhase("moduleImports");
    process.exit(await runIosTemplatesCommand(rawArgs.slice(templatesIndex + 1)));
  }

  const networkFilterIndex = rawArgs.indexOf("--ios-network-filter");
  if (networkFilterIndex >= 0) {
    // Opt-in host action (#10588): installing a system extension changes the
    // host, so it only ever runs from this explicit command, before any daemon,
    // database or device startup work.
    const { runIosNetworkFilterCommand } = await import("../cli/iosNetworkFilter");
    startupBenchmark.endPhase("moduleImports");
    process.exit(await runIosNetworkFilterCommand(rawArgs.slice(networkFilterIndex + 1)));
  }
}
