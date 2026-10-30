import type { NavigationRepository } from "../../db/navigationRepository";
import type { ScrollPosition, SelectedElement } from "../../utils/interfaces/NavigationGraph";

/** Immutable provenance snapshot captured once per event and shared by its writes (#4984). */
export interface ResolvedProvenance {
  versionCode: number;
  contentHash: string;
  deviceId: string;
  sessionUuid: string;
}

/**
 * Record a per-node provenance observation inside the caller's transaction
 * (#4984). Must run on the transaction-bound repository so it commits atomically
 * with the node mutation, using the caller's pre-captured provenance snapshot.
 */
export async function recordNodeProvenance(
  repository: NavigationRepository,
  appId: string,
  nodeId: number,
  timestamp: number,
  provenance: ResolvedProvenance,
): Promise<void> {
  const buildKey = await repository.getOrCreateBuildKey(
    appId,
    provenance.versionCode,
    provenance.contentHash,
  );
  await repository.recordNodeObservation(
    nodeId,
    buildKey.id,
    provenance.deviceId,
    provenance.sessionUuid,
    timestamp,
  );
}

/**
 * Record a per-edge provenance observation inside the caller's transaction (#4984),
 * using the same provenance snapshot as the node write for that transition.
 */
export async function recordEdgeProvenance(
  repository: NavigationRepository,
  appId: string,
  edgeId: number,
  timestamp: number,
  provenance: ResolvedProvenance,
): Promise<void> {
  const buildKey = await repository.getOrCreateBuildKey(
    appId,
    provenance.versionCode,
    provenance.contentHash,
  );
  await repository.recordEdgeObservation(
    edgeId,
    buildKey.id,
    provenance.deviceId,
    provenance.sessionUuid,
    timestamp,
  );
}

/**
 * Store UI elements used in an edge transition.
 *
 * `repository` is the transaction-bound repository from the enclosing
 * recordNavigationEvent write, so these element writes are part of the same
 * atomic transaction. getOrCreateUIElement runs directly on the executor (it
 * detects it is already inside a transaction) rather than opening a nested one.
 */
export async function storeUIElements(
  repository: NavigationRepository,
  appId: string | null,
  edgeId: number,
  selectedElements: SelectedElement[],
  timestamp: number,
): Promise<void> {
  if (!appId || selectedElements.length === 0) {
    return;
  }

  const elementIds: number[] = [];

  for (const selected of selectedElements) {
    const element = await repository.getOrCreateUIElement(
      appId,
      {
        text: selected.text,
        resourceId: selected.resourceId,
        contentDescription: selected.contentDesc,
      },
      timestamp,
    );
    elementIds.push(element.id);
  }

  await repository.linkUIElementsToEdge(edgeId, elementIds);
}

/**
 * Store scroll position for an edge.
 *
 * `repository` is the transaction-bound repository from the enclosing
 * recordNavigationEvent write, so these writes are part of the same atomic
 * transaction.
 */
export async function storeScrollPosition(
  repository: NavigationRepository,
  appId: string | null,
  edgeId: number,
  scrollPosition: ScrollPosition,
  timestamp: number,
): Promise<void> {
  if (!appId) {
    return;
  }

  // Store the target element
  const targetElement = await repository.getOrCreateUIElement(
    appId,
    {
      text: scrollPosition.targetElement.text,
      resourceId: scrollPosition.targetElement.resourceId,
      contentDescription: scrollPosition.targetElement.contentDesc,
    },
    timestamp,
  );

  // Store the container element if present
  let containerElementId: number | undefined;
  if (scrollPosition.container) {
    const containerElement = await repository.getOrCreateUIElement(
      appId,
      {
        text: scrollPosition.container.text,
        resourceId: scrollPosition.container.resourceId,
        contentDescription: scrollPosition.container.contentDesc,
      },
      timestamp,
    );
    containerElementId = containerElement.id;
  }

  await repository.setScrollPosition(edgeId, targetElement.id, scrollPosition.direction, {
    containerElementId,
    speed: scrollPosition.speed,
  });
}
