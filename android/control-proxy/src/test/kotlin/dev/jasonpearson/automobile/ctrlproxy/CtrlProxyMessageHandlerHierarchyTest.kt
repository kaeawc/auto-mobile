package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.RequestHierarchy
import dev.jasonpearson.automobile.protocol.RequestScreenshot
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

internal class CtrlProxyMessageHandlerHierarchyTest : CtrlProxyMessageHandlerFixtures() {
  @Test
  fun `dispatches request_hierarchy`() = runTest {
    dispatch("""{"type":"request_hierarchy","requestId":"h1","disableAllFiltering":true}""")
    assertEquals(
      "requestHierarchy" to
        listOf<Any?>(RequestHierarchy(disableAllFiltering = true, requestId = "h1")),
      lastCall,
    )
  }

  @Test
  fun `hierarchy dispatch preserves nullable limits and display in the typed request`() = runTest {
    for (maxDepth in listOf(null, 0)) {
      for (maxNodes in listOf(null, 37)) {
        for (displayId in listOf(null, 2)) {
          assertTypedDispatch(
            """{"type":"request_hierarchy","requestId":"hierarchy","disableAllFiltering":true,"maxDepth":$maxDepth,"maxNodes":$maxNodes,"displayId":$displayId}""",
            "requestHierarchy" to
              listOf<Any?>(
                RequestHierarchy(
                  disableAllFiltering = true,
                  maxDepth = maxDepth,
                  maxNodes = maxNodes,
                  displayId = displayId,
                  requestId = "hierarchy",
                ),
              ),
          )
        }
      }
    }
    assertTypedDispatch(
      """{"type":"request_hierarchy"}""",
      "requestHierarchy" to
        listOf<Any?>(
          RequestHierarchy(
            disableAllFiltering = false,
            maxDepth = null,
            maxNodes = null,
            displayId = null,
            requestId = null,
          ),
        ),
    )
  }

  @Test
  fun `dispatches request_hierarchy_if_stale`() = runTest {
    dispatch("""{"type":"request_hierarchy_if_stale","requestId":"h2","sinceTimestamp":12345}""")
    assertEquals("requestHierarchyIfStale" to listOf<Any?>(12345L, "h2"), lastCall)
  }

  @Test
  fun `dispatches set_hierarchy_interval`() = runTest {
    dispatch("""{"type":"set_hierarchy_interval","intervalMs":500}""")
    assertEquals("setHierarchyInterval" to listOf<Any?>(500L), lastCall)
  }

  @Test
  fun `dispatches set_hierarchy_interval reset`() = runTest {
    dispatch("""{"type":"set_hierarchy_interval","intervalMs":null}""")
    assertEquals("setHierarchyInterval" to listOf<Any?>(null), lastCall)
  }

  @Test
  fun `dispatches request_screenshot`() = runTest {
    dispatch("""{"type":"request_screenshot","requestId":"s1"}""")
    assertEquals("requestScreenshot" to listOf<Any?>(RequestScreenshot(requestId = "s1")), lastCall)
  }

  @Test
  fun `dispatches request_screenshot hidePrototypes to the hide-capture-restore action`() =
    runTest {
      dispatch(
        """{"type":"request_screenshot","requestId":"s2","displayId":3,"hidePrototypes":true}""",
      )
      assertEquals(
        "requestScreenshot" to
          listOf<Any?>(RequestScreenshot(requestId = "s2", displayId = 3, hidePrototypes = true)),
        lastCall,
      )
    }

  @Test
  fun `screenshot dispatch preserves hidePrototypes and display`() = runTest {
    for (displayId in listOf(null, 3)) {
      for (hidePrototypes in listOf(false, true)) {
        val expected = listOf<Any?>(RequestScreenshot("screenshot", displayId, hidePrototypes))
        assertTypedDispatch(
          """{"type":"request_screenshot","requestId":"screenshot","displayId":$displayId,"hidePrototypes":$hidePrototypes}""",
          "requestScreenshot" to expected,
        )
      }
    }
    assertTypedDispatch(
      """{"type":"request_screenshot"}""",
      "requestScreenshot" to listOf<Any?>(RequestScreenshot(requestId = null, displayId = null)),
    )
  }
}
