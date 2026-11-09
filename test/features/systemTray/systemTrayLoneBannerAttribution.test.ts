import { describe, expect, test } from "bun:test";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../src/models";
import {
  findBestNotificationMatch,
  findsContentOnUnattributedIosRow,
} from "../../../src/features/systemTray/helpers/matching";
import { getDirectChildNodes } from "../../../src/features/systemTray/helpers/hierarchy";
import { ios26TrayOpenHome, iosMessagesGroupedTray } from "./iosTrayObservationFixture";

// iOS names the app only on a stacked row ("MESSAGES, Grouped, now, …"); a lone
// banner's label starts at its time and names no app (#17445). Both rows come from
// iOS 26.5 captures: the Settings "Ready for Apple Intelligence" lone banner
// (full-tray-open-home.json) and the grouped Messages stack
// (full-tray-open-messages-grouped.json).

const SETTINGS = ["Settings", "com.apple.Preferences"];
const MESSAGES = ["Messages", "com.apple.MobileSMS"];
const BANNER = {
  title: "Ready for Apple Intelligence",
  body: "Time to experience the new personal intelligence system.",
};

const clone = (hierarchy: ViewHierarchyResult): ViewHierarchyResult =>
  JSON.parse(JSON.stringify(hierarchy)) as ViewHierarchyResult;

const loneBannerTray = (): ViewHierarchyResult => clone(ios26TrayOpenHome.viewHierarchy!);

const rowLabel = (node: ViewHierarchyNode): string =>
  String((node.$ as Record<string, unknown> | undefined)?.text ?? "");

const containsRow = (node: ViewHierarchyNode, labelPrefix: string): boolean =>
  rowLabel(node).startsWith(labelPrefix) ||
  getDirectChildNodes(node).some((child) => containsRow(child, labelPrefix));

/** The deepest list that holds the row's section beside its sibling sections. */
const findRowSection = (
  node: ViewHierarchyNode | undefined,
  labelPrefix: string,
): { siblings: ViewHierarchyNode[]; section: ViewHierarchyNode } | null => {
  if (!node) {
    return null;
  }
  for (const child of getDirectChildNodes(node)) {
    const deeper = findRowSection(child, labelPrefix);
    if (deeper) {
      return deeper;
    }
  }
  const siblings = Array.isArray(node.node) ? (node.node as ViewHierarchyNode[]) : [];
  const section = siblings.find((child) => containsRow(child, labelPrefix));
  return siblings.length > 1 && section ? { siblings, section } : null;
};

/** The captured Messages stack with the captured Settings lone banner beside it. */
const twoAppTray = (): ViewHierarchyResult => {
  const tray = clone(iosMessagesGroupedTray.viewHierarchy!);
  const banner = findRowSection(loneBannerTray().hierarchy.node, "1 minute ago")!;
  findRowSection(tray.hierarchy.node, "MESSAGES")!.siblings.push(banner.section);
  return tray;
};

describe("iOS lone banner app attribution", () => {
  test("never reads the banner's time as its app name", () => {
    expect(
      findBestNotificationMatch(loneBannerTray(), { title: BANNER.title, appId: "x.minute" }, [
        "1 minute ago",
      ]),
    ).toBeNull();
  });

  test("matches the banner for the app that posted its content", () => {
    const match = findBestNotificationMatch(
      loneBannerTray(),
      { title: BANNER.title, appId: "com.apple.Preferences", postedContents: () => [BANNER] },
      SETTINGS,
    );
    expect(match?.match.matches).toEqual({
      title: { text: BANNER.title, matchType: "exact" },
      app: { text: "Settings", matchType: "exact" },
    });
  });

  test("matches an appId-only query for the app that posted the banner", () => {
    const match = findBestNotificationMatch(
      loneBannerTray(),
      { appId: "com.apple.Preferences", postedContents: () => [BANNER] },
      SETTINGS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Settings", matchType: "exact" });
  });

  test("does not match when the app posted different content", () => {
    expect(
      findBestNotificationMatch(
        loneBannerTray(),
        {
          title: BANNER.title,
          appId: "com.apple.Preferences",
          postedContents: () => [{ title: BANNER.title, body: "another body" }],
        },
        SETTINGS,
      ),
    ).toBeNull();
  });

  test("does not take posted content that differs in case as ownership", () => {
    const posted = { title: BANNER.title.toUpperCase(), body: BANNER.body };
    expect(
      findBestNotificationMatch(
        loneBannerTray(),
        { title: BANNER.title, appId: "com.apple.Preferences", postedContents: () => [posted] },
        SETTINGS,
      ),
    ).toBeNull();
  });

  test("does not take a posted title and body swapped between fields as ownership", () => {
    const swapped = { title: BANNER.body, body: BANNER.title };
    expect(
      findBestNotificationMatch(
        loneBannerTray(),
        { title: BANNER.title, appId: "com.apple.Preferences", postedContents: () => [swapped] },
        SETTINGS,
      ),
    ).toBeNull();
  });

  test("matches a banner posted with a body alone", () => {
    const bodyOnly = { title: "", body: BANNER.body };
    const match = findBestNotificationMatch(
      loneBannerTray(),
      { body: BANNER.body, appId: "com.apple.Preferences", postedContents: () => [bodyOnly] },
      SETTINGS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Settings", matchType: "exact" });
  });

  test("does not attribute the banner to an app with no posted content", () => {
    const criteria = { title: BANNER.title, appId: "com.apple.MobileSMS" };
    expect(findBestNotificationMatch(loneBannerTray(), criteria, MESSAGES)).toBeNull();
    expect(findsContentOnUnattributedIosRow(loneBannerTray(), criteria)).toBe(true);
  });

  test("does not attribute the banner to an app named in its body", () => {
    const tray = JSON.parse(
      JSON.stringify(loneBannerTray()).replaceAll(BANNER.body, "Open Messages to reply."),
    ) as ViewHierarchyResult;
    expect(
      findBestNotificationMatch(tray, { title: BANNER.title, appId: "com.apple.MobileSMS" }, [
        ...MESSAGES,
      ]),
    ).toBeNull();
  });
});

describe("iOS tray with rows from two apps", () => {
  test("does not attribute a lone banner to another row's app", () => {
    const criteria = { title: BANNER.title, appId: "com.apple.MobileSMS" };
    expect(findBestNotificationMatch(twoAppTray(), criteria, MESSAGES)).toBeNull();
  });

  test("still matches the stacked row by its own app name", () => {
    const match = findBestNotificationMatch(
      twoAppTray(),
      { title: "mt0091c", appId: "com.apple.MobileSMS" },
      MESSAGES,
    );
    expect(match?.match.matches.app).toEqual({ text: "Messages", matchType: "exact" });
  });

  test("does not attribute the stacked row to the lone banner's app", () => {
    expect(
      findBestNotificationMatch(
        twoAppTray(),
        { title: "mt0091c", appId: "com.apple.Preferences", postedContents: () => [BANNER] },
        SETTINGS,
      ),
    ).toBeNull();
  });

  test("matches the lone banner beside a stack for the app that posted it", () => {
    const match = findBestNotificationMatch(
      twoAppTray(),
      { title: BANNER.title, appId: "com.apple.Preferences", postedContents: () => [BANNER] },
      SETTINGS,
    );
    expect(match?.match.matches.app).toEqual({ text: "Settings", matchType: "exact" });
  });

  test("reports no unattributed content match for a stacked row", () => {
    expect(
      findsContentOnUnattributedIosRow(twoAppTray(), {
        title: "mt0091c",
        appId: "com.apple.Preferences",
      }),
    ).toBe(false);
  });
});

describe("iOS stacked row app names", () => {
  test("attributes a stack whose app name has no letters", () => {
    // Derived from the capture: the Messages stack renamed to a digits-only app.
    const tray = JSON.parse(
      JSON.stringify(iosMessagesGroupedTray.viewHierarchy).replaceAll(
        "MESSAGES, Grouped",
        "123, Grouped",
      ),
    ) as ViewHierarchyResult;
    const match = findBestNotificationMatch(tray, { title: "mt0091c", appId: "com.example.n" }, [
      "123",
    ]);
    expect(match?.match.matches.app).toEqual({ text: "123", matchType: "exact" });
  });
});
