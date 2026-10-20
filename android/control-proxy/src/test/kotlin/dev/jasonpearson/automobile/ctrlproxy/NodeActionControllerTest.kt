package dev.jasonpearson.automobile.ctrlproxy

import android.text.SpannableString
import android.text.Spanned
import android.text.style.ClickableSpan
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class NodeActionControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 5_000L
  }

  private data class Result(
    val requestId: String?,
    val action: String,
    val success: Boolean,
    val error: String?,
    val alreadySatisfied: Boolean,
  )

  private class FakeHost(private val scope: CoroutineScope) : NodeActionController.Host {
    var node: AccessibilityNodeInfo? = null
    var root: AccessibilityNodeInfo? = null
    var view: View? = null
    val events = mutableListOf<String>()
    val results = mutableListOf<Result>()

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch { block() }
    }

    override fun activeWindowRoot(): AccessibilityNodeInfo? = root

    override fun findNodeInDisplayWindows(
      find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
    ) = node

    override fun screenDimensions(displayId: Int): ScreenDimensions? = null

    override fun createView(): View = checkNotNull(view)

    override suspend fun publishSettledHierarchy() {
      events += "publish"
    }

    override fun forgetRememberedInsert() {
      events += "forget"
    }

    override suspend fun sendActionResult(outcome: NodeActionResult) {
      events += "result"
      results +=
        Result(
          outcome.requestId,
          outcome.action,
          outcome.success,
          outcome.error,
          outcome.alreadySatisfied,
        )
    }
  }

  private val timer = FakeTimer()

  private fun TestScope.setup(): Pair<NodeActionController, FakeHost> {
    val host = FakeHost(this)
    return NodeActionController(host, PerfProvider.createForTesting(timer), timer) to host
  }

  private fun node(focused: Boolean = false, actions: List<Int> = emptyList()) =
    mockk<AccessibilityNodeInfo>(relaxed = true).also { node ->
      every { node.isAccessibilityFocused } returns focused
      every { node.actionList } returns
        actions.map { AccessibilityNodeInfo.AccessibilityAction(it, null) }
      every { node.performAction(any()) } returns true
    }

  @Test
  fun `an action without a resource id or selector is refused`() = runTest {
    val (controller, host) = setup()

    controller.performNodeAction("r1", "click", null, null)
    advanceUntilIdle()

    val result = host.results.single()
    assertFalse(result.success)
    assertEquals(
      "A resource-id or stable node selector is required for accessibility actions",
      result.error,
    )
    assertEquals(listOf("forget", "result"), host.events)
  }

  @Test
  fun `an action on a missing element reports it not found`() = runTest {
    val (controller, host) = setup()

    controller.performNodeAction("r1", "click", "app:id/missing", null)
    advanceUntilIdle()

    assertEquals("Element not found with resource-id: app:id/missing", host.results.single().error)
  }

  @Test
  fun `a successful click settles the hierarchy before acknowledging and recycles the node`() =
    runTest {
      val (controller, host) = setup()
      val target = node(actions = listOf(AccessibilityNodeInfo.ACTION_CLICK))
      host.node = target

      controller.performNodeAction("r1", "click", "app:id/ok", null)

      assertEquals(listOf("forget", "publish", "result"), host.events)
      assertTrue(host.results.single().success)
      assertNull(host.results.single().error)
      verify(exactly = 1) { target.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
      verify(exactly = 1) { target.recycle() }
    }

  @Test
  fun `focus on an already focused node is satisfied without performing or settling`() = runTest {
    val (controller, host) = setup()
    val target = node(focused = true)
    host.node = target

    controller.performNodeAction("r1", "focus", "app:id/ok", null)

    val result = host.results.single()
    assertTrue(result.success)
    assertTrue(result.alreadySatisfied)
    assertFalse("publish" in host.events)
    verify(exactly = 0) { target.performAction(any()) }
  }

  @Test
  fun `an action the node does not advertise is refused with the decision message`() = runTest {
    val (controller, host) = setup()
    host.node = node(actions = listOf(AccessibilityNodeInfo.ACTION_LONG_CLICK))

    controller.performNodeAction("r1", "click", "app:id/ok", null)

    val result = host.results.single()
    assertFalse(result.success)
    assertNotNull(result.error)
    assertFalse("publish" in host.events)
  }

  @Test
  fun `a blank link text is refused`() = runTest {
    val (controller, host) = setup()

    controller.performAccessibilityLinkActivation("r1", " ", 0, null)
    advanceUntilIdle()

    val result = host.results.single()
    assertEquals("activate_accessibility_link", result.action)
    assertFalse(result.success)
    assertEquals("Link text must be non-blank and occurrence must be non-negative", result.error)
  }

  @Test
  fun `a link with no matching span reports no actionable link`() = runTest {
    val (controller, host) = setup()
    host.node = null

    controller.performAccessibilityLinkActivation("r1", "Terms", 0, null)
    advanceUntilIdle()

    assertEquals(
      "No actionable semantic link matching 'Terms' at occurrence 0",
      host.results.single().error,
    )
  }

  @Test
  @Config(sdk = [24])
  fun `semantic links are refused below API 26`() = runTest {
    val (controller, host) = setup()

    controller.performAccessibilityLinkActivation("r1", "Terms", 0, null)
    advanceUntilIdle()

    assertEquals(
      "Semantic accessibility links require Android API 26 or later",
      host.results.single().error,
    )
  }

  @Test
  fun `a plain runtime span failure preserves the typed link result`() = runTest {
    val (controller, host) = setup()
    val span = mockk<ClickableSpan>()
    every { span.onClick(any()) } throws RuntimeException("span failed")
    val text =
      SpannableString("Terms").apply {
        setSpan(span, 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    host.root =
      mockk<AccessibilityNodeInfo>(relaxed = true).also {
        every { it.text } returns text
      }
    host.view = mockk()

    controller.performAccessibilityLinkActivation("r1", "Terms", 0, null)
    advanceUntilIdle()

    val result = host.results.single()
    assertEquals("activate_accessibility_link", result.action)
    assertFalse(result.success)
    assertEquals("Semantic link activation failed: span failed", result.error)
  }
}
