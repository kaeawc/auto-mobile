package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import dev.jasonpearson.automobile.ctrlproxy.prototype.screenshot.validPrototypeFixture
import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * Counts below the content root, including Material's own semantics, as accessibility sees them.
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeSemanticsNodeCountTest {
  companion object {
    // BEFORE: 394 semantics nodes, 349 role nodes (first-composition count, before the pager's
    // bounded-height recomposition). 364 was the same unsettled count after the change; the
    // settled render adds one node, the off-screen neighbour page's cleared box.
    private const val BENCHMARK_SEMANTICS_NODES = 365
    private const val BENCHMARK_ROLE_NODES = 319
    // component-gallery BEFORE: 19 semantics nodes, 15 role nodes.
    // No decorative icon/image or single-text tappable container; pinned to show no change.
    private const val GALLERY_SEMANTICS_NODES = 19
    private const val GALLERY_ROLE_NODES = 15
    // fullscreen-all-nodes BEFORE: 30 semantics nodes, 5 role nodes.
    // No decorative icon/image or single-text tappable container; pinned to show no change.
    private const val FULLSCREEN_SEMANTICS_NODES = 30
    private const val FULLSCREEN_ROLE_NODES = 5
    // doc-example-1 BEFORE: 16 semantics nodes, 5 role nodes.
    // No decorative icon/image or single-text tappable container; pinned to show no change.
    private const val DOC_EXAMPLE_SEMANTICS_NODES = 16
    private const val DOC_EXAMPLE_ROLE_NODES = 5
  }

  @Test
  fun `decorative visuals disappear and only safe single-text rows collapse`() {
    val tap = listOf<PrototypeAction>(PrototypeEmitAction("open"))
    val spec =
      semanticsSpec(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeIconNode(name = "home"),
              PrototypeImageNode(asset = PrototypeModeValue.Single("missing")),
              PrototypeIconNode(name = "settings", testTag = "tagged-icon"),
              PrototypeImageNode(
                asset = PrototypeModeValue.Single("missing"),
                contentDescription = "Portrait",
              ),
              PrototypeIconNode(name = "add", onTap = tap),
              PrototypeTextNode(text = "Standalone"),
              PrototypeRowNode(
                testTag = "single",
                onTap = tap,
                children =
                  listOf(PrototypeIconNode(name = "home"), PrototypeTextNode(text = "General")),
              ),
              PrototypeRowNode(
                testTag = "double",
                onTap = tap,
                children =
                  listOf(PrototypeTextNode(text = "Inbox"), PrototypeTextNode(text = "3 unread")),
              ),
              PrototypeRowNode(
                onTap = tap,
                children =
                  listOf(
                    PrototypeTextNode(text = "Tagged row"),
                    PrototypeTextNode(text = "Keep", testTag = "kept-text"),
                  ),
              ),
              // A tappable visual with no other handle intentionally keeps its kind fallback.
              PrototypeImageNode(asset = PrototypeModeValue.Single("missing"), onTap = tap),
            ),
        ),
      )
    PrototypeSemanticsRender(spec).use { rendered ->
      val nodes = rendered.nodes
      val roles = nodes.filter { it.config.contains(PrototypeRole) }
      // BEFORE (16 role nodes): (icon, home, null), (image, image, null),
      // (icon, settings, tagged-icon), (image, Portrait, null), (icon, add, null),
      // (text, Standalone, null), (row, null, single), (icon, home, null),
      // (text, General, null), (row, null, double), (text, Inbox, null),
      // (text, 3 unread, null), (row, null, null), (text, Tagged row, null),
      // (text, Keep, kept-text), (image, image, null).
      assertEquals(
        listOf(
          Triple("icon", "settings", "tagged-icon"),
          Triple("image", "Portrait", null),
          Triple("icon", "add", null),
          Triple("text", "Standalone", null),
          Triple("row", "General", "single"),
          Triple("row", null, "double"),
          Triple("text", "Inbox", null),
          Triple("text", "3 unread", null),
          Triple("row", null, null),
          Triple("text", "Tagged row", null),
          Triple("text", "Keep", "kept-text"),
          Triple("image", "image", null),
        ),
        roles.map {
          Triple(
            it.config[PrototypeRole],
            it.description(),
            it.config.getOrNull(SemanticsProperties.TestTag),
          )
        },
      )
      val kindLabels = nodes.filter { it.description() in listOf("icon", "image", "text") }
      assertEquals(listOf("image"), kindLabels.map { it.description() })
      val single = nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "single" }
      assertEquals("General", single.config[SemanticsProperties.Text].single().text)
      assertEquals("General", single.description())
      assertEquals(listOf(single), single.accessibilityNodes())
      assertTrue(single.config.contains(SemanticsActions.OnClick))
      val double = nodes.single { it.config.getOrNull(SemanticsProperties.TestTag) == "double" }
      assertEquals(
        listOf("Inbox", "3 unread"),
        double.accessibilityNodes().drop(1).map {
          it.config[SemanticsProperties.Text].single().text
        },
      )
    }
  }

  @Test
  fun `rich text semantics preserve the tappable span link annotation`() {
    val spec =
      semanticsSpec(
        PrototypeTextNode(
          testTag = "rich-text",
          spans =
            listOf(
              PrototypeTextSpan("Read "),
              PrototypeTextSpan("terms", onTap = listOf(PrototypeEmitAction("open"))),
            ),
        ),
      )
    PrototypeSemanticsRender(spec).use { rendered ->
      val node =
        rendered.nodes.single {
          it.config.getOrNull(SemanticsProperties.TestTag) == "rich-text"
        }
      val text = node.config[SemanticsProperties.Text].single()
      assertEquals("Read terms", text.text)
      val links = text.getLinkAnnotations(0, text.length)
      assertEquals(1, links.size)
      assertEquals(5, links.single().start)
      assertEquals(10, links.single().end)
    }
  }

  @Test
  fun `tappable card preserves its untagged rich text child's link annotation`() {
    val spec =
      semanticsSpec(
        PrototypeCardNode(
          onTap = listOf(PrototypeEmitAction("card")),
          children =
            listOf(
              PrototypeTextNode(
                spans =
                  listOf(
                    PrototypeTextSpan("Read "),
                    PrototypeTextSpan("terms", onTap = listOf(PrototypeEmitAction("terms"))),
                  ),
              ),
            ),
        ),
      )
    PrototypeSemanticsRender(spec).use { rendered ->
      val card = rendered.nodes.single { it.config.getOrNull(PrototypeRole) == "card" }
      assertTrue(card.config.contains(SemanticsActions.OnClick))
      val node = card.accessibilityNodes().single { it.config.getOrNull(PrototypeRole) == "text" }
      assertNull(node.config.getOrNull(SemanticsProperties.TestTag))
      val text = node.config[SemanticsProperties.Text].single()
      assertEquals("Read terms", text.text)
      val links = text.getLinkAnnotations(0, text.length)
      assertEquals(1, links.size)
      assertEquals(5, links.single().start)
      assertEquals(10, links.single().end)
    }
  }

  @Test
  fun `tappable card still merges rich text without tappable spans`() {
    val spec =
      semanticsSpec(
        PrototypeCardNode(
          onTap = listOf(PrototypeEmitAction("card")),
          children =
            listOf(
              PrototypeTextNode(
                spans = listOf(PrototypeTextSpan("Read "), PrototypeTextSpan("terms")),
              ),
            ),
        ),
      )
    PrototypeSemanticsRender(spec).use { rendered ->
      val card = rendered.nodes.single { it.config.getOrNull(PrototypeRole) == "card" }
      assertEquals(listOf(card), card.accessibilityNodes())
      assertEquals("Read terms", card.config[SemanticsProperties.Text].single().text)
      assertEquals("Read terms", card.description())
      assertTrue(card.config.contains(SemanticsActions.OnClick))
    }
  }

  @Test
  fun `benchmark node counts and decorative images are pinned`() {
    PrototypeSemanticsRender(benchmarkSemanticsSpec()).use { rendered ->
      assertCounts(rendered, BENCHMARK_SEMANTICS_NODES, BENCHMARK_ROLE_NODES)
      assertEquals(0, rendered.nodes.count { it.config.getOrNull(PrototypeRole) == "image" })
    }
  }

  @Test
  fun `component gallery counts are pinned`() {
    assertFixtureCounts("component-gallery", GALLERY_SEMANTICS_NODES, GALLERY_ROLE_NODES)
  }

  @Test
  fun `fullscreen all nodes counts are pinned`() {
    assertFixtureCounts("fullscreen-all-nodes", FULLSCREEN_SEMANTICS_NODES, FULLSCREEN_ROLE_NODES)
  }

  @Test
  fun `doc example counts are pinned`() {
    assertFixtureCounts("doc-example-1", DOC_EXAMPLE_SEMANTICS_NODES, DOC_EXAMPLE_ROLE_NODES)
  }

  private fun assertFixtureCounts(name: String, total: Int, roles: Int) {
    PrototypeSemanticsRender(validPrototypeFixture(name)).use { assertCounts(it, total, roles) }
  }

  private fun assertCounts(rendered: PrototypeSemanticsRender, total: Int, roles: Int) {
    val actual = rendered.nodes.size
    val actualRoles = rendered.nodes.count { it.config.contains(PrototypeRole) }
    val message = "${rendered.spec.id}: semantics nodes: $actual; role nodes: $actualRoles"
    assertEquals(message, "$total/$roles", "$actual/$actualRoles")
  }
}

internal fun semanticsSpec(root: PrototypeNode) =
  PrototypeSpec("semantics", PrototypeWindow(PrototypeFullscreenPlacement()), emptyMap(), root)

internal fun prototypeRepositoryFile(path: String): File =
  generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
    .map { File(it, path) }
    .first { it.isFile }

internal fun benchmarkSemanticsSpec(): PrototypeSpec {
  val validation =
    PrototypeSpecValidator.validate(
      prototypeRepositoryFile("benchmark/prototype-frame/spec.json").readText(),
    )
  check(validation is PrototypeSpecValidation.Success) { validation.toString() }
  return validation.spec
}

internal fun SemanticsNode.description(): String? =
  config.getOrNull(SemanticsProperties.ContentDescription)?.singleOrNull()

internal fun SemanticsNode.hasExactPrototypeText(text: String): Boolean =
  config.getOrNull(SemanticsProperties.Text).orEmpty().any { it.text == text } ||
    config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().any { it == text }

/**
 * Owns its Recomposer and frame clock because an earlier Robolectric test in the same JVM can leave
 * the shared main-thread AndroidUiDispatcher with a dropped frame/trampoline dispatch. This starves
 * later recompositions, including the pager's bounded-height update that composes its neighbour
 * page, making node counts depend on test order.
 */
internal class PrototypeSemanticsRender(val spec: PrototypeSpec) : AutoCloseable {
  companion object {
    private const val MAX_SETTLE_FRAMES = 10
    private const val FRAME_INTERVAL_NANOS = 16_000_000L
  }

  val model = mapPrototypeSpec(spec)
  private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
  private val looper = shadowOf(Looper.getMainLooper())
  private val frameClock = BroadcastFrameClock()
  private val scope =
    CoroutineScope(Handler(Looper.getMainLooper()).asCoroutineDispatcher() + frameClock + Job())
  private val recomposer = Recomposer(scope.coroutineContext)
  val nodes: List<SemanticsNode>

  init {
    scope.launch { recomposer.runRecomposeAndApplyChanges() }
    nodes = runCatching { render() }.onFailure { close() }.getOrThrow()
  }

  private fun render(): List<SemanticsNode> {
    val contentView = ComposeView(activity.get())
    contentView.setParentCompositionContext(recomposer)
    activity.get().setContentView(contentView)
    contentView.setContent { PrototypeSpecContent(model.root, spec.theme) }
    val view = checkNotNull(composeView(activity.get().window.decorView)) as RootForTest
    settle(view)
    val root = view.semanticsOwner.unmergedRootSemanticsNode
    // The renderer's testTagsAsResourceId box is the single content root, not an authored node.
    return root.children.single().children.flatMap { it.accessibilityNodes() }
  }

  private fun settle(root: RootForTest) {
    var frameTimeNanos = 0L
    repeat(MAX_SETTLE_FRAMES + 1) { index ->
      looper.idle()
      root.measureAndLayoutForTest()
      Snapshot.sendApplyNotifications()
      if (!recomposer.hasPendingWork) return
      if (index < MAX_SETTLE_FRAMES) {
        frameTimeNanos += FRAME_INTERVAL_NANOS
        frameClock.sendFrame(frameTimeNanos)
      }
    }
    error("${spec.id} composition did not settle in $MAX_SETTLE_FRAMES frames")
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  override fun close() {
    recomposer.cancel()
    scope.cancel()
    activity.pause().stop().destroy()
    looper.idle()
  }
}
