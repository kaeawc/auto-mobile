import { stripNavigationToolParams } from "../../models/navigationToolParams";
import {
  NavigationToolCallHandle,
  ScrollPosition,
  ToolCallInteraction,
  UIState,
} from "../../utils/interfaces/NavigationGraph";
import { logger } from "../../utils/logger";
import { Timer } from "../../utils/SystemTimer";

/** Transient dispatch/correlation history; uses the manager's host clock and live screen state. */
export class NavigationToolCallHistory {
  // Tool call history kept in memory for correlation (transient data)
  private toolCallHistory: ToolCallInteraction[] = [];
  // Calls that left the history for a reason that is final: withdrawn, consumed by an edge, or
  // dropped on an app switch. A late dispatch report must not bring one back (#10196). A call
  // pruned only by age is not in here, so reporting its dispatch can still revive it.
  private retiredToolCalls: WeakSet<ToolCallInteraction> = new WeakSet();

  // Correlation window: the tool call's gesture must go out 0-2000ms before the navigation
  // event. Measured from dispatch when the action reported it, else from tool start (#10196).
  private readonly TOOL_CALL_CORRELATION_WINDOW_MS = 2000;
  // Keep tool calls for 10 seconds, measured the same way.
  private readonly TOOL_CALL_HISTORY_TTL_MS = 10000;
  constructor(
    private readonly timer: Timer,
    private readonly state: { currentAppId: string | null; currentScreen: string | null },
  ) {}
  get size(): number {
    return this.toolCallHistory.length;
  }
  clear(): void {
    this.toolCallHistory = [];
  }

  /**
   * Record a tool call for one future edge; withdraw it if execution fails or is cancelled.
   * The returned handle also reports when the call's gesture was dispatched, so a call that
   * spent seconds finding its target is still attributed to the navigation it caused (#10196).
   */
  public recordToolCall(
    toolName: string,
    args: Record<string, unknown>,
    uiState?: UIState,
    deviceId?: string,
  ): NavigationToolCallHandle {
    const timestamp = this.timer.now();

    const interaction: ToolCallInteraction = {
      toolName,
      args: stripNavigationToolParams(args),
      timestamp,
      uiState,
      ...(deviceId !== undefined ? { deviceId } : {}),
    };
    this.toolCallHistory.push(interaction);

    const uiStateInfo = uiState?.selectedElements.length
      ? ` (UI: ${uiState.selectedElements.map((e) => e.text || e.resourceId).join(", ")})`
      : "";
    const modalInfo = uiState?.modalStack?.length ? ` [${uiState.modalStack.length} modal(s)]` : "";
    logger.debug(
      `[NAVIGATION_GRAPH] Tool call recorded: ${toolName} at ${timestamp}${uiStateInfo}${modalInfo}`,
    );

    // Clean up old tool calls
    this.cleanupToolCallHistory();
    const startApp = this.state.currentAppId;
    const startScreen = this.state.currentScreen;
    const withdraw = (): void => this.retireToolCalls((tc) => tc === interaction);
    return Object.assign(withdraw, {
      markDispatched: () => this.markToolCallDispatched(interaction, startApp, startScreen),
    });
  }

  /** The call's gesture went out now; correlation and the TTL measure from here (#10196). */
  private markToolCallDispatched(
    interaction: ToolCallInteraction,
    startApp: string | null,
    startScreen: string | null,
  ): void {
    if (this.retiredToolCalls.has(interaction)) {
      return;
    }
    // The first report is the earliest the gesture could take effect; a later one (a retry, or
    // a report made after the command returned) must not move the window past an event the
    // gesture already caused.
    if (interaction.dispatchedAt === undefined) {
      // Dispatch reports carry no observation. State captured at tool start belongs to a
      // different source if searchUntil crossed screens; never replay that stale state.
      if (
        (startApp && this.state.currentAppId && this.state.currentAppId !== startApp) ||
        (startScreen && this.state.currentScreen && this.state.currentScreen !== startScreen)
      ) {
        interaction.uiState = undefined;
      }
      interaction.dispatchedAt = Math.max(this.timer.now(), interaction.timestamp);
    }
    // A call that waited longer than the TTL for its target was pruned while still in flight.
    if (!this.toolCallHistory.includes(interaction)) {
      this.toolCallHistory.push(interaction);
    }
  }

  retireToolCalls(matches: (toolCall: ToolCallInteraction) => boolean): void {
    for (const toolCall of this.toolCallHistory) {
      if (matches(toolCall)) {
        this.retiredToolCalls.add(toolCall);
      }
    }
    this.toolCallHistory = this.toolCallHistory.filter((tc) => !matches(tc));
  }

  /**
   * Update the most recent swipeOn tool call with scroll position information.
   * This is called after a swipeOn with lookFor completes successfully.
   */
  public updateScrollPosition(scrollPosition: ScrollPosition): void {
    if (this.toolCallHistory.length === 0) {
      logger.debug(`[NAVIGATION_GRAPH] Cannot update scroll position: no tool calls`);
      return;
    }

    // Find the most recent swipeOn tool call
    const recentSwipeOn = [...this.toolCallHistory]
      .reverse()
      .find((tc) => tc.toolName === "swipeOn");

    if (!recentSwipeOn) {
      logger.debug(`[NAVIGATION_GRAPH] No recent swipeOn tool call to update`);
      return;
    }

    // Update the UI state with scroll position
    if (!recentSwipeOn.uiState) {
      recentSwipeOn.uiState = {
        selectedElements: [],
        scrollPosition,
      };
    } else {
      recentSwipeOn.uiState.scrollPosition = scrollPosition;
    }

    logger.debug(
      `[NAVIGATION_GRAPH] Updated scroll position for swipeOn: ` +
        `target=${scrollPosition.targetElement.text || scrollPosition.targetElement.resourceId}, ` +
        `direction=${scrollPosition.direction}`,
    );
  }

  /** The moment a call acted: its reported dispatch, else when the tool started (#10196). */
  private toolCallActedAt(toolCall: ToolCallInteraction): number {
    return toolCall.dispatchedAt ?? toolCall.timestamp;
  }

  /**
   * Remove tool calls older than TTL.
   */
  private cleanupToolCallHistory(): void {
    const cutoff = this.timer.now() - this.TOOL_CALL_HISTORY_TTL_MS;
    const before = this.toolCallHistory.length;
    this.toolCallHistory = this.toolCallHistory.filter((tc) => this.toolCallActedAt(tc) >= cutoff);
    const removed = before - this.toolCallHistory.length;
    if (removed > 0) {
      logger.debug(`[NAVIGATION_GRAPH] Cleaned up ${removed} old tool calls`);
    }
  }

  /**
   * Find a tool call that likely caused a navigation event.
   * Uses host receipt time so device clock skew cannot move a tool call outside
   * the correlation window. Arrival order breaks ties and also works when the
   * SDK supplied no timestamp (so no device-to-host offset can be estimated).
   * The window runs from when the call's gesture was dispatched when the action
   * reported it, so a tap that waited for its target is still attributed (#10196).
   */
  findCorrelatedToolCall(receivedAt: number): ToolCallInteraction | undefined {
    this.cleanupToolCallHistory();
    const candidates = this.toolCallHistory.filter((tc) => {
      const timeDiff = receivedAt - this.toolCallActedAt(tc);
      return timeDiff >= 0 && timeDiff <= this.TOOL_CALL_CORRELATION_WINDOW_MS;
    });

    if (candidates.length === 0) {
      logger.debug(
        `[NAVIGATION_GRAPH] No tool call correlated with navigation ` +
          `(host receipt=${receivedAt}, window=${this.TOOL_CALL_CORRELATION_WINDOW_MS}ms, history=${this.toolCallHistory.length})`,
      );
      return undefined;
    }

    // Return the call that acted most recently before navigation; the later arrival wins a tie.
    const mostRecent = candidates.reduce((latest, tc) =>
      this.toolCallActedAt(tc) >= this.toolCallActedAt(latest) ? tc : latest,
    );
    logger.debug(
      `[NAVIGATION_GRAPH] Correlated tool call: ${mostRecent.toolName} ` +
        `(${receivedAt - this.toolCallActedAt(mostRecent)}ms before navigation)`,
    );
    return mostRecent;
  }
}
