package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Rect
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ActionResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope

internal object NodeActionControllerTestSupport {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 5_000L
  }

  data class Result(
    val requestId: String?,
    val action: String,
    val success: Boolean,
    val error: String?,
    val alreadySatisfied: Boolean,
  )

  class FakeHost(private val scope: CoroutineScope) : NodeActionController.Host {
    var node: AccessibilityNodeInfo? = null
    var root: AccessibilityNodeInfo? = null
    var windowRoots: List<AccessibilityNodeInfo>? = null
    var view: View? = null
    val events = mutableListOf<String>()
    val results = mutableListOf<Result>()
    val envelopes = mutableListOf<ActionResult>()
    var failSend: RuntimeException? = null

    override fun launchRequestScope(requestId: String?, block: suspend CoroutineScope.() -> Unit) {
      scope.launch { block() }
    }

    override fun activeWindowRoot(): AccessibilityNodeInfo? = root

    var failLookup: RuntimeException? = null

    override fun findNodeInDisplayWindows(
      find: (AccessibilityNodeInfo) -> AccessibilityNodeInfo?,
    ): AccessibilityNodeInfo? {
      failLookup?.let { throw it }
      return windowRoots?.firstNotNullOfOrNull(find) ?: node
    }

    override fun findNodesInDisplayWindows(
      find: (AccessibilityNodeInfo) -> List<AccessibilityNodeInfo>,
    ): List<AccessibilityNodeInfo> = windowRoots.orEmpty().flatMap(find)

    override fun screenDimensions(displayId: Int): ScreenDimensions? = null

    override fun createView(): View = checkNotNull(view)

    override suspend fun publishSettledHierarchy() {
      events += "publish"
    }

    override fun forgetRememberedInsert() {
      events += "forget"
    }
  }

  /** Puts each `action_result` on the host's event log, so ordering against settling is visible. */
  private class RecordingTransport(private val host: FakeHost) : FakeResultTransport() {
    override suspend fun send(response: WebSocketResponse) {
      host.failSend?.let { throw it }
      super.send(response)
      val result = response as ActionResult
      host.envelopes += result
      host.events += "result"
      host.results +=
        Result(
          result.requestId,
          result.action!!,
          result.success,
          result.error,
          result.alreadySatisfied,
        )
    }
  }

  private val timer = FakeTimer()

  fun TestScope.setup(): Pair<NodeActionController, FakeHost> {
    val host = FakeHost(this)
    val sender =
      guardedResultSender(
        RecordingTransport(host),
        ResultBroadcaster(
          broadcastError = { host.events += "error:${it.requestId}" },
          logError = { _, _ -> },
        ),
      )
    return NodeActionController(host, PerfProvider.createForTesting(timer), timer, sender) to host
  }

  fun node(focused: Boolean = false, actions: List<Int> = emptyList()) =
    mockk<AccessibilityNodeInfo>(relaxed = true).also { node ->
      every { node.isAccessibilityFocused } returns focused
      every { node.actionList } returns
        actions.map { AccessibilityNodeInfo.AccessibilityAction(it, null) }
      every { node.performAction(any()) } returns true
    }

  val expectedBounds = NodeExpectedBounds(10, 20, 110, 120)

  fun boundsNode(visible: Boolean = true, left: Int = 10): AccessibilityNodeInfo =
    node(actions = listOf(AccessibilityNodeInfo.ACTION_CLICK)).also { target ->
      every { target.viewIdResourceName } returns "app:id/button"
      every { target.extras } returns null
      every { target.isVisibleToUser } returns visible
      every { target.getBoundsInScreen(any()) } answers
        {
          firstArg<Rect>().set(left, 20, 110, 120)
        }
    }

  fun tree(vararg children: AccessibilityNodeInfo): AccessibilityNodeInfo =
    node().also { root ->
      every { root.childCount } returns children.size
      every { root.getChild(any()) } answers { children[firstArg()] }
    }
}
