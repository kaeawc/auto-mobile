package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeChartNode
import dev.jasonpearson.automobile.protocol.PrototypeChartSeries
import dev.jasonpearson.automobile.protocol.PrototypeDimension
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h640dp-mdpi")
class PrototypeChartLayoutTest {
  @get:Rule val compose = createComposeRule()

  private fun render(height: Dp? = null) {
    val spec =
      PrototypeSpec(
        "chart",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeChartNode(
            variant = "line",
            xLabels = "ends",
            series =
              listOf(PrototypeChartSeries(path = "/heart", x = "t", y = "bpm", label = "HR")),
            style =
              PrototypeStyle(height = height?.let { PrototypeDimension.Dp(it.value.toDouble()) }),
          ),
        data =
          Json.parseToJsonElement(
              """{"heart":[{"t":"6:00","bpm":58},{"t":"9:00","bpm":96},{"t":"18:00","bpm":72}]}""",
            )
            .jsonObject,
      )
    compose.setContent {
      MaterialTheme {
        // Apply the authored height as PrototypeSpecContent would before rendering the chart.
        RenderPrototypeChart(
          mapPrototypeSpec(spec).root,
          modifier =
            Modifier.testTag("chart").then(height?.let { Modifier.height(it) } ?: Modifier),
          labelModifier = Modifier.testTag("xl"),
        )
      }
    }
  }

  private fun assertEndLabelsVisible() {
    val chart = compose.onNodeWithTag("chart").getUnclippedBoundsInRoot()
    val labels = compose.onAllNodesWithTag("xl", useUnmergedTree = true)
    labels.assertCountEquals(2)
    for ((index, label) in listOf("6:00", "18:00").withIndex()) {
      val node = labels[index]
      node.assertExists()
      node.assertIsDisplayed()
      val bounds = node.getUnclippedBoundsInRoot()
      assertTrue("$label must have a positive height", bounds.bottom - bounds.top > 0.dp)
      assertTrue(
        "$label must fit inside the chart",
        bounds.top >= chart.top &&
          bounds.bottom <= chart.bottom &&
          bounds.left >= chart.left &&
          bounds.right <= chart.right,
      )
    }
  }

  @Test
  fun `a 90dp chart keeps both end labels visible`() {
    render(90.dp)
    compose.onNodeWithTag("chart").assertHeightIsEqualTo(90.dp)
    assertEndLabelsVisible()
  }

  @Test
  fun `a default height chart keeps labels below the 160dp canvas`() {
    render()
    assertEndLabelsVisible()
    val chart = compose.onNodeWithTag("chart").getUnclippedBoundsInRoot()
    val label =
      compose.onAllNodesWithTag("xl", useUnmergedTree = true)[0].getUnclippedBoundsInRoot()
    assertEquals(160.dp, label.top - chart.top)
  }
}
