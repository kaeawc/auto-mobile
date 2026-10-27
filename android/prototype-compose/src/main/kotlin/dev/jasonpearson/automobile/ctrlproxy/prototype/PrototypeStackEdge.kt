package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStackTransition

/** Entry-owned navigation metadata; popping a nested destination restores its own source. */
@InternalAutoMobilePrototypeApi
data class PrototypeStackEdge(
  val screen: String,
  val transition: PrototypeStackTransition?,
  val source: String?,
)

internal fun PrototypeRuntimeSnapshot.stackPopChange(id: String): PrototypeStackChange {
  val path = stacks.getValue(id).path
  val edge =
    stackEdges[id]?.lastOrNull()?.takeIf {
      it.screen == path.last() && it.transition == PrototypeStackTransition.ZOOM
    }
  return PrototypeStackChange(
    id,
    "pop",
    edge?.transition,
    (stackChange?.sequence ?: 0) + 1,
    edge?.source,
    path.lastIndex to path.last(),
  )
}

internal fun PrototypeRuntimeSnapshot.stackNavigationChange(
  id: String,
  direction: String,
  edge: PrototypeStackEdge,
  path: List<String>,
): PrototypeStackChange =
  if (direction == "pop") stackPopChange(id)
  else
    PrototypeStackChange(
      id,
      direction,
      edge.transition,
      (stackChange?.sequence ?: 0) + 1,
      edge.source,
      path.lastIndex to path.last(),
    )

internal fun PrototypeRuntimeSnapshot.nextStackEdges(
  id: String,
  direction: String,
  edge: PrototypeStackEdge,
  path: List<String>,
): List<PrototypeStackEdge> {
  val before = stacks.getValue(id).path
  val edges = before.mapIndexed { index, screen ->
    stackEdges[id]?.getOrNull(index)?.takeIf { it.screen == screen }
      ?: PrototypeStackEdge(screen, null, null)
  }
  return if (direction == "pop") edges.take(path.size) else edges.take(path.size - 1) + edge
}

/** A same-id show/patch keeps only metadata whose complete entry prefix survived. */
internal fun PrototypeRuntimeSnapshot.retainedStackEdges(
  next: Map<String, dev.jasonpearson.automobile.protocol.PrototypeStackSnapshot>,
): Map<String, List<PrototypeStackEdge>> = next.mapValues { (id, stack) ->
  val retained = stacks[id]?.path.orEmpty().zip(stack.path).takeWhile { it.first == it.second }.size
  stackEdges[id].orEmpty().take(retained)
}
