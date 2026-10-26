package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrototypeStackTransitionRuntimeTest {
  @Test
  fun `navigation records direction and only the current actions override`() = runBlocking {
    val events = mutableListOf<PrototypeEvent>()
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "nav",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root =
            PrototypeStackNode(
              id = "nav",
              start = "home",
              screens =
                mapOf(
                  "home" to PrototypeTextNode(text = "Home"),
                  "detail" to PrototypeTextNode(text = "Detail"),
                ),
            ),
        ),
        sink = { events += it },
        nextSequence = { events.size.toLong() + 1 },
      )
    suspend fun act(action: PrototypeAction) =
      runtime.handle(PrototypeInteraction.Tap(listOf(action)))
    act(PrototypePushAction("nav", "detail", PrototypeStackTransition.NONE))
    assertEquals("push", runtime.current.stackChange?.direction)
    assertEquals(PrototypeStackTransition.NONE, runtime.current.stackChange?.override)
    val preview = checkNotNull(runtime.backPreview())
    assertEquals(listOf("home"), preview.stacks.getValue("nav").path)
    assertEquals(listOf("home", "detail"), runtime.current.stacks.getValue("nav").path)
    runtime.handle(PrototypeInteraction.Back)
    assertEquals("pop", runtime.current.stackChange?.direction)
    assertNull(runtime.current.stackChange?.override)
    act(PrototypeReplaceAction("nav", "detail", PrototypeStackTransition.FADE))
    assertEquals("replace", runtime.current.stackChange?.direction)
    assertEquals(PrototypeStackTransition.FADE, runtime.current.stackChange?.override)
    act(PrototypePopToRootAction("nav"))
    assertEquals("pop", runtime.current.stackChange?.direction)
    assertEquals(listOf("home"), runtime.current.stacks.getValue("nav").path)
    assertEquals(4, events.count { it.kind == PrototypeEventKind.SCREEN_CHANGED })
  }
}
