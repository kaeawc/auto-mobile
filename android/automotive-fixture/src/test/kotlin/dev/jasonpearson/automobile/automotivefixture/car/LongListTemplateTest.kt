package dev.jasonpearson.automobile.automotivefixture.car

import androidx.car.app.model.Row
import dev.jasonpearson.automobile.automotivefixture.FixtureCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LongListTemplateTest {
  @Test
  fun `long list builds with all thirty clickable rows`() {
    val template = longListTemplate(FixtureCatalog.longListTemplateRows) {}

    val rows = template.singleList!!.items.map { it as Row }
    assertEquals(30, rows.size)
    assertEquals("List 30", template.header!!.title.toString())
    assertEquals(
      FixtureCatalog.longListTemplateRows.map { it.title },
      rows.map { it.title.toString() },
    )
    assertEquals(
      FixtureCatalog.longListTemplateRows.map { it.subtitle },
      rows.map { it.texts.single().toString() },
    )
    rows.forEach { assertNotNull(it.onClickDelegate) }
  }
}
