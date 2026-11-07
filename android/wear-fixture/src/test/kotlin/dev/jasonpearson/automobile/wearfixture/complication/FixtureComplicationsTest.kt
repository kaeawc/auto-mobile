package dev.jasonpearson.automobile.wearfixture.complication

import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

// The complication data builders call into android.os and android.graphics, which only Robolectric
// backs on the JVM.
@RunWith(RobolectricTestRunner::class)
class FixtureComplicationsTest {
  @Test
  fun `short text carries the fixed title and value`() {
    val data =
      FixtureComplications.data(ComplicationType.SHORT_TEXT, null) as ShortTextComplicationData
    assertEquals("07", read(data.text))
    assertEquals("Item", read(data.title))
    assertEquals("Fixture complication", read(data.contentDescription))
  }

  @Test
  fun `ranged value sits at seven of ten`() {
    val data =
      FixtureComplications.data(ComplicationType.RANGED_VALUE, null) as RangedValueComplicationData
    assertEquals(7f, data.value, 0f)
    assertEquals(0f, data.min, 0f)
    assertEquals(10f, data.max, 0f)
    assertEquals("7/10", read(data.text))
  }

  @Test
  fun `unsupported types get no data`() {
    assertEquals(
      listOf(ComplicationType.SHORT_TEXT, ComplicationType.RANGED_VALUE),
      FixtureComplications.supportedTypes,
    )
    assertNull(FixtureComplications.data(ComplicationType.LONG_TEXT, null))
  }

  private fun read(text: ComplicationText?): String =
    text!!.getTextAt(RuntimeEnvironment.getApplication().resources, Instant.EPOCH).toString()
}
