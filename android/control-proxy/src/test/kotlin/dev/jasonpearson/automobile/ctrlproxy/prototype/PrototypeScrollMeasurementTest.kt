package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import dev.jasonpearson.automobile.protocol.*
import java.io.File
import java.util.Locale
import kotlin.math.ceil
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Opt-in wall-clock measurements under Robolectric, not device performance thresholds. */
@RunWith(RobolectricTestRunner::class)
class PrototypeScrollMeasurementTest {
  @get:Rule val compose = createComposeRule()

  private val controller =
    PrototypeController(
      FakePrototypeHost(),
      PrototypeResultSink { _, _, _ -> },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
    )

  @Test
  fun `measure benchmark list`() {
    Assume.assumeTrue(System.getenv("PROTOTYPE_SCROLL_MEASURE") == "1")
    val directory =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "benchmark/prototype-frame") }
        .first { File(it, "spec.json").isFile }
    val validation = PrototypeSpecValidator.validate(File(directory, "spec.json").readText())
    assertTrue(validation.toString(), validation is PrototypeSpecValidation.Success)
    val authored = (validation as PrototypeSpecValidation.Success).spec
    val scroll =
      renderNodes(mapPrototypeSpec(authored).root)
        .single { it.role == "scroll" && it.contentDescription == "Benchmark list" }
        .source as PrototypeScrollNode
    // Its original weight needs a Column parent. Give the isolated scroll a full viewport instead.
    val isolated =
      authored.copy(
        window = PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          scroll.copy(
            style =
              (scroll.style ?: PrototypeStyle()).copy(
                weight = null,
                height = PrototypeDimension.Fill,
              ),
          ),
        motion = "none",
      )
    val rows = rowTexts(renderNodes(mapPrototypeSpec(isolated).root))
    assertTrue("benchmark list has rows", rows.isNotEmpty())
    measure("benchmark-list", isolated, rows)
  }

  @Test
  fun `measure 87 rows`() {
    Assume.assumeTrue(System.getenv("PROTOTYPE_SCROLL_MEASURE") == "1")
    measureRows(87)
  }

  @Test
  fun `measure 200 rows`() {
    Assume.assumeTrue(System.getenv("PROTOTYPE_SCROLL_MEASURE") == "1")
    measureRows(200)
  }

  @Test
  fun `measure 500 rows`() {
    Assume.assumeTrue(System.getenv("PROTOTYPE_SCROLL_MEASURE") == "1")
    measureRows(500)
  }

  @Test
  fun `measure trivial column baseline`() {
    Assume.assumeTrue(System.getenv("PROTOTYPE_SCROLL_MEASURE") == "1")
    measure(
      "trivial-column",
      spec(PrototypeColumnNode(children = listOf(PrototypeTextNode(text = "Baseline")))),
      emptyList(),
    )
  }

  private fun spec(root: PrototypeNode) =
    PrototypeSpec(
      "scroll-measure",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = root,
      motion = "none",
    )

  private fun measureRows(count: Int) {
    val texts = List(count) { "Row $it" }
    val scroll =
      PrototypeScrollNode(
        style = PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Fill),
        child =
          PrototypeColumnNode(
            children =
              texts.map { text ->
                PrototypeRowNode(
                  style = PrototypeStyle(height = PrototypeDimension.Dp(36.0)),
                  children = listOf(PrototypeTextNode(text = text)),
                )
              },
          ),
      )
    measure("rows-$count", spec(scroll), texts)
  }

  private fun renderNodes(root: PrototypeRenderNode): List<PrototypeRenderNode> =
    listOf(root) + root.children.flatMap { renderNodes(it) }

  private fun semanticsNodes(root: SemanticsNode): List<SemanticsNode> =
    listOf(root) + root.children.flatMap { semanticsNodes(it) }

  private fun isRowText(text: String) = text.startsWith("Row ") || text.startsWith("List row ")

  private fun rowTexts(nodes: List<PrototypeRenderNode>) =
    nodes.filter { it.role == "text" && isRowText(it.text) }.map { it.text }

  private data class Sample(val nanos: Long, val semantics: Int, val compositions: Int)

  private fun measure(name: String, spec: PrototypeSpec, expectedRows: List<String>) {
    val nodeCount = renderNodes(mapPrototypeSpec(spec).root).size
    runBlocking { controller.show("measure", spec) }
    val runtime = checkNotNull(controller.activeRuntime)
    val runIndex = mutableStateOf(-1)
    var compositions = 0
    val compositionProbe: (String) -> Unit = { compositions++ }
    // Install the same work seam as PrototypeRenderWorkTest without adding timed bookkeeping.
    val workProbe: (PrototypeRenderWork, String) -> Unit = { _, _ -> }
    compose.setContent {
      Box(Modifier.fillMaxSize()) {
        CompositionLocalProvider(
          LocalPrototypeFillsWindow provides true,
          LocalPrototypeCompositionProbe provides compositionProbe,
          LocalPrototypeRenderWorkProbe provides workProbe,
        ) {
          if (runIndex.value >= 0) {
            key(runIndex.value) {
              PrototypeRuntimeContent(runtime) { controller.interact(runtime, it) }
            }
          }
        }
      }
    }
    compose.waitForIdle()
    val samples = mutableListOf<Sample>()
    // The initial empty host is untimed. Each key change disposes the previous content completely.
    repeat(5 + 15) { index ->
      var start = 0L
      compose.runOnIdle {
        compositions = 0
        start = System.nanoTime()
        runIndex.value = index
      }
      compose.waitForIdle()
      val nanos = System.nanoTime() - start
      val compositionCount = compositions
      // Queries and correctness checks are deliberately outside the timed span.
      val nodes = semanticsNodes(compose.onRoot(useUnmergedTree = true).fetchSemanticsNode())
      val rows = nodes.filter { node ->
        node.config.getOrNull(SemanticsProperties.Text).orEmpty().any { isRowText(it.text) }
      }
      assertEquals(
        "$name run $index: all rows, including off-screen rows",
        expectedRows.size,
        rows.size,
      )
      assertEquals(
        "$name run $index: each authored row is findable",
        expectedRows.sorted(),
        rows.flatMap { it.config[SemanticsProperties.Text].map { text -> text.text } }.sorted(),
      )
      if (expectedRows.isEmpty()) {
        assertEquals(
          "baseline text is composed",
          1,
          nodes.count {
            it.config.getOrNull(SemanticsProperties.Text).orEmpty().any { text ->
              text.text == "Baseline"
            }
          },
        )
      }
      if (index >= 5) samples += Sample(nanos, nodes.size, compositionCount)
    }
    val times = samples.map { it.nanos }.sorted()
    val median = times[times.size / 2] / 1_000_000.0
    // Nearest-rank p90: rank 14 of the 15 measured samples.
    val p90 = times[ceil(times.size * 0.9).toInt() - 1] / 1_000_000.0
    // Counts are also recorded per run; the line reports their medians.
    val semantics = samples.map { it.semantics }.sorted()[samples.size / 2]
    val composed = samples.map { it.compositions }.sorted()[samples.size / 2]
    // The trivial column has one text, so its per-row divisor is one.
    val perRow = median * 1_000.0 / expectedRows.size.coerceAtLeast(1)
    val line =
      String.format(
        Locale.US,
        "SCROLL-MEASURE scenario=%s renderNodes=%d semanticsNodes=%d compositions=%d " +
          "median_ms=%.2f p90_ms=%.2f min_ms=%.2f per_row_us=%.1f",
        name,
        nodeCount,
        semantics,
        composed,
        median,
        p90,
        times.first() / 1_000_000.0,
        perRow,
      )
    println(line)
    System.getenv("PROTOTYPE_SCROLL_MEASURE_OUT")?.let { File(it).appendText("$line\n") }
  }
}
