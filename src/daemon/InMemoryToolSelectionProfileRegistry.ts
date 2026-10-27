import { ListChangedBroadcaster } from "./listChangedBroadcast";
import { type ToolSelectionProfileRegistry } from "./toolSelectionProfileRegistry";

export class InMemoryToolSelectionProfileRegistry implements ToolSelectionProfileRegistry {
  private readonly minted = new Set<string>();
  // Deliberately live-only: a reconnecting proxy reapplies its preference, and
  // a replacement daemon must not inherit presentation state from old clients.
  private readonly toolResultsNoStructuredContent = new Map<string, boolean>();
  private readonly actionsCompactMetadata = new Map<string, boolean>();

  record(profileUuid: string): void {
    if (profileUuid.trim().length > 0) {
      this.minted.add(profileUuid);
    }
  }

  has(profileUuid: string): boolean {
    return this.minted.has(profileUuid);
  }

  setToolResultsNoStructuredContent(profileUuid: string, enabled: boolean): void {
    if (profileUuid.trim().length > 0) {
      if (this.toolResultsNoStructuredContent.get(profileUuid) !== enabled) {
        this.toolResultsNoStructuredContent.set(profileUuid, enabled);
        ListChangedBroadcaster.emit("tools");
      }
    }
  }

  getToolResultsNoStructuredContent(profileUuid: string): boolean | undefined {
    return this.toolResultsNoStructuredContent.get(profileUuid);
  }

  setActionsCompactMetadata(profileUuid: string, enabled: boolean): void {
    if (profileUuid.trim().length > 0) {
      this.actionsCompactMetadata.set(profileUuid, enabled);
    }
  }

  getActionsCompactMetadata(profileUuid: string): boolean | undefined {
    return this.actionsCompactMetadata.get(profileUuid);
  }
}
