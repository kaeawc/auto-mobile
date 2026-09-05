import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { createTestDatabase } from "./testDbHelper";
import { withInMemorySingletonDatabase } from "./inMemorySingletonDatabase";

describe("NavigationRepository", () => {
  let db: Kysely<Database>;
  let repo: NavigationRepository;

  beforeEach(async () => {
    // foreignKeys ON so clearApp's cascade deletes fire, matching production.
    db = await createTestDatabase({ foreignKeys: true });
    repo = new NavigationRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("getOrCreateApp", () => {
    test("creates a new app record", async () => {
      const app = await repo.getOrCreateApp("com.example.app");

      expect(app.app_id).toBe("com.example.app");
      expect(app.updated_at).toBeDefined();
      expect(app.created_at).toBeDefined();
    });

    test("returns existing app on second call", async () => {
      const first = await repo.getOrCreateApp("com.example.app");
      const second = await repo.getOrCreateApp("com.example.app");

      expect(second.app_id).toBe(first.app_id);
      // The existing record is returned from DB, so updated_at should match
      expect(second.updated_at).toBe(first.updated_at);
    });
  });

  describe("getOrCreateNode", () => {
    test("creates a new node with visit_count=1", async () => {
      await repo.getOrCreateApp("com.example.app");
      const node = await repo.getOrCreateNode("com.example.app", "HomeScreen", 1000);

      expect(node.app_id).toBe("com.example.app");
      expect(node.screen_name).toBe("HomeScreen");
      expect(node.visit_count).toBe(1);
      expect(node.first_seen_at).toBe(1000);
      expect(node.last_seen_at).toBe(1000);
    });

    test("returns existing node with incremented visit_count", async () => {
      await repo.getOrCreateApp("com.example.app");
      const first = await repo.getOrCreateNode("com.example.app", "HomeScreen", 1000);
      const second = await repo.getOrCreateNode("com.example.app", "HomeScreen", 2000);

      expect(second.id).toBe(first.id);
      expect(second.visit_count).toBe(2);
      expect(second.first_seen_at).toBe(1000);
      expect(second.last_seen_at).toBe(2000);
    });
  });

  describe("getNode", () => {
    test("returns node by app and screen name", async () => {
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "LoginScreen", 1000);

      const node = await repo.getNode("com.example.app", "LoginScreen");
      expect(node).toBeDefined();
      expect(node!.screen_name).toBe("LoginScreen");
    });

    test("returns undefined for nonexistent node", async () => {
      const node = await repo.getNode("com.example.app", "NoScreen");
      expect(node).toBeUndefined();
    });
  });

  describe("getNodeById", () => {
    test("returns node by app and ID", async () => {
      await repo.getOrCreateApp("com.example.app");
      const created = await repo.getOrCreateNode("com.example.app", "HomeScreen", 1000);

      const node = await repo.getNodeById("com.example.app", created.id);
      expect(node).toBeDefined();
      expect(node!.screen_name).toBe("HomeScreen");
    });

    test("returns undefined for wrong app ID", async () => {
      await repo.getOrCreateApp("com.example.app");
      const created = await repo.getOrCreateNode("com.example.app", "HomeScreen", 1000);

      const node = await repo.getNodeById("com.other.app", created.id);
      expect(node).toBeUndefined();
    });
  });

  describe("createEdge", () => {
    test("creates edge between screens", async () => {
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "Login", 1000);
      await repo.getOrCreateNode("com.example.app", "Home", 1000);

      const edge = await repo.createEdge(
        "com.example.app",
        "Login",
        "Home",
        "tapOn",
        { element: "loginButton" },
        2000,
      );

      expect(edge.app_id).toBe("com.example.app");
      expect(edge.from_screen).toBe("Login");
      expect(edge.to_screen).toBe("Home");
      expect(edge.tool_name).toBe("tapOn");
      expect(edge.tool_args).toBe(JSON.stringify({ element: "loginButton" }));
      expect(edge.timestamp).toBe(2000);
    });

    test("creates edge with null tool_name", async () => {
      await repo.getOrCreateApp("com.example.app");

      const edge = await repo.createEdge("com.example.app", "Login", "Home", null, null, 2000);

      expect(edge.tool_name).toBeNull();
      expect(edge.tool_args).toBeNull();
    });
  });

  describe("getEdges", () => {
    test("returns all edges for an app ordered by timestamp", async () => {
      await repo.getOrCreateApp("com.example.app");

      await repo.createEdge("com.example.app", "A", "B", "tapOn", null, 1000);
      await repo.createEdge("com.example.app", "B", "C", "swipeOn", null, 2000);

      const edges = await repo.getEdges("com.example.app");
      expect(edges).toHaveLength(2);
      expect(edges[0].from_screen).toBe("A");
      expect(edges[1].from_screen).toBe("B");
    });

    test("returns empty for app with no edges", async () => {
      const edges = await repo.getEdges("com.nonexistent.app");
      expect(edges).toHaveLength(0);
    });
  });

  describe("getNodes", () => {
    test("returns all nodes for an app", async () => {
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "ScreenA", 1000);
      await repo.getOrCreateNode("com.example.app", "ScreenB", 2000);

      const nodes = await repo.getNodes("com.example.app");
      expect(nodes).toHaveLength(2);
      // Ordered by screen_name asc
      expect(nodes[0].screen_name).toBe("ScreenA");
      expect(nodes[1].screen_name).toBe("ScreenB");
    });

    test("returns empty for app with no nodes", async () => {
      const nodes = await repo.getNodes("com.nonexistent.app");
      expect(nodes).toHaveLength(0);
    });
  });

  describe("getOrCreateUIElement", () => {
    test("creates a new UI element", async () => {
      await repo.getOrCreateApp("com.example.app");
      const element = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Login", resourceId: "btn_login", clickable: true },
        1000,
      );

      expect(element.text).toBe("Login");
      expect(element.resource_id).toBe("btn_login");
      expect(element.clickable).toBe(1);
      expect(element.first_seen_at).toBe(1000);
      expect(element.last_seen_at).toBe(1000);
    });

    test("returns existing element with updated last_seen_at", async () => {
      await repo.getOrCreateApp("com.example.app");
      const first = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Login", resourceId: "btn_login" },
        1000,
      );
      const second = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Login", resourceId: "btn_login" },
        2000,
      );

      expect(second.id).toBe(first.id);
      expect(second.first_seen_at).toBe(1000);
      expect(second.last_seen_at).toBe(2000);
    });

    test("matches an existing row on re-tap of an element with empty-string text (issue #6130)", async () => {
      await repo.getOrCreateApp("com.example.app");
      const first = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "", resourceId: "icon_button" },
        1000,
      );
      const second = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "", resourceId: "icon_button" },
        2000,
      );

      expect(second.id).toBe(first.id);
      expect(first.text).toBe("");
      expect(second.last_seen_at).toBe(2000);
    });

    test("matches an existing row on re-tap of an element with a 0 bound (issue #6130)", async () => {
      await repo.getOrCreateApp("com.example.app");
      const bounds = { left: 0, top: 0, right: 100, bottom: 40 };
      const first = await repo.getOrCreateUIElement(
        "com.example.app",
        { resourceId: "top_left_anchor", bounds },
        1000,
      );
      const second = await repo.getOrCreateUIElement(
        "com.example.app",
        { resourceId: "top_left_anchor", bounds },
        2000,
      );

      expect(second.id).toBe(first.id);
      expect(first.bounds_left).toBe(0);
      expect(first.bounds_top).toBe(0);
      expect(second.last_seen_at).toBe(2000);
    });

    test("a genuinely different element still creates a distinct row", async () => {
      await repo.getOrCreateApp("com.example.app");
      const first = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "", resourceId: "icon_button" },
        1000,
      );
      const other = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Other", resourceId: "icon_button" },
        1000,
      );

      expect(other.id).not.toBe(first.id);
    });
  });

  describe("setNodeModals / getNodeModals", () => {
    test("sets and retrieves modal stack for a node", async () => {
      await repo.getOrCreateApp("com.example.app");
      const node = await repo.getOrCreateNode("com.example.app", "Home", 1000);

      await repo.setNodeModals(node.id, ["dialog_a", "dialog_b"]);

      const modals = await repo.getNodeModals(node.id);
      expect(modals).toEqual(["dialog_a", "dialog_b"]);
    });

    test("replaces modal stack on second set", async () => {
      await repo.getOrCreateApp("com.example.app");
      const node = await repo.getOrCreateNode("com.example.app", "Home", 1000);

      await repo.setNodeModals(node.id, ["dialog_a"]);
      await repo.setNodeModals(node.id, ["dialog_x", "dialog_y"]);

      const modals = await repo.getNodeModals(node.id);
      expect(modals).toEqual(["dialog_x", "dialog_y"]);
    });
  });

  describe("setScrollPosition / getScrollPosition", () => {
    test("sets and retrieves scroll position for an edge", async () => {
      await repo.getOrCreateApp("com.example.app");
      const edge = await repo.createEdge("com.example.app", "A", "B", "swipeOn", null, 1000);
      const target = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Target", resourceId: "target_elem" },
        1000,
      );

      await repo.setScrollPosition(edge.id, target.id, "down", undefined, "slow", 3);

      const scroll = await repo.getScrollPosition(edge.id);
      expect(scroll).toBeDefined();
      expect(scroll!.direction).toBe("down");
      expect(scroll!.speed).toBe("slow");
      expect(scroll!.swipeCount).toBe(3);
      expect(scroll!.targetElement.id).toBe(target.id);
    });

    test("preserves a swipeCount of 0 (issue #6130)", async () => {
      await repo.getOrCreateApp("com.example.app");
      const edge = await repo.createEdge("com.example.app", "A", "B", "swipeOn", null, 1000);
      const target = await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Target", resourceId: "target_elem" },
        1000,
      );

      await repo.setScrollPosition(edge.id, target.id, "down", undefined, "slow", 0);

      const scroll = await repo.getScrollPosition(edge.id);
      expect(scroll!.swipeCount).toBe(0);
    });
  });

  describe("clearApp", () => {
    test("cascade-deletes the entire graph, not just the app record", async () => {
      // Seed every child table so a missing cascade would leave orphans behind.
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "Home", 1000);
      await repo.getOrCreateNode("com.example.app", "Settings", 1000);
      await repo.createEdge("com.example.app", "Home", "Settings", "tapOn", null, 2000);
      await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Login", resourceId: "btn_login" },
        1000,
      );
      await repo.addOrUpdateSuggestion("com.example.app", "hash-abc", "{}", 1000);

      await repo.clearApp("com.example.app");

      const countIn = async (
        table:
          | "navigation_apps"
          | "navigation_nodes"
          | "navigation_edges"
          | "ui_elements"
          | "navigation_suggestions",
      ): Promise<number> => {
        const rows = await db
          .selectFrom(table)
          .selectAll()
          .where("app_id", "=", "com.example.app")
          .execute();
        return rows.length;
      };

      // The app row and every FK-dependent row are gone; nothing leaks back.
      expect(await countIn("navigation_apps")).toBe(0);
      expect(await countIn("navigation_nodes")).toBe(0);
      expect(await countIn("navigation_edges")).toBe(0);
      expect(await countIn("ui_elements")).toBe(0);
      expect(await countIn("navigation_suggestions")).toBe(0);
    });
  });

  describe("updateNodeVisit", () => {
    test("increments visit_count and updates last_seen_at", async () => {
      await repo.getOrCreateApp("com.example.app");
      const node = await repo.getOrCreateNode("com.example.app", "Home", 1000);
      expect(node.visit_count).toBe(1);

      await repo.updateNodeVisit(node.id, 5000);

      const updated = await repo.getNodeById("com.example.app", node.id);
      expect(updated).toBeDefined();
      expect(updated!.visit_count).toBe(2);
      expect(updated!.last_seen_at).toBe(5000);
    });
  });

  describe("concurrency (R2356)", () => {
    const N = 10;

    test("N concurrent getOrCreateApp yield one row and never reject", async () => {
      await expect(
        Promise.all(Array.from({ length: N }, () => repo.getOrCreateApp("com.example.app"))),
      ).resolves.toBeDefined();

      const apps = await db
        .selectFrom("navigation_apps")
        .selectAll()
        .where("app_id", "=", "com.example.app")
        .execute();
      expect(apps).toHaveLength(1);
    });

    test("N concurrent getOrCreateNode yield one row with visit_count === N and return the row id", async () => {
      await repo.getOrCreateApp("com.example.app");

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          repo.getOrCreateNode("com.example.app", "HomeScreen", 1000),
        ),
      );

      const nodes = await repo.getNodes("com.example.app");
      expect(nodes).toHaveLength(1);
      expect(nodes[0].visit_count).toBe(N);

      // Every returned value carries the same row id (the get-or-create contract).
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(results.every((r) => r.id === nodes[0].id)).toBe(true);
    });

    test("N concurrent addOrUpdateSuggestion yield one row with occurrence_count === N and never reject", async () => {
      await repo.getOrCreateApp("com.example.app");

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          repo.addOrUpdateSuggestion("com.example.app", "hash-abc", "{}", 1000),
        ),
      );

      const suggestions = await repo.getSuggestions("com.example.app");
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].occurrence_count).toBe(N);
      expect(results.every((r) => r.id === suggestions[0].id)).toBe(true);
    });

    test("N concurrent getOrCreateFingerprint yield one row with occurrence_count === N and never reject", async () => {
      await repo.getOrCreateApp("com.example.app");
      const node = await repo.getOrCreateNode("com.example.app", "HomeScreen", 1000);

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          repo.getOrCreateFingerprint("com.example.app", node.id, "fp-hash", "{}", 1000),
        ),
      );

      const fingerprints = await repo.getFingerprintsForNode(node.id);
      expect(fingerprints).toHaveLength(1);
      expect(fingerprints[0].occurrence_count).toBe(N);
      expect(results.every((r) => r.id === fingerprints[0].id)).toBe(true);
    });

    test("N concurrent getOrCreateUIElement for one element yield one row and one id", async () => {
      await repo.getOrCreateApp("com.example.app");

      const results = await Promise.all(
        Array.from({ length: N }, (_unused, i) =>
          repo.getOrCreateUIElement(
            "com.example.app",
            { text: "Login", resourceId: "btn_login" },
            1000 + i,
          ),
        ),
      );

      const elements = await db
        .selectFrom("ui_elements")
        .selectAll()
        .where("app_id", "=", "com.example.app")
        .execute();
      expect(elements).toHaveLength(1);
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect(results[0].id).toBe(elements[0].id);
    });
  });

  describe("getStats", () => {
    test("returns correct counts", async () => {
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "A", 1000);
      await repo.getOrCreateNode("com.example.app", "B", 1000);
      await repo.createEdge("com.example.app", "A", "B", "tapOn", null, 2000);
      await repo.createEdge("com.example.app", "B", "A", null, null, 3000);

      const stats = await repo.getStats("com.example.app");
      expect(stats.nodeCount).toBe(2);
      expect(stats.edgeCount).toBe(2);
      expect(stats.toolEdgeCount).toBe(1);
      expect(stats.unknownEdgeCount).toBe(1);
    });
  });

  describe("clearAppGraph", () => {
    test("clears all four graph tables but keeps the app record", async () => {
      // Seed nodes, edges, ui_elements and navigation_suggestions so that a
      // dropped delete on any of the four tables leaves rows behind.
      await repo.getOrCreateApp("com.example.app");
      await repo.getOrCreateNode("com.example.app", "Home", 1000);
      await repo.createEdge("com.example.app", "Home", "Settings", "tapOn", null, 2000);
      await repo.getOrCreateUIElement(
        "com.example.app",
        { text: "Login", resourceId: "btn_login" },
        1000,
      );
      await repo.addOrUpdateSuggestion("com.example.app", "hash-abc", "{}", 1000);

      await repo.clearAppGraph("com.example.app");

      expect(await repo.getNodes("com.example.app")).toHaveLength(0);
      expect(await repo.getEdges("com.example.app")).toHaveLength(0);

      const uiElements = await db
        .selectFrom("ui_elements")
        .selectAll()
        .where("app_id", "=", "com.example.app")
        .execute();
      expect(uiElements).toHaveLength(0);

      const suggestions = await repo.getSuggestions("com.example.app");
      expect(suggestions).toHaveLength(0);

      // App record is preserved.
      const app = await db
        .selectFrom("navigation_apps")
        .selectAll()
        .where("app_id", "=", "com.example.app")
        .executeTakeFirst();
      expect(app).toBeDefined();
    });
  });

  describe("resolveConnection", () => {
    test("returns the bound executor for a repo constructed with a db", () => {
      const bound = new NavigationRepository(db);
      expect(bound.resolveConnection()).toBe(db);
    });

    test("returns the shared singleton for an unbound repo", async () => {
      // Two independently-constructed unbound repos must resolve to the SAME
      // getDatabase() singleton so a connection-identity check between them holds.
      // Redirect the singleton to `:memory:` so the unit-test DB guard (issue
      // #3067) permits resolving it here (the assertion is about singleton
      // identity, not the on-disk file).
      await withInMemorySingletonDatabase(() => {
        const a = new NavigationRepository();
        const b = new NavigationRepository();
        expect(a.resolveConnection()).toBe(b.resolveConnection());
      });
    });

    test("withExecutor rebinds the resolved connection to a different executor", async () => {
      // Rebinding to the *same* db would pass even if withExecutor were a no-op.
      // Rebind to a genuinely different connection to prove the swap happens.
      const other = await createTestDatabase();
      try {
        const bound = repo.withExecutor(other);
        expect(bound.resolveConnection()).toBe(other);
        expect(bound.resolveConnection()).not.toBe(db);
        // The original repo is left untouched.
        expect(repo.resolveConnection()).toBe(db);
      } finally {
        await other.destroy();
      }
    });
  });

  describe("getEdgesPage", () => {
    const seedEdges = async (timestamps: number[]): Promise<void> => {
      await repo.getOrCreateApp("com.example.app");
      for (const ts of timestamps) {
        await repo.createEdge("com.example.app", "A", "B", "tapOn", null, ts);
      }
    };

    test("returns an empty page with hasMore false when there are no edges", async () => {
      await repo.getOrCreateApp("com.example.app");

      const page = await repo.getEdgesPage("com.example.app", { limit: 10 });

      expect(page.edges).toHaveLength(0);
      expect(page.hasMore).toBe(false);
    });

    test("returns the first page and signals hasMore when more rows remain", async () => {
      await seedEdges([1000, 2000, 3000]);

      const page = await repo.getEdgesPage("com.example.app", { limit: 2 });

      expect(page.edges.map((e) => e.timestamp)).toEqual([1000, 2000]);
      expect(page.hasMore).toBe(true);
    });

    test("signals hasMore false on the final page", async () => {
      await seedEdges([1000, 2000]);

      const page = await repo.getEdgesPage("com.example.app", { limit: 2 });

      expect(page.edges).toHaveLength(2);
      expect(page.hasMore).toBe(false);
    });

    test("walks every edge exactly once when timestamps are shared across a page boundary", async () => {
      // Four edges at the SAME timestamp: paging by timestamp alone would either
      // skip the tail or loop forever. The (timestamp, id) keyset cursor must
      // step past each edge deterministically.
      await seedEdges([1000, 1000, 1000, 1000]);

      const seenIds: number[] = [];
      let cursor: { timestamp: number; id: number } | null = null;
      // Bound the loop so a broken cursor predicate cannot hang the test.
      for (let guard = 0; guard < 10; guard++) {
        const page = await repo.getEdgesPage("com.example.app", { cursor, limit: 2 });
        for (const edge of page.edges) {
          seenIds.push(edge.id);
        }
        if (!page.hasMore || page.edges.length === 0) {
          break;
        }
        const last = page.edges[page.edges.length - 1];
        cursor = { timestamp: last.timestamp, id: last.id };
      }

      // All four edges visited, each exactly once, no duplicates, no skips.
      expect(seenIds).toHaveLength(4);
      expect(new Set(seenIds).size).toBe(4);
    });
  });

  describe("listApps", () => {
    test("returns an empty list when no apps exist", async () => {
      const apps = await repo.listApps();
      expect(apps).toEqual([]);
    });

    test("returns distinct apps that have persisted nodes, newest-updated first", async () => {
      await repo.getOrCreateApp("com.example.a");
      await repo.getOrCreateNode("com.example.a", "HomeA", 1000);
      await repo.getOrCreateApp("com.example.b");
      await repo.getOrCreateNode("com.example.b", "HomeB", 1000);
      // Revisiting a screen must not duplicate the app row.
      await repo.getOrCreateNode("com.example.b", "HomeB", 2000);

      // Pin distinct updated_at values so ordering is deterministic.
      await db
        .updateTable("navigation_apps")
        .set({ updated_at: "2026-01-01T00:00:00.000Z" })
        .where("app_id", "=", "com.example.a")
        .execute();
      await db
        .updateTable("navigation_apps")
        .set({ updated_at: "2026-01-02T00:00:00.000Z" })
        .where("app_id", "=", "com.example.b")
        .execute();

      const apps = await repo.listApps();

      expect(apps).toEqual([
        { app_id: "com.example.b", updated_at: "2026-01-02T00:00:00.000Z" },
        { app_id: "com.example.a", updated_at: "2026-01-01T00:00:00.000Z" },
      ]);
    });

    test("excludes apps that have no persisted nodes", async () => {
      // Bare app row with no recorded screens (e.g. setCurrentApp only).
      await repo.getOrCreateApp("com.example.empty");
      await repo.getOrCreateApp("com.example.withnodes");
      await repo.getOrCreateNode("com.example.withnodes", "Home", 1000);

      const apps = await repo.listApps();

      expect(apps).toHaveLength(1);
      expect(apps[0]?.app_id).toBe("com.example.withnodes");
    });
  });
});
