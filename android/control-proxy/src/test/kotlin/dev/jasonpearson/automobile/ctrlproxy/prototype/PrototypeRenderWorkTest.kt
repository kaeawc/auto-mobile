package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ContentResolver
import android.graphics.Bitmap
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import dev.jasonpearson.automobile.protocol.*
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

private const val SETTLE_MS = 2_000L
private const val ASSET_ID = "hero"

@RunWith(RobolectricTestRunner::class)
class PrototypeRenderWorkTest {
  @get:Rule val compose = createComposeRule()

  private val compositions = mutableMapOf<String, Int>()
  private val work = mutableMapOf<Pair<PrototypeRenderWork, String>, Int>()
  private val compositionProbe: (String) -> Unit = { identity ->
    compositions[identity] = (compositions[identity] ?: 0) + 1
  }
  private val workProbe: (PrototypeRenderWork, String) -> Unit = { kind, identity ->
    val key = kind to identity
    work[key] = (work[key] ?: 0) + 1
  }
  private val controller =
    PrototypeController(
      FakePrototypeHost(),
      PrototypeResultSink { _, _, _ -> },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )
  private var resolver: ContentResolver = RuntimeEnvironment.getApplication().contentResolver
  private val store = PrototypeAssetStore(FakePrototypeAssetFiles())
  private var decodes = 0
  private val decoder = PrototypeImageDecoder { _, _ ->
    decodes++
    BitmapPrototypeImage(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
  }
  private val cache =
    PrototypeImageCache(store, decoder, dispatcher = Dispatchers.Unconfined).also {
      store.setChangeListener(it::invalidate)
    }
  private val shownCondition = PrototypeCondition("show", PrototypeScalar.BooleanValue(true))
  private val changedCondition = PrototypeCondition("changed", PrototypeScalar.BooleanValue(true))

  private fun spec(root: PrototypeNode, motion: String? = "none") =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state =
        mapOf(
          "show" to PrototypeScalar.BooleanValue(true),
          "changed" to PrototypeScalar.BooleanValue(false),
        ),
      root = root,
      motion = motion,
    )

  private fun show(spec: PrototypeSpec): PrototypeRuntime {
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    resolver.notifyChange(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), null)
    shadowOf(Looper.getMainLooper()).idle()
    runBlocking { controller.show("show", spec) }
    val runtime = checkNotNull(controller.activeRuntime)
    compose.setContent {
      resolver = LocalContext.current.contentResolver
      CompositionLocalProvider(
        LocalPrototypeCompositionProbe provides compositionProbe,
        LocalPrototypeRenderWorkProbe provides workProbe,
      ) {
        PrototypeRuntimeContent(runtime, images = cache) { controller.interact(runtime, it) }
      }
    }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    return runtime
  }

  private fun PrototypeRuntime.tapThenAdvance(action: PrototypeAction, frames: Int = 2) {
    runBlocking {
      controller.interact(this@tapThenAdvance, PrototypeInteraction.Tap(listOf(action)))
    }
    repeat(frames) { compose.mainClock.advanceTimeByFrame() }
  }

  private fun PrototypeRuntime.setShown(value: Boolean) =
    tapThenAdvance(PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(value)))

  private fun PrototypeRuntime.toggleStyle() {
    repeat(3) { index ->
      tapThenAdvance(
        PrototypeSetStateAction("changed", PrototypeScalar.BooleanValue(index % 2 == 0)),
      )
    }
  }

  private fun settle() = compose.mainClock.advanceTimeBy(SETTLE_MS)

  // Hidden semantics use the merged tree because the unmerged tree keeps cleared descendants.
  private fun shown(tag: String, unmerged: Boolean = true): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = unmerged).fetchSemanticsNodes().size

  private fun count(kind: PrototypeRenderWork, key: String) = work[kind to key] ?: 0

  private fun identities(kind: PrototypeRenderWork): Set<String> =
    work.keys.filter { it.first == kind }.map { it.second }.toSet()

  private fun image(styleWhen: List<PrototypeStyleWhen>? = null) =
    PrototypeImageNode(
      asset = PrototypeModeValue.Single(ASSET_ID),
      testTag = "image",
      style =
        PrototypeStyle(width = PrototypeDimension.Dp(48.0), height = PrototypeDimension.Dp(48.0)),
      styleWhen = styleWhen,
    )

  private fun upload() = store.put(ASSET_ID, "image/png", PrototypeAssetBytes.png())

  private fun assertReady() {
    assertEquals(1, decodes)
    assertTrue(
      "the bitmap's Ready path was drawn",
      count(PrototypeRenderWork.IMAGE_BITMAP_WRAP, ASSET_ID) >= 1,
    )
    assertEquals(1, shown("image"))
  }

  // #12136: FAIL-NOW selectivity, followed by pins for layout motion and disabled motion.
  @Test
  fun `size animation is applied only to containers whose direct child can appear or disappear`() {
    show(
      spec(
        PrototypeColumnNode(
          id = "root",
          children =
            listOf(
              PrototypeBoxNode(
                id = "A",
                children = listOf(PrototypeTextNode(text = "a", visibleWhen = shownCondition)),
              ),
              PrototypeBoxNode(id = "B", children = listOf(PrototypeTextNode(text = "b"))),
              PrototypeRowNode(
                id = "C",
                children =
                  listOf(
                    PrototypeColumnNode(
                      id = "D",
                      children =
                        listOf(PrototypeTextNode(text = "d", visibleWhen = shownCondition)),
                    ),
                  ),
              ),
              PrototypeColumnNode(
                id = "E",
                repeat =
                  PrototypeRepeat(
                    List(2) { mapOf("label" to PrototypeScalar.Text("item $it")) },
                    "item",
                  ),
                children = listOf(PrototypeTextNode(text = "{item.label}")),
              ),
            ),
        ),
        motion = null,
      ),
    )
    assertEquals(
      setOf("root.children[0]", "root.children[2].children[0]", "root.children[3]"),
      identities(PrototypeRenderWork.SIZE_ANIMATION),
    )
  }

  private fun slidingSpec(motion: String? = null) =
    spec(
      PrototypeColumnNode(
        children =
          listOf(
            PrototypeTextNode(text = "always", testTag = "always"),
            PrototypeTextNode(text = "detail", visibleWhen = shownCondition),
            PrototypeTextNode(text = "below", testTag = "below"),
          ),
      ),
      motion,
    )

  private fun belowTop() =
    compose.onNodeWithTag("below", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

  @Test
  fun `a sibling slides into the space a hiding child frees`() {
    val runtime = show(slidingSpec())
    val shownTop = belowTop()
    runtime.tapThenAdvance(
      PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(false)),
      frames = 5,
    )
    val midwayTop = belowTop()
    settle()
    val hiddenTop = belowTop()
    assertTrue("below is still moving", midwayTop > hiddenTop && midwayTop < shownTop)
    val collapsedTop =
      compose
        .onNodeWithTag("always", useUnmergedTree = true)
        .fetchSemanticsNode()
        .boundsInRoot
        .bottom
    assertEquals(collapsedTop, hiddenTop, 0.01f)
    settle()
    assertEquals(hiddenTop, belowTop(), 0.01f)
  }

  @Test
  fun `motion none applies no size animation`() {
    val runtime = show(slidingSpec("none"))
    runtime.setShown(false)
    assertTrue(identities(PrototypeRenderWork.SIZE_ANIMATION).isEmpty())
  }

  // #12138: FAIL-NOW image and icon work; pins preserve constraints and invalidation.
  @Test
  fun `a dp sized image composes without a subcomposition`() {
    upload()
    show(spec(image()))
    assertReady()
    assertEquals(0, count(PrototypeRenderWork.IMAGE_SUBCOMPOSITION, "root"))
  }

  @Test
  fun `recomposing a ready image wraps its bitmap once`() {
    upload()
    val runtime =
      show(spec(image(listOf(PrototypeStyleWhen(changedCondition, PrototypeStyle(alpha = 0.5))))))
    assertReady()
    val before = checkNotNull(compositions["root"])
    runtime.toggleStyle()
    assertEquals("image really recomposed three times", before + 3, compositions["root"])
    assertEquals(1, count(PrototypeRenderWork.IMAGE_BITMAP_WRAP, ASSET_ID))
    assertEquals(1, decodes)
  }

  @Test
  fun `an image whose decode is cached enters composition without launching a load`() {
    upload()
    val runtime =
      show(
        spec(
          PrototypeBoxNode(
            children =
              listOf(PrototypeColumnNode(visibleWhen = shownCondition, children = listOf(image()))),
          ),
        ),
      )
    assertReady()
    assertEquals(1, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, ASSET_ID))
    runtime.setShown(false)
    assertEquals(0, shown("image"))
    runtime.tapThenAdvance(
      PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(true)),
      frames = 1,
    )
    // The cached Ready path must be available on this first frame, with no new decode.
    assertReady()
    assertEquals(1, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, ASSET_ID))
  }

  @Test
  fun `recomposing an icon resolves it once`() {
    val runtime =
      show(
        spec(
          PrototypeIconNode(
            name = "home",
            style = PrototypeStyle(color = PrototypeModeValue.Single("#000000")),
            styleWhen =
              listOf(
                PrototypeStyleWhen(
                  changedCondition,
                  PrototypeStyle(color = PrototypeModeValue.Single("#FF0000")),
                ),
              ),
          ),
        ),
      )
    val before = checkNotNull(compositions["root"])
    runtime.toggleStyle()
    assertEquals("icon really recomposed three times", before + 3, compositions["root"])
    assertEquals(1, count(PrototypeRenderWork.ICON_LOOKUP, "root"))
  }

  @Test
  fun `an image without authored dp size still measures through constraints`() {
    upload()
    show(spec(image().copy(style = PrototypeStyle(width = PrototypeDimension.Fill))))
    assertReady()
    assertEquals(1, count(PrototypeRenderWork.IMAGE_SUBCOMPOSITION, "root"))
  }

  @Test
  fun `replacing an asset reloads it`() {
    upload()
    show(spec(image()))
    assertReady()
    val launches = count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, ASSET_ID)
    compose.runOnIdle { upload() }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(launches + 1, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, ASSET_ID))
    assertEquals(2, decodes)
    assertEquals(1, shown("image"))
  }

  // #12133: FAIL-NOW large subtree retention and neighbour composition; disposal/wrap pins.
  private fun subtreeSpec(size: Int, transition: String?, motion: String? = "none") =
    spec(
      PrototypeBoxNode(
        children =
          listOf(
            PrototypeColumnNode(
              id = "X",
              visibleWhen = shownCondition,
              transition = transition,
              children = List(size) { PrototypeTextNode(text = "child $it", testTag = "child$it") },
            ),
          ),
      ),
      motion,
    )

  private fun assertChildrenReturned(size: Int) {
    repeat(size) { assertEquals("child $it returned", 1, shown("child$it")) }
  }

  private fun assertRetained(before: Map<String, Int>, size: Int) {
    assertChildrenReturned(size)
    val children = before.keys.filter { it.startsWith("root.children[0].") }
    assertEquals(size, children.size)
    children.forEach { assertEquals("retained $it", before[it], compositions[it]) }
  }

  @Test
  fun `a large none visibleWhen subtree is kept composed while hidden`() {
    val runtime = show(subtreeSpec(PROTOTYPE_RETAIN_MIN_NODES, "none"))
    val before = compositions.toMap()
    runtime.setShown(false)
    assertEquals(0, shown("child0", unmerged = false))
    assertFalse(
      compose
        .onNodeWithTag("child0", useUnmergedTree = true)
        .fetchSemanticsNode()
        .layoutInfo
        .isPlaced,
    )
    runtime.setShown(true)
    assertRetained(before, PROTOTYPE_RETAIN_MIN_NODES)
  }

  @Test
  fun `a large fade visibleWhen subtree is kept composed while hidden`() {
    val runtime = show(subtreeSpec(PROTOTYPE_RETAIN_MIN_NODES, "fade", motion = null))
    val before = compositions.toMap()
    runtime.setShown(false)
    assertEquals("exit is still in flight", 1, shown("child0"))
    settle()
    assertEquals(0, shown("child0", unmerged = false))
    assertFalse(
      compose
        .onNodeWithTag("child0", useUnmergedTree = true)
        .fetchSemanticsNode()
        .layoutInfo
        .isPlaced,
    )
    runtime.setShown(true)
    settle()
    assertRetained(before, PROTOTYPE_RETAIN_MIN_NODES)
  }

  @Test
  fun `an initially hidden retained fade subtree animates its first show`() {
    val authored = subtreeSpec(PROTOTYPE_RETAIN_MIN_NODES, "fade", motion = null)
    // Fixed parent bounds keep size animation from masquerading as an unfinished fade.
    val root =
      (authored.root as PrototypeBoxNode).copy(
        style =
          PrototypeStyle(
            width = PrototypeDimension.Dp(180.0),
            height = PrototypeDimension.Dp(180.0),
          ),
      )
    val runtime =
      show(
        authored.copy(
          state = authored.state.orEmpty() + ("show" to PrototypeScalar.BooleanValue(false)),
          root = root,
        ),
      )
    assertEquals(0, shown("child0"))
    assertTrue(compositions.keys.none { it.startsWith("root.children[0].") })
    assertFalse(compose.hasPendingWork())
    runtime.setShown(true)
    assertEquals(1, shown("child0", unmerged = false))
    assertTrue("first enter fade is still in flight", compose.hasPendingWork())
    settle()
    compose.waitForIdle()
    assertFalse("first enter fade settled", compose.hasPendingWork())
  }

  private fun pagerSpec(style: PrototypeStyle? = null) =
    spec(
      PrototypePagerNode(
        "pager",
        style = style,
        children = List(3) { PrototypeTextNode(text = "page $it", testTag = "page$it") },
      ),
    )

  private fun atStart(tag: String): Boolean =
    compose
      .onAllNodesWithTag(tag, useUnmergedTree = true)
      .fetchSemanticsNodes()
      .singleOrNull()
      ?.let { it.boundsInRoot.left == 0f } ?: false

  @Test
  fun `a pager keeps one neighbour page composed`() {
    val runtime = show(pagerSpec())
    assertTrue((compositions["root.children[0]"] ?: 0) >= 1)
    val before = compositions["root.children[1]"] ?: 0
    assertTrue("page 1 was composed before navigation", before >= 1)
    assertNull(compositions["root.children[2]"])
    assertEquals(0, shown("page1", unmerged = false))
    runtime.tapThenAdvance(PrototypeSetPageAction("pager", PrototypePageTarget.Index(1)))
    assertTrue(atStart("page1"))
    assertEquals(1, shown("page1"))
    assertTrue(
      "only a visibility recomposition is allowed",
      checkNotNull(compositions["root.children[1]"]) <= before + 1,
    )
  }

  private fun assertDisposed(size: Int, transition: String?) {
    val runtime = show(subtreeSpec(size, transition))
    val before = compositions.toMap()
    runtime.setShown(false)
    assertEquals(0, shown("child0"))
    runtime.setShown(true)
    assertChildrenReturned(size)
    repeat(size) {
      val identity = "root.children[0].children[$it]"
      assertEquals(identity, checkNotNull(before[identity]) + 1, compositions[identity])
    }
  }

  @Test
  fun `a small visibleWhen subtree is still disposed when hidden`() {
    assertDisposed(3, "none")
  }

  @Test
  fun `a default-transition subtree is still disposed`() {
    assertDisposed(PROTOTYPE_RETAIN_MIN_NODES, null)
  }

  @Test
  fun `a wrap-height pager composes only its current page`() {
    show(pagerSpec(PrototypeStyle(height = PrototypeDimension.Wrap)))
    assertTrue((compositions["root.children[0]"] ?: 0) >= 1)
    assertNull(compositions["root.children[1]"])
    assertNull(compositions["root.children[2]"])
    assertEquals(0, shown("page1"))
  }

  @Test
  fun `grandparent follows an animated box size without its own size animation`() {
    val runtime =
      show(
        spec(
          PrototypeColumnNode(
            children =
              listOf(
                PrototypeBoxNode(
                  children =
                    listOf(PrototypeTextNode(text = "detail", visibleWhen = shownCondition)),
                ),
                PrototypeTextNode(text = "below", testTag = "below"),
              ),
          ),
          motion = null,
        ),
      )
    val start = belowTop()
    runtime.tapThenAdvance(
      PrototypeSetStateAction("show", PrototypeScalar.BooleanValue(false)),
      frames = 5,
    )
    val midway = belowTop()
    settle()
    assertTrue("grandparent follows P frame by frame", midway > belowTop() && midway < start)
    assertEquals(setOf("root.children[0]"), identities(PrototypeRenderWork.SIZE_ANIMATION))
  }

  @Test
  fun `decoded bitmap exposes one ImageBitmap instance across reads`() {
    val image = BitmapPrototypeImage(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
    assertSame(image.imageBitmap, image.imageBitmap)
  }

  @Test
  fun `a never shown retained subtree has no child composition semantics or layout slot`() {
    val authored = subtreeSpec(PROTOTYPE_RETAIN_MIN_NODES, "none")
    val root = authored.root as PrototypeBoxNode
    val runtime =
      show(
        authored.copy(
          state = authored.state.orEmpty() + ("show" to PrototypeScalar.BooleanValue(false)),
          root =
            PrototypeColumnNode(
              children = root.children + PrototypeTextNode(text = "below", testTag = "below"),
            ),
        ),
      )
    assertEquals(0, shown("child0"))
    assertTrue(compositions.keys.none { it.startsWith("root.children[0].") })
    assertEquals(0f, belowTop(), 0.01f)
    runtime.setShown(true)
    assertChildrenReturned(PROTOTYPE_RETAIN_MIN_NODES)
  }

  private fun scrollOffset() =
    compose
      .onNodeWithTag("scroll", useUnmergedTree = true)
      .fetchSemanticsNode()
      .config[SemanticsProperties.VerticalScrollAxisRange]
      .value()

  @Test
  fun `a retained scroll resets its offset after a settled hide and show`() {
    val scroll =
      PrototypeScrollNode(
        testTag = "scroll",
        style = PrototypeStyle(height = PrototypeDimension.Dp(60.0)),
        child =
          PrototypeColumnNode(
            children =
              List(PROTOTYPE_RETAIN_MIN_NODES) {
                PrototypeTextNode(
                  text = "row $it",
                  style = PrototypeStyle(height = PrototypeDimension.Dp(24.0)),
                )
              },
          ),
      )
    val runtime =
      show(
        spec(
          PrototypeBoxNode(
            children =
              listOf(
                PrototypeBoxNode(
                  visibleWhen = shownCondition,
                  transition = "none",
                  children = listOf(scroll),
                ),
              ),
          ),
        ),
      )
    assertEquals(0f, scrollOffset(), 0.01f)
    compose.onNodeWithTag("scroll", useUnmergedTree = true).performSemanticsAction(
      SemanticsActions.ScrollBy,
    ) {
      assertTrue(it(0f, 100f))
    }
    settle()
    assertTrue("scroll moved before hiding", scrollOffset() > 0f)
    runtime.setShown(false)
    assertEquals(0, shown("scroll", unmerged = false))
    assertFalse(
      compose
        .onNodeWithTag("scroll", useUnmergedTree = true)
        .fetchSemanticsNode()
        .layoutInfo
        .isPlaced,
    )
    runtime.setShown(true)
    assertEquals(0f, scrollOffset(), 0.01f)
  }

  @Test
  fun `settled hidden retained children cannot receive taps and sibling content can`() {
    val change = PrototypeSetStateAction("changed", PrototypeScalar.BooleanValue(true))
    val outside = PrototypeSetStateAction("outside", PrototypeScalar.BooleanValue(true))
    val runtime =
      show(
        spec(
          PrototypeBoxNode(
            testTag = "parent",
            style =
              PrototypeStyle(
                width = PrototypeDimension.Dp(180.0),
                height = PrototypeDimension.Dp(180.0),
              ),
            children =
              listOf(
                PrototypeBoxNode(
                  visibleWhen = shownCondition,
                  transition = "none",
                  children =
                    listOf(
                      PrototypeColumnNode(
                        children =
                          List(PROTOTYPE_RETAIN_MIN_NODES) {
                            PrototypeTextNode(
                              text = "child $it",
                              testTag = "child$it",
                              onTap = listOf(change),
                            )
                          },
                      ),
                    ),
                ),
                PrototypeTextNode(
                  text = "outside",
                  testTag = "outside",
                  onTap = listOf(outside),
                  style = PrototypeStyle(offset = PrototypeOffset(100.0, 100.0)),
                ),
              ),
          ),
        ),
      )
    val former =
      compose
        .onNodeWithTag("child0", useUnmergedTree = true)
        .fetchSemanticsNode()
        .boundsInRoot
        .center
    val parent =
      compose
        .onNodeWithTag("parent", useUnmergedTree = true)
        .fetchSemanticsNode()
        .boundsInRoot
        .topLeft
    runtime.setShown(false)
    compose.onNodeWithTag("parent", useUnmergedTree = true).performTouchInput {
      click(former - parent)
    }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.snapshots.value.state["changed"])
    compose.onNodeWithTag("outside", useUnmergedTree = true).performTouchInput { click() }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(PrototypeScalar.BooleanValue(true), runtime.snapshots.value.state["outside"])
  }

  @Test
  fun `settled middle pager page retains both neighbours outside semantics`() {
    val runtime = show(pagerSpec())
    runtime.tapThenAdvance(PrototypeSetPageAction("pager", PrototypePageTarget.Index(1)))
    settle()
    listOf(0, 1, 2).forEach {
      assertTrue("page $it composed", (compositions["root.children[$it]"] ?: 0) >= 1)
      assertEquals(
        "only current page is semantic",
        if (it == 1) 1 else 0,
        shown("page$it", unmerged = it == 1),
      )
    }
  }

  @Test
  fun `a missing asset cache answer launches no load`() {
    var result: PrototypeImageState? = null
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeImageCache provides cache,
        LocalPrototypeRenderWorkProbe provides workProbe,
      ) {
        result = rememberPrototypeImage(ASSET_ID, PrototypeImageTarget(48, 48))
      }
    }
    compose.waitForIdle()
    assertEquals(PrototypeImageState.Missing, result)
    assertEquals(0, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, ASSET_ID))
  }

  private class QueuedImageDispatcher : CoroutineDispatcher() {
    private val pending = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
      pending.addLast(block)
    }

    fun drain() {
      while (pending.isNotEmpty()) pending.removeFirst().run()
    }
  }

  @Test
  fun `pending asset switches and replacements keep the previous decoded picture`() {
    upload()
    store.put("dark", "image/png", PrototypeAssetBytes.png())
    val dispatcher = QueuedImageDispatcher()
    val delayedCache = PrototypeImageCache(store, decoder, dispatcher = dispatcher)
    store.setChangeListener(delayedCache::invalidate)
    val asset = mutableStateOf(ASSET_ID)
    var result: PrototypeImageState? = null
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeImageCache provides delayedCache,
        LocalPrototypeRenderWorkProbe provides workProbe,
      ) {
        result = rememberPrototypeImage(asset.value, PrototypeImageTarget(48, 48))
      }
    }
    compose.waitForIdle()
    assertEquals(PrototypeImageState.Loading, result)
    compose.runOnIdle { dispatcher.drain() }
    compose.waitForIdle()
    val first = (result as PrototypeImageState.Ready).image
    compose.runOnIdle { asset.value = "dark" }
    compose.waitForIdle()
    assertSame(first, (result as PrototypeImageState.Ready).image)
    assertEquals(1, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, "dark"))
    compose.runOnIdle { dispatcher.drain() }
    compose.waitForIdle()
    val dark = (result as PrototypeImageState.Ready).image
    assertNotSame(first, dark)
    compose.runOnIdle { store.put("dark", "image/png", PrototypeAssetBytes.png()) }
    compose.waitForIdle()
    assertSame(dark, (result as PrototypeImageState.Ready).image)
    assertEquals(2, count(PrototypeRenderWork.IMAGE_LOAD_LAUNCH, "dark"))
    compose.runOnIdle { dispatcher.drain() }
    compose.waitForIdle()
    assertNotSame(dark, (result as PrototypeImageState.Ready).image)
  }
}
