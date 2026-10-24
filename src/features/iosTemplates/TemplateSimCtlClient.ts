import { runWithAbortSignal } from "../../utils/AbortContext";
import { ActionableError } from "../../models/ActionableError";
import type { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { TemplateSimulatorClient } from "./SimulatorCreationService";
/** Uses the ordinary delete/host-state path and verifies absence in the raw inventory. */
export class TemplateSimCtlClient implements TemplateSimulatorClient {
  constructor(
    private readonly client: Pick<
      SimCtlClient,
      | "createSimulator"
      | "cloneSimulator"
      | "getCatalogChecked"
      | "listSimulators"
      | "deleteSimulator"
      | "bootSimulator"
      | "shutdownSimulator"
    >,
  ) {}
  createSimulator(
    ...args: Parameters<TemplateSimulatorClient["createSimulator"]>
  ): Promise<string> {
    return this.client.createSimulator(...args);
  }
  cloneSimulator(...args: Parameters<TemplateSimulatorClient["cloneSimulator"]>): Promise<string> {
    return this.client.cloneSimulator(...args);
  }
  getCatalogChecked(
    ...args: Parameters<TemplateSimulatorClient["getCatalogChecked"]>
  ): ReturnType<TemplateSimulatorClient["getCatalogChecked"]> {
    return this.client.getCatalogChecked(...args);
  }
  listSimulators(
    ...args: Parameters<TemplateSimulatorClient["listSimulators"]>
  ): ReturnType<TemplateSimulatorClient["listSimulators"]> {
    return this.client.listSimulators(...args);
  }
  async deleteSimulator(udid: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const before = await this.client.listSimulators(undefined, options.signal);
    if (
      !Object.values(before.devices)
        .flat()
        .some((sim) => sim.udid === udid)
    ) {
      return;
    }
    await this.client.deleteSimulator(udid, options);
    const after = await this.client.listSimulators(undefined, options.signal);
    if (
      Object.values(after.devices)
        .flat()
        .some((sim) => sim.udid === udid)
    ) {
      throw new ActionableError(
        `Template simulator ${udid} still exists after deletion. Retry template cleanup.`,
      );
    }
  }
  async boot(udid: string, signal?: AbortSignal): Promise<void> {
    await runWithAbortSignal(signal, () => this.client.bootSimulator(udid));
  }
  shutdownSimulator(udid: string, signal?: AbortSignal): Promise<void> {
    return this.client.shutdownSimulator(udid, signal);
  }
}
