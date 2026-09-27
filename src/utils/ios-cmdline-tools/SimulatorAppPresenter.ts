import { logger } from "../logger";

export interface SimulatorAppPresenter {
  presentAfterStart(udid: string, bootGeneration: string): Promise<void>;
}

/** Shares one launch among callers reporting the same physical boot. */
export class DefaultSimulatorAppPresenter implements SimulatorAppPresenter {
  private readonly presentations = new Map<
    string,
    { bootGeneration: string; presentation: Promise<void> }
  >();

  constructor(private readonly openSimulatorApp: (udid: string) => Promise<boolean>) {}

  presentAfterStart(udid: string, bootGeneration: string): Promise<void> {
    const existing = this.presentations.get(udid);
    if (existing?.bootGeneration === bootGeneration) {
      return existing.presentation;
    }
    const presentation = Promise.resolve()
      .then(() => this.openSimulatorApp(udid))
      .then(
        () => {},
        (error: unknown) => {
          // The simulator remains usable without a GUI; a launch failure is non-fatal.
          logger.warn(`Failed to present Simulator.app for ${udid}: ${error}`);
        },
      );
    this.presentations.set(udid, { bootGeneration, presentation });
    return presentation;
  }

  /** Exposes retained entry count for tests without widening the presenter contract. */
  trackedPresentationCountForTests(): number {
    return this.presentations.size;
  }
}
