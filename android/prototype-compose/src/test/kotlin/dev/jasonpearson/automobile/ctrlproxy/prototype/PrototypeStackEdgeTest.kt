package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeStackEdgeTest {
  @Test
  fun `zoom action override retains its source and destination for pop`() {
    val snapshot = snapshot()
    val change = snapshot.stackPopChange("nav")
    assertEquals(PrototypeStackTransition.ZOOM, change.override)
    assertEquals("hero", change.source)
    assertEquals(1 to "detail", change.zoomTarget)
    assertEquals("pop", change.direction)
  }

  @Test
  fun `nonzoom pop keeps declared pattern policy`() {
    val snapshot =
      snapshot()
        .copy(
          stackEdges =
            mapOf(
              "nav" to
                listOf(
                  PrototypeStackEdge("home", null, null),
                  PrototypeStackEdge("detail", PrototypeStackTransition.FADE, null),
                ),
            ),
        )
    assertNull(snapshot.stackPopChange("nav").override)
    assertNull(snapshot.stackPopChange("nav").source)
  }

  @Test
  fun `popping a nested entry restores the previous zoom source`() {
    val snapshot = snapshot()
    val path = listOf("home", "detail", "next")
    val edges =
      snapshot.nextStackEdges(
        "nav",
        "push",
        PrototypeStackEdge("next", PrototypeStackTransition.ZOOM, "nextHero"),
        path,
      )
    val nested =
      snapshot.copy(
        stacks = mapOf("nav" to PrototypeStackSnapshot(path)),
        stackEdges = mapOf("nav" to edges),
      )
    assertEquals("nextHero", nested.stackPopChange("nav").source)
    val popped =
      nested.copy(
        stacks = snapshot.stacks,
        stackEdges =
          mapOf(
            "nav" to nested.nextStackEdges("nav", "pop", edges.last(), listOf("home", "detail")),
          ),
      )
    assertEquals("hero", popped.stackPopChange("nav").source)
  }

  @Test
  fun `replacement owns its edge at the same depth`() {
    val snapshot = snapshot()
    val edge = PrototypeStackEdge("replacement", PrototypeStackTransition.ZOOM, "card")
    val edges = snapshot.nextStackEdges("nav", "replace", edge, listOf("home", "replacement"))
    assertEquals(2, edges.size)
    assertEquals(edge, edges.last())
  }

  @Test
  fun `same id replacement retains only matching prefixes`() {
    val snapshot = snapshot()
    assertEquals(snapshot.stackEdges, snapshot.retainedStackEdges(snapshot.stacks))
    assertEquals(
      1,
      snapshot
        .retainedStackEdges(mapOf("nav" to PrototypeStackSnapshot(listOf("home", "other"))))
        .getValue("nav")
        .size,
    )
    assertEquals(
      emptyMap<String, List<PrototypeStackEdge>>(),
      snapshot.retainedStackEdges(emptyMap()),
    )
  }

  private fun snapshot() =
    PrototypeRuntimeSnapshot(
      spec =
        PrototypeSpec(
          "edge",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "x"),
        ),
      pages = emptyMap(),
      stacks = mapOf("nav" to PrototypeStackSnapshot(listOf("home", "detail"))),
      stackEdges =
        mapOf(
          "nav" to
            listOf(
              PrototypeStackEdge("home", null, null),
              PrototypeStackEdge("detail", PrototypeStackTransition.ZOOM, "hero"),
            ),
        ),
    )
}
