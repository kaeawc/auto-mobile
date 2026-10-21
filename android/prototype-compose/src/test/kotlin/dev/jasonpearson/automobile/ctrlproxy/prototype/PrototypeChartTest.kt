package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeChartNode
import dev.jasonpearson.automobile.protocol.PrototypeChartSeries
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidation
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypeChartTest {
  private val fixture: PrototypeSpec by lazy {
    val file =
      generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/valid/chart-variants.json") }
        .first { it.isFile }
    (PrototypeSpecValidator.validate(file.readText()) as PrototypeSpecValidation.Success).spec
  }

  private fun data(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

  private val line =
    PrototypeChartNode(
      variant = "line",
      series = listOf(PrototypeChartSeries(path = "/points", x = "t", y = "y", label = "Load")),
    )

  @Test
  fun `the shared fixture maps each chart to its summary label`() {
    val charts = mapPrototypeSpec(fixture).root.children
    assertEquals(
      listOf(
        "Line chart, Heart rate, 5 points, min 58, max 141, latest 72",
        "Area chart, Heart rate, 5 points, min 58, max 141, latest 72, goal 100",
        "Bar chart, Steps, 3 points, min 6200, max 10400, latest 10400; " +
          "Goal pace, 3 points, min 6200, max 10400, latest 10400, goal 10000",
        "Ring chart, Steps today, 6500 of 10000",
      ),
      charts.map { it.text },
    )
    assertEquals("chart", charts.first().role)
    assertEquals(40.0 to 160.0, charts.first().chart!!.let { it.yMin to it.yMax })
    assertEquals(
      listOf("6:00", "18:00"),
      charts.first().chart!!.series[0].points.let {
        listOf(it.first().x, it.last().x)
      },
    )
  }

  @Test
  fun `a data write re-reads the points`() {
    val before = mapPrototypeSpec(fixture).root.children.last().text
    val heart = fixture.data!!["heart"]!!
    val after =
      mapPrototypeSpec(
          fixture.copy(
            data =
              data("""{"today":[{"count":10500}],"steps":[]}""").let {
                JsonObject(it + ("heart" to heart))
              },
          ),
        )
        .root
        .children
    assertEquals("Ring chart, Steps today, 6500 of 10000", before)
    assertEquals("Ring chart, Steps today, 10500 of 10000", after.last().text)
    assertEquals("Bar chart, Steps, no points; Goal pace, no points, goal 10000", after[2].text)
  }

  @Test
  fun `points a later write broke are skipped and the axis never collapses`() {
    val chart =
      PrototypeChart.model(
        line,
        data("""{"points":[{"t":1,"y":3},5,{"t":"b","y":"high"},{"t":2.5,"y":3}]}"""),
      )
    assertEquals(listOf("1", "2.5"), chart.series[0].points.map { it.x })
    assertEquals(2.0 to 4.0, chart.yMin to chart.yMax)
    assertEquals("Line chart, Load, 2 points, min 3, max 3, latest 3", chart.summary)
  }

  @Test
  fun `bars rise from zero and a missing path is an empty series`() {
    val bars = line.copy(variant = "bar")
    assertEquals(0.0, PrototypeChart.model(bars, data("""{"points":[{"y":4}]}""")).yMin, 0.0)
    assertEquals("Bar chart, Load, no points", PrototypeChart.model(bars, null).summary)
  }

  @Test
  fun `numbers read with at most two decimals`() {
    assertEquals(
      listOf("72", "72.5", "0.33", "-1", "0", "1000000"),
      listOf(72.0, 72.5, 1.0 / 3, -1.0, -0.0, 1e6).map(PrototypeChart::format),
    )
  }
}
