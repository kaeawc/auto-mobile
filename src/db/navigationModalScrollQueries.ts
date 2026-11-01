import { type Kysely } from "kysely";
import type { Database, UIElement, NewNodeModal, NewEdgeModal, NewScrollPosition } from "./types";
import type { NavigationQueryContext } from "./navigationRepositoryTypes";

export async function setNodeModals(
  ctx: NavigationQueryContext,
  nodeId: number,
  modalStack: string[],
): Promise<void> {
  const db = ctx.getDb();
  if (db.isTransaction) {
    return setNodeModalsWithin(db, nodeId, modalStack);
  }
  return db.transaction().execute((trx) => setNodeModalsWithin(trx, nodeId, modalStack));
}

async function setNodeModalsWithin(
  trx: Kysely<Database>,
  nodeId: number,
  modalStack: string[],
): Promise<void> {
  // Delete existing modals
  await trx.deleteFrom("node_modals").where("node_id", "=", nodeId).execute();

  if (modalStack.length === 0) {
    return;
  }

  // Insert new modals
  const values: NewNodeModal[] = modalStack.map((modalId, index) => ({
    node_id: nodeId,
    modal_identifier: modalId,
    stack_level: index,
  }));

  await trx.insertInto("node_modals").values(values).execute();
}

export async function getNodeModals(
  ctx: NavigationQueryContext,
  nodeId: number,
): Promise<string[]> {
  const db = ctx.getDb();
  const modals = await db
    .selectFrom("node_modals")
    .select("modal_identifier")
    .where("node_id", "=", nodeId)
    .orderBy("stack_level", "asc")
    .execute();

  return modals.map((m) => m.modal_identifier);
}

export async function setEdgeModals(
  ctx: NavigationQueryContext,
  edgeId: number,
  position: "from" | "to",
  modalStack: string[],
): Promise<void> {
  const db = ctx.getDb();
  if (db.isTransaction) {
    return setEdgeModalsWithin(db, edgeId, position, modalStack);
  }
  return db.transaction().execute((trx) => setEdgeModalsWithin(trx, edgeId, position, modalStack));
}

async function setEdgeModalsWithin(
  trx: Kysely<Database>,
  edgeId: number,
  position: "from" | "to",
  modalStack: string[],
): Promise<void> {
  // Delete existing modals for this position
  await trx
    .deleteFrom("edge_modals")
    .where("edge_id", "=", edgeId)
    .where("position", "=", position)
    .execute();

  if (modalStack.length === 0) {
    return;
  }

  // Insert new modals
  const values: NewEdgeModal[] = modalStack.map((modalId, index) => ({
    edge_id: edgeId,
    position,
    modal_identifier: modalId,
    stack_level: index,
  }));

  await trx.insertInto("edge_modals").values(values).execute();
}

export async function getEdgeModals(
  ctx: NavigationQueryContext,
  edgeId: number,
  position: "from" | "to",
): Promise<string[]> {
  const db = ctx.getDb();
  const modals = await db
    .selectFrom("edge_modals")
    .select("modal_identifier")
    .where("edge_id", "=", edgeId)
    .where("position", "=", position)
    .orderBy("stack_level", "asc")
    .execute();

  return modals.map((m) => m.modal_identifier);
}

export type ScrollPositionOptions = {
  containerElementId?: number;
  speed?: string;
  swipeCount?: number;
};

export async function setScrollPosition(
  ctx: NavigationQueryContext,
  edgeId: number,
  targetElementId: number,
  {
    direction,
    containerElementId,
    speed,
    swipeCount,
  }: ScrollPositionOptions & { direction: string },
): Promise<void> {
  const db = ctx.getDb();
  const scrollPos: NewScrollPosition = {
    edge_id: edgeId,
    target_element_id: targetElementId,
    container_element_id: containerElementId ?? null,
    direction,
    speed: speed ?? null,
    swipe_count: swipeCount ?? null,
  };

  if (db.isTransaction) {
    return setScrollPositionWithin(db, edgeId, scrollPos);
  }
  return db.transaction().execute((trx) => setScrollPositionWithin(trx, edgeId, scrollPos));
}

async function setScrollPositionWithin(
  trx: Kysely<Database>,
  edgeId: number,
  scrollPos: NewScrollPosition,
): Promise<void> {
  // Upsert: delete if exists, then insert
  await trx.deleteFrom("scroll_positions").where("edge_id", "=", edgeId).execute();

  await trx.insertInto("scroll_positions").values(scrollPos).execute();
}

export async function getScrollPosition(
  ctx: NavigationQueryContext,
  edgeId: number,
): Promise<{
  targetElement: UIElement;
  containerElement?: UIElement;
  direction: string;
  speed?: string;
  swipeCount?: number;
} | null> {
  const db = ctx.getDb();

  const result = await db
    .selectFrom("scroll_positions")
    .innerJoin("ui_elements as target", "target.id", "scroll_positions.target_element_id")
    .leftJoin("ui_elements as container", "container.id", "scroll_positions.container_element_id")
    .select([
      "scroll_positions.direction",
      "scroll_positions.speed",
      "scroll_positions.swipe_count",
    ])
    .selectAll("target")
    .select([
      "container.id as container_id",
      "container.text as container_text",
      "container.resource_id as container_resource_id",
      "container.content_description as container_content_description",
    ])
    .where("edge_id", "=", edgeId)
    .executeTakeFirst();

  if (!result) {
    return null;
  }

  const response: {
    targetElement: UIElement;
    containerElement?: UIElement;
    direction: string;
    speed?: string;
    swipeCount?: number;
  } = {
    targetElement: {
      id: result.id,
      app_id: result.app_id,
      text: result.text,
      resource_id: result.resource_id,
      content_description: result.content_description,
      class_name: result.class_name,
      bounds_left: result.bounds_left,
      bounds_top: result.bounds_top,
      bounds_right: result.bounds_right,
      bounds_bottom: result.bounds_bottom,
      clickable: result.clickable,
      scrollable: result.scrollable,
      first_seen_at: result.first_seen_at,
      last_seen_at: result.last_seen_at,
      created_at: result.created_at,
    },
    direction: result.direction,
    speed: result.speed ?? undefined,
    swipeCount: result.swipe_count ?? undefined,
  };

  // Add container element if present
  if (result.container_id) {
    response.containerElement = {
      id: result.container_id,
      app_id: result.app_id, // Same app
      text: result.container_text,
      resource_id: result.container_resource_id,
      content_description: result.container_content_description,
      class_name: null,
      bounds_left: null,
      bounds_top: null,
      bounds_right: null,
      bounds_bottom: null,
      clickable: null,
      scrollable: null,
      first_seen_at: 0,
      last_seen_at: 0,
      created_at: "",
    };
  }

  return response;
}
