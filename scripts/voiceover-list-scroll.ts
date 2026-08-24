#!/usr/bin/env bun
/**
 * VoiceOver List Scroll - Unsupported Behavior Demonstration
 *
 * This script demonstrates the result when an agent attempts to scroll a
 * UITableView/UICollectionView to find an off-screen item while VoiceOver is
 * active on iOS.
 *
 * Key insight: neither a container selector nor CtrlProxy's scroll endpoints
 * provide a VoiceOver-aware scroll. Those endpoints synthesize XCTest swipes;
 * synthesized coordinate touches do not reach VoiceOver at all.
 *
 * AutoMobile returns an actionable unsupported result instead of falsely
 * reporting that the list has scrolled.
 *
 * This script is a demonstration — it uses simulated responses to show the
 * expected call sequence and response shapes without requiring a real device.
 *
 * Usage:
 *   bun scripts/voiceover-list-scroll.ts
 */

import type { ObserveResult } from "../src/models/ObserveResult";
import type { Element } from "../src/models/Element";

// ---------------------------------------------------------------------------
// Simulated MCP client interface
// In a real agent session, these calls go over the MCP protocol to the server.
// ---------------------------------------------------------------------------

interface TapOnArgs {
  text?: string;
  elementId?: string;
}

interface SwipeOnArgs {
  container?: { elementId: string } | { text: string };
  direction: "up" | "down" | "left" | "right";
  lookFor?: { elementId: string } | { text: string };
}

interface MockClient {
  observe(): Promise<ObserveResult>;
  tapOn(args: TapOnArgs): Promise<{ success: boolean; message: string }>;
  swipeOn(args: SwipeOnArgs): Promise<{ success: boolean; message: string }>;
}

// ---------------------------------------------------------------------------
// Simulated responses representing what the MCP server would return
// ---------------------------------------------------------------------------

function makeInitialListObserve(): ObserveResult {
  // Initial state: list visible, items 1–10 on screen, item 27 off-screen.
  const listContainer: Element = {
    bounds: { left: 0, top: 59, right: 390, bottom: 810 },
    text: "",
    "content-desc": "",
    "resource-id": "itemList",
    class: "UITableView",
    clickable: false,
    focusable: false,
    scrollable: true,
    enabled: true,
  };

  const visibleItems: Element[] = Array.from({ length: 10 }, (_, i) => ({
    bounds: { left: 0, top: 59 + i * 75, right: 390, bottom: 59 + (i + 1) * 75 },
    text: `Item ${i + 1}`,
    "content-desc": `Item ${i + 1}`,
    "resource-id": `item_${i + 1}`,
    class: "UITableViewCell",
    clickable: true,
    focusable: true,
    focused: false,
    enabled: true,
  }));

  return {
    updatedAt: Date.now(),
    screenSize: { width: 390, height: 844 },
    systemInsets: { top: 59, bottom: 34, left: 0, right: 0 },
    accessibilityState: {
      enabled: true,
      service: "voiceover",
    },
    elements: {
      clickable: visibleItems,
      scrollable: [listContainer],
      text: visibleItems,
    },
    activeWindow: {
      packageName: "com.example.app",
      activityName: "ItemListViewController",
      windowId: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Simulated MCP client
// ---------------------------------------------------------------------------

function createMockClient(): MockClient {
  return {
    async observe(): Promise<ObserveResult> {
      return makeInitialListObserve();
    },

    async swipeOn(args: SwipeOnArgs): Promise<{ success: boolean; message: string }> {
      return {
        success: false,
        message: `VoiceOver scrolling is unsupported: CtrlProxy only provides XCTest-synthesized touches, which do not reach VoiceOver. Request: ${JSON.stringify(args)}`,
      };
    },

    async tapOn(args: TapOnArgs): Promise<{ success: boolean; message: string }> {
      return {
        success: true,
        message: `Tapped element (VoiceOver: accessibility activation): ${JSON.stringify(args)}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to print structured section headers
// ---------------------------------------------------------------------------

function printStep(step: number, description: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step ${step}: ${description}`);
  console.log("─".repeat(60));
}

function printResult(label: string, value: unknown): void {
  console.log(`${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Main demonstration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("VoiceOver List Scroll - Unsupported Behavior Demonstration");
  console.log("=".repeat(60));
  console.log();
  console.log("Scenario: Scroll a UITableView to find Item 27 while VoiceOver");
  console.log("is active on iOS. This shows the explicit unsupported result.");

  const client = createMockClient();

  // -------------------------------------------------------------------------
  // Step 1: Observe to confirm VoiceOver state and check the list.
  // -------------------------------------------------------------------------
  printStep(1, "Observe initial list state");

  const initialObserve = await client.observe();
  printResult("accessibilityState", initialObserve.accessibilityState);

  const visibleTexts = initialObserve.elements?.text?.map((el) => el.text) ?? [];
  console.log(`\nVisible items: ${visibleTexts.join(", ")}`);

  const item27Visible =
    initialObserve.elements?.clickable?.some((el) => el.text === "Item 27") ?? false;
  console.log(`Item 27 already visible: ${item27Visible}`);

  // -------------------------------------------------------------------------
  // Step 2: Attempt to scroll the list to find Item 27.
  // -------------------------------------------------------------------------
  printStep(2, "Attempt to scroll list to find Item 27");
  console.log("Note: A container selector cannot turn CtrlProxy's synthesized");
  console.log("      XCTest swipe into VoiceOver's three-finger scroll gesture.");

  const scrollResult = await client.swipeOn({
    container: { elementId: "itemList" },
    direction: "up",
    lookFor: { text: "Item 27" },
  });
  printResult("swipeOn result", scrollResult);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Unsupported behavior demonstrated.");
  console.log("=".repeat(60));
  console.log();
  console.log("Key takeaways:");
  console.log("  - swipeOn returns an unsupported result while VoiceOver is active.");
  console.log("  - CtrlProxy scroll endpoints use synthesized XCTest touches, which");
  console.log("    do not reach VoiceOver.");
  console.log("  - A container elementId does not provide a VoiceOver scroll fallback.");
  console.log("  - SDK-enabled apps also expose the VoiceOver cursor through");
  console.log("    observe().accessibilityFocusedElement.");
  console.log("  - tapOn still uses accessibility activation (transparent to agent).");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
