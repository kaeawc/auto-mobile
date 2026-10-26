package dev.jasonpearson.automobile.protoviewer

import android.content.Context
import android.content.res.Configuration
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.LayoutDirection
import androidx.test.core.app.ApplicationProvider
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Chrome only, using repository/settings fakes and no database or network. Accessibility Test
 * Framework / ui-test-junit4-accessibility was NOT added: in-repo semantics assertions keep the
 * dependency set unchanged. Each method reuses one Compose rule across all configuration cells.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ChromeA11yMatrixTest {
  // A real activity per cell: popups and dialogs take their resources from the host window's
  // context, so a CompositionLocal-only locale override would leave menus in English.
  @get:Rule val compose = createEmptyComposeRule()

  private data class Cell(val locale: String, val dark: Boolean, val scale: Float) {
    val direction = if (locale == "ar-XB") LayoutDirection.Rtl else LayoutDirection.Ltr

    override fun toString() = "$locale/${if (dark) "dark" else "light"}/font=$scale"
  }

  private data class Frame(val cell: Cell, val name: String, val content: @Composable () -> Unit)

  private var frame by mutableStateOf<Frame?>(null)
  private var density = 1f
  private var observedDirection = LayoutDirection.Ltr
  private var controller: ActivityController<ComponentActivity>? = null
  private var hosted: Cell? = null
  private var size = PHONE
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @After
  fun closeActivity() {
    controller?.pause()?.stop()?.destroy()
    controller = null
  }

  @Test fun libraryPhone() = libraryMatrix()

  @Test fun libraryTablet() = libraryMatrix(TABLET)

  @Test fun viewerPhone() = viewerMatrix()

  @Test fun viewerTablet() = viewerMatrix(TABLET)

  @Test fun dialogsAndImportPhone() = dialogsAndImportMatrix()

  @Test fun dialogsAndImportTablet() = dialogsAndImportMatrix(TABLET)

  private fun startMatrix(sizeQualifiers: String) {
    size = sizeQualifiers
    frame = null
  }

  private fun host(cell: Cell) {
    if (hosted == cell) return
    closeActivity()
    val language = cell.locale.replace("-X", "-rX")
    RuntimeEnvironment.setQualifiers(
      "$language-$size-${if (cell.dark) "night" else "notnight"}-mdpi",
    )
    RuntimeEnvironment.setFontScale(cell.scale)
    val created = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    controller = created
    hosted = cell
    density = created.get().resources.displayMetrics.density
    created.get().setContent {
      frame?.let { current ->
        key(current) {
          observedDirection = LocalLayoutDirection.current
          ProtoViewerTheme { current.content() }
        }
      }
    }
  }

  private fun configuredContext(cell: Cell): Context {
    if (hosted == cell) return controller!!.get()
    val configuration =
      Configuration(context.resources.configuration).apply {
        setLocale(Locale.forLanguageTag(cell.locale))
        fontScale = cell.scale
      }
    return context.createConfigurationContext(configuration)
  }

  private fun cells(): List<Cell> =
    listOf("en", "ar-XB", "en-XA").flatMap { locale ->
      listOf(false, true).flatMap { dark -> listOf(1f, 2f).map { Cell(locale, dark, it) } }
    }

  private fun render(cell: Cell, name: String, content: @Composable () -> Unit) {
    val english = configuredContext(Cell("en", false, 1f)).getString(R.string.empty_library)
    if (cell.locale != "en") {
      assertNotEquals(
        "$cell must load generated pseudolocale resources",
        english,
        configuredContext(cell).getString(R.string.empty_library),
      )
    }
    host(cell)
    compose.runOnIdle { frame = Frame(cell, name, content) }
    compose.waitForIdle()
    assertEquals("$cell/$name layout direction", cell.direction, observedDirection)
  }

  private fun libraryMatrix(sizeQualifiers: String = PHONE) {
    startMatrix(sizeQualifiers)
    val repository = FakeLibraryRepository()
    val settings = FakeSettingsStore()
    for (cell in cells()) {
      val scenarios = listOf("empty", "entries", "failure", "loading", "denied", "network")
      for (scenario in scenarios) {
        repository.prototypes.clear()
        if (scenario == "entries") {
          repository.prototypes[FIRST] =
            Fixtures.prototype()
              .copy(
                entry =
                  Fixtures.entry()
                    .copy(
                      label = "A very long imported prototype label that wraps over several lines",
                    ),
              )
          repository.prototypes[SECOND] = Fixtures.prototype(SECOND)
        }
        repository.error = if (scenario == "failure") LibraryError.Storage else null
        settings.setAllowNetwork(scenario == "network")
        val result = if (scenario == "loading") null else repository.list()
        val allowNetwork = settings.allowNetwork.value
        render(cell, "library/$scenario") {
          LibraryScreen(
            result,
            scenario == "denied",
            { _, _, _ -> },
            allowNetwork = allowNetwork,
            localNetworkDenied = scenario == "denied",
            setAllowNetwork = settings::setAllowNetwork,
          )
        }
        assertHeading(cell)
        assertNetworkDirection(cell)
        assertChrome(cell, scroll = true)
        if (scenario == "entries") assertLibraryEntries(cell)
        else assertLibraryMessages(cell, scenario)
      }
    }
  }

  private fun assertLibraryMessages(cell: Cell, scenario: String) {
    val messages =
      when (scenario) {
        "loading" -> listOf(R.string.loading)
        "failure" -> listOf(R.string.library_error)
        "denied" ->
          listOf(R.string.local_network_denied, R.string.action_error, R.string.empty_library)
        else -> listOf(R.string.empty_library)
      }
    for (message in messages) {
      compose
        .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
        .performScrollToNode(hasText(configuredContext(cell).getString(message)))
      assertChrome(cell, scroll = true)
    }
  }

  private fun assertNetworkDirection(cell: Cell) {
    val switch = compose.onNodeWithTag("allow-network").fetchSemanticsNode().boundsInRoot
    val label =
      compose
        .onNodeWithText(
          configuredContext(cell).getString(R.string.allow_network),
          useUnmergedTree = true,
        )
        .fetchSemanticsNode()
        .boundsInRoot
    assertEquals(
      "$cell network switch mirrors relative to its headline",
      cell.direction == LayoutDirection.Rtl,
      switch.center.x < label.center.x,
    )
  }

  private fun assertLibraryEntries(cell: Cell) {
    for (id in listOf(FIRST, SECOND)) {
      val tag = "library-$id"
      compose
        .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
        .performScrollToNode(hasTestTag(tag))
      val row = compose.onNodeWithTag(tag).fetchSemanticsNode()
      assertEquals("$cell row role", Role.Button, row.config.getOrNull(SemanticsProperties.Role))
      assertTrue(
        "$cell row click label",
        !row.config.getOrNull(SemanticsActions.OnClick)?.label.isNullOrBlank(),
      )
      assertChrome(cell, scroll = true)
    }
    // Exercise app-owned dropdown and delete dialog as well as the always-visible chrome.
    val more = configuredContext(cell).getString(R.string.more, Fixtures.entry(SECOND).label)
    compose
      .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex))
      .performScrollToNode(hasTestTag("library-$SECOND"))
    compose
      .onNode(
        SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(more)),
        useUnmergedTree = true,
      )
      .performScrollTo()
      .performClick()
    assertChrome(cell, overlay = true)
    compose.onNodeWithText(configuredContext(cell).getString(R.string.delete)).performClick()
    assertChrome(cell, overlay = true)
  }

  private fun viewerMatrix(sizeQualifiers: String = PHONE) {
    startMatrix(sizeQualifiers)
    val states =
      listOf(ViewerScreenState.Loading) + LibraryError.entries.map { ViewerScreenState.Error(it) }
    for (cell in cells()) {
      for (state in states) {
        render(cell, "viewer/$state") {
          Column {
            ViewerChrome(true, true, false, {}, {})
            ViewerStatus(state) {}
          }
        }
        assertHeading(cell)
        assertChrome(cell, scroll = true)
      }
    }
  }

  private fun dialogsAndImportMatrix(sizeQualifiers: String = PHONE) {
    startMatrix(sizeQualifiers)
    for (cell in cells()) {
      render(cell, "reset") { ResetConfirmation({}, {}) }
      assertChrome(cell)
      val messages =
        listOf(R.string.loading, R.string.import_interrupted, R.string.import_unavailable)
      for (message in messages) {
        render(cell, "import/$message") { ImportStatus(stringResource(message)) {} }
        assertChrome(cell)
      }
      render(cell, "import/rejected") { ImportStatus("spec.json: Invalid prototype") {} }
      assertChrome(cell)
    }
  }

  private fun assertHeading(cell: Cell) {
    val headings =
      compose
        .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
        .fetchSemanticsNodes()
    assertTrue("$cell/${frame?.name} needs a heading", headings.isNotEmpty())
  }

  private fun assertChrome(cell: Cell, scroll: Boolean = false, overlay: Boolean = false) {
    assertTextLayouts(cell, overlay)
    val actions =
      compose
        .onAllNodes(
          SemanticsMatcher("clickable or toggleable in active surface") {
            (!overlay || inOverlay(it)) &&
              (it.config.contains(SemanticsActions.OnClick) ||
                it.config.contains(SemanticsProperties.ToggleableState))
          },
        )
        .fetchSemanticsNodes()
    for (node in actions) {
      val matcher = SemanticsMatcher("node ${node.id}") { it.id == node.id }
      val interaction = compose.onNode(matcher)
      // Lazy prefetch may disappear while another target is scrolled into view; entries are also
      // explicitly brought into view by assertLibraryEntries, so none escape the checks.
      if (scroll && compose.onAllNodes(matcher).fetchSemanticsNodes().isEmpty()) continue
      val bounds = interaction.fetchSemanticsNode().touchBoundsInRoot
      if (scroll && (bounds.width / density < 48f || bounds.height / density < 48f)) {
        interaction.performScrollTo()
      }
      val current = interaction.fetchSemanticsNode()
      assertAccessibleTarget(cell, current)
    }
    assertTextLayouts(cell, overlay)
  }

  private fun inOverlay(node: SemanticsNode): Boolean =
    generateSequence(node) { it.parent }
      .any {
        it.config.contains(SemanticsProperties.IsPopup) ||
          it.config.contains(SemanticsProperties.IsDialog)
      }

  private fun assertAccessibleTarget(cell: Cell, node: SemanticsNode) {
    val text = node.config.getOrNull(SemanticsProperties.Text).orEmpty().joinToString { it.text }
    val description =
      node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().joinToString()
    val message = "$cell/${frame?.name}/node=${node.id} text=$text description=$description"
    assertTrue("$message needs an accessible name", text.isNotBlank() || description.isNotBlank())
    val bounds = node.touchBoundsInRoot
    assertTrue(
      "$message touch bounds $bounds must be at least 48dp",
      bounds.width / density >= 48f && bounds.height / density >= 48f,
    )
  }

  private fun assertTextLayouts(cell: Cell, overlay: Boolean) {
    val texts =
      compose
        .onAllNodes(
          SemanticsMatcher("text layout in active surface") {
            it.config.contains(SemanticsActions.GetTextLayoutResult) && (!overlay || inOverlay(it))
          },
          useUnmergedTree = true,
        )
        .fetchSemanticsNodes()
    assertTrue("$cell/${frame?.name} must expose text layouts", texts.isNotEmpty())
    compose.runOnIdle {
      for (node in texts) {
        val layouts = mutableListOf<TextLayoutResult>()
        val action = node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action
        assertTrue(
          "$cell/${frame?.name} missing text layout for ${node.id}",
          action?.invoke(layouts) == true,
        )
        assertTrue("$cell/${frame?.name} empty text layouts for ${node.id}", layouts.isNotEmpty())
        for (layout in layouts) {
          assertNotTruncated("$cell/${frame?.name}: ${layout.layoutInput.text}", node, layout)
        }
      }
    }
  }

  /**
   * `hasVisualOverflow` compares the node to the paragraph's layout width, so it is true for any
   * text narrower than its constraint. Truncation here means: lines dropped by a line limit, an
   * ellipsized line, text cut before its end, or a node smaller than the laid-out text.
   */
  private fun assertNotTruncated(message: String, node: SemanticsNode, layout: TextLayoutResult) {
    val last = layout.lineCount - 1
    assertFalse("$message exceeded max lines", layout.multiParagraph.didExceedMaxLines)
    assertFalse("$message has an ellipsized line", (0..last).any { layout.isLineEllipsized(it) })
    assertTrue(
      "$message is cut before its end",
      layout.getLineEnd(last, visibleEnd = true) >= layout.layoutInput.text.trimEnd().length,
    )
    val widest = (0..last).maxOf { layout.getLineRight(it) - layout.getLineLeft(it) }
    assertTrue(
      "$message node ${node.size} is narrower than its text $widest",
      node.size.width + 1 >= widest,
    )
    assertTrue(
      "$message node ${node.size} is shorter than its text ${layout.multiParagraph.height}",
      node.size.height + 1 >= layout.multiParagraph.height,
    )
  }

  private companion object {
    const val PHONE = "w360dp-h640dp"
    const val TABLET = "w800dp-h1280dp"
  }
}
