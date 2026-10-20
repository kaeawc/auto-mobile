import { type Kysely } from "kysely";
import type { Database, NewUIElement, UIElement, NewEdgeUIElement } from "./types";
import type { NavigationQueryContext } from "./navigationRepositoryTypes";

export async function getOrCreateUIElement(
  ctx: NavigationQueryContext,
  appId: string,
  element: {
    text?: string;
    resourceId?: string;
    contentDescription?: string;
    className?: string;
    bounds?: { left: number; top: number; right: number; bottom: number };
    clickable?: boolean;
    scrollable?: boolean;
  },
  timestamp: number,
): Promise<UIElement> {
  const db = ctx.getDb();

  // ui_elements has no UNIQUE index and matching is on a *dynamic* subset of columns,
  // so this get-or-create cannot be expressed as a single onConflict upsert. Wrap the
  // SELECT-then-INSERT/UPDATE in a transaction instead: BEGIN takes exclusive ownership
  // of the single connection (bunSqliteDialect #reserveTransaction), so concurrent
  // callers for the same element serialize rather than both inserting duplicate rows
  // (R2356). Keep the body to DB reads/writes only — no IO — since it blocks the daemon
  // for its duration.
  //
  // When this repo is already bound to a caller's transaction (via withExecutor),
  // opening another transaction would be a nested BEGIN on the same connection —
  // `#reserveTransaction` throws "Nested transactions are not supported". Run the
  // body directly on the existing executor instead; it is already serialized and
  // atomic under the enclosing transaction.
  if (db.isTransaction) {
    return getOrCreateUIElementWithin(db, appId, element, timestamp);
  }
  return db
    .transaction()
    .execute((trx) => getOrCreateUIElementWithin(trx, appId, element, timestamp));
}

function buildUIElementBounds(element: {
  bounds?: { left: number; top: number; right: number; bottom: number };
}): Pick<NewUIElement, "bounds_left" | "bounds_top" | "bounds_right" | "bounds_bottom"> {
  return {
    bounds_left: element.bounds?.left ?? null,
    bounds_top: element.bounds?.top ?? null,
    bounds_right: element.bounds?.right ?? null,
    bounds_bottom: element.bounds?.bottom ?? null,
  };
}

function buildUIElement(
  appId: string,
  element: {
    text?: string;
    resourceId?: string;
    contentDescription?: string;
    className?: string;
    bounds?: { left: number; top: number; right: number; bottom: number };
    clickable?: boolean;
    scrollable?: boolean;
  },
  timestamp: number,
): NewUIElement {
  return {
    app_id: appId,
    text: element.text ?? null,
    resource_id: element.resourceId ?? null,
    content_description: element.contentDescription ?? null,
    class_name: element.className ?? null,
    ...buildUIElementBounds(element),
    clickable: element.clickable !== undefined ? (element.clickable ? 1 : 0) : null,
    scrollable: element.scrollable !== undefined ? (element.scrollable ? 1 : 0) : null,
    first_seen_at: timestamp,
    last_seen_at: timestamp,
  };
}

async function getOrCreateUIElementWithin(
  trx: Kysely<Database>,
  appId: string,
  element: {
    text?: string;
    resourceId?: string;
    contentDescription?: string;
    className?: string;
    bounds?: { left: number; top: number; right: number; bottom: number };
    clickable?: boolean;
    scrollable?: boolean;
  },
  timestamp: number,
): Promise<UIElement> {
  // Try to find existing element with same properties
  let query = trx.selectFrom("ui_elements").selectAll().where("app_id", "=", appId);

  if (element.text !== undefined) {
    query = query.where("text", "=", element.text);
  }
  if (element.resourceId !== undefined) {
    query = query.where("resource_id", "=", element.resourceId);
  }
  if (element.contentDescription !== undefined) {
    query = query.where("content_description", "=", element.contentDescription);
  }
  if (element.className !== undefined) {
    query = query.where("class_name", "=", element.className);
  }
  if (element.bounds) {
    query = query
      .where("bounds_left", "=", element.bounds.left)
      .where("bounds_top", "=", element.bounds.top)
      .where("bounds_right", "=", element.bounds.right)
      .where("bounds_bottom", "=", element.bounds.bottom);
  }

  const existing = await query.executeTakeFirst();

  if (existing) {
    // Update last_seen_at
    await trx
      .updateTable("ui_elements")
      .set({ last_seen_at: timestamp })
      .where("id", "=", existing.id)
      .execute();

    return {
      ...existing,
      last_seen_at: timestamp,
    };
  }

  // Create new UI element
  const newElement = buildUIElement(appId, element, timestamp);

  const result = await trx
    .insertInto("ui_elements")
    .values(newElement)
    .returningAll()
    .executeTakeFirstOrThrow();

  return result;
}

export async function linkUIElementsToEdge(
  ctx: NavigationQueryContext,
  edgeId: number,
  uiElementIds: number[],
): Promise<void> {
  if (uiElementIds.length === 0) {
    return;
  }

  const db = ctx.getDb();
  // storeUIElements calls this on a repository already bound to the enclosing
  // recordNavigationEvent transaction (via withExecutor), so opening a nested
  // `db.transaction()` would throw "Nested transactions are not supported" —
  // mirrors the db.isTransaction guard in getOrCreateUIElement/promoteSuggestion.
  if (db.isTransaction) {
    return linkUIElementsToEdgeWithin(db, edgeId, uiElementIds);
  }
  return db.transaction().execute((trx) => linkUIElementsToEdgeWithin(trx, edgeId, uiElementIds));
}

async function linkUIElementsToEdgeWithin(
  trx: Kysely<Database>,
  edgeId: number,
  uiElementIds: number[],
): Promise<void> {
  // Read what this edge already links, inside the transaction, so new elements
  // are appended AFTER the current maximum selection_order rather than restarting
  // at zero. Restarting collided on order across calls: linking [A,B] then [B,C]
  // gave both B and C order 1, so getUIElementsForEdge()'s `ORDER BY
  // selection_order` could not preserve a stable observation order.
  const existing = await trx
    .selectFrom("edge_ui_elements")
    .select(["ui_element_id", "selection_order"])
    .where("edge_id", "=", edgeId)
    .execute();
  const existingIds = new Set<number>(existing.map((row) => row.ui_element_id));
  let nextOrder = existing.reduce((max, row) => Math.max(max, row.selection_order), -1) + 1;

  // De-dupe within this call, and skip pairs already linked (they keep their
  // recorded order). Two ids resolving to the same ui_elements row must not
  // produce two rows for one (edge_id, ui_element_id) pair.
  const seen = new Set<number>();
  const values: NewEdgeUIElement[] = [];
  for (const uiElementId of uiElementIds) {
    if (seen.has(uiElementId) || existingIds.has(uiElementId)) {
      continue;
    }
    seen.add(uiElementId);
    values.push({
      edge_id: edgeId,
      ui_element_id: uiElementId,
      selection_order: nextOrder++,
    });
  }

  if (values.length === 0) {
    return;
  }

  // onConflict is retained as a safety net against a concurrent inserter racing
  // the same pair between the read above and this insert; it keeps the
  // first-recorded row, matching the "leave existing identity alone on conflict"
  // convention used elsewhere in this file's onConflict upserts (e.g. getOrCreateApp).
  await trx
    .insertInto("edge_ui_elements")
    .values(values)
    .onConflict((oc) => oc.columns(["edge_id", "ui_element_id"]).doNothing())
    .execute();
}

export async function getUIElementsForEdge(
  ctx: NavigationQueryContext,
  edgeId: number,
): Promise<UIElement[]> {
  const db = ctx.getDb();
  return db
    .selectFrom("edge_ui_elements")
    .innerJoin("ui_elements", "ui_elements.id", "edge_ui_elements.ui_element_id")
    .selectAll("ui_elements")
    .where("edge_id", "=", edgeId)
    .orderBy("selection_order", "asc")
    .execute();
}
