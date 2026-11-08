package dev.jasonpearson.automobile.wearfixture.complication

import android.app.PendingIntent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog

/** Fixed complication values: short text and ranged value. Other types get no data. */
object FixtureComplications {
  val supportedTypes: List<ComplicationType> =
    listOf(ComplicationType.SHORT_TEXT, ComplicationType.RANGED_VALUE)

  fun data(type: ComplicationType, tapAction: PendingIntent?): ComplicationData? {
    val description = plain(WearFixtureCatalog.COMPLICATION_DESCRIPTION)
    return when (type) {
      ComplicationType.SHORT_TEXT ->
        ShortTextComplicationData.Builder(
            plain(WearFixtureCatalog.COMPLICATION_SHORT_TEXT),
            description,
          )
          .setTitle(plain(WearFixtureCatalog.COMPLICATION_TITLE))
          .setTapAction(tapAction)
          .build()
      ComplicationType.RANGED_VALUE ->
        RangedValueComplicationData.Builder(
            WearFixtureCatalog.RANGED_VALUE,
            WearFixtureCatalog.RANGED_MIN,
            WearFixtureCatalog.RANGED_MAX,
            description,
          )
          .setText(plain(WearFixtureCatalog.RANGED_TEXT))
          .setTitle(plain(WearFixtureCatalog.COMPLICATION_TITLE))
          .setTapAction(tapAction)
          .build()
      else -> null
    }
  }

  private fun plain(text: String): ComplicationText = PlainComplicationText.Builder(text).build()
}
