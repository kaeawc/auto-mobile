import type { IosHomeBackend } from "./IosHomeBackend";

export class PhysicalIosHomeBackend implements IosHomeBackend {
  readonly kind = "physical";

  async launchSpringboard(_options: { timeoutMs: number }): Promise<void> {
    // Physical Home navigation belongs to the CtrlProxy runner in the action.
  }
}
