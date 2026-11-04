package dev.jasonpearson.automobile.automotivefixture.car

import android.text.Spanned
import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.Row
import dev.jasonpearson.automobile.automotivefixture.FixtureCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Robolectric supplies the android.text classes the place-list builder validates spans with.
@RunWith(RobolectricTestRunner::class)
class PoiPlaceListTemplateTest {
  @Test
  fun `place list builds with a distance span on every row`() {
    val template = poiPlaceListTemplate(FixtureCatalog.pois) {}

    val rows = template.itemList!!.items.map { it as Row }
    assertEquals(FixtureCatalog.pois.map { it.name }, rows.map { it.title.toString() })
    rows.forEach { row ->
      val text = row.texts.single().toCharSequence()
      assertTrue(text is Spanned)
      val spans = (text as Spanned).getSpans(0, text.length, DistanceSpan::class.java)
      assertEquals(1, spans.size)
    }
  }
}
