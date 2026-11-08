package dev.jasonpearson.automobile.wearfixture.complication

import android.app.PendingIntent
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import dev.jasonpearson.automobile.wearfixture.LaunchRequest
import dev.jasonpearson.automobile.wearfixture.MainActivity
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog

/** Serves [FixtureComplications]; tapping the complication opens the featured item. */
class FixtureComplicationService : ComplicationDataSourceService() {
  override fun onComplicationRequest(
    request: ComplicationRequest,
    listener: ComplicationRequestListener,
  ) {
    listener.onComplicationData(FixtureComplications.data(request.complicationType, openItem()))
  }

  override fun getPreviewData(type: ComplicationType): ComplicationData? =
    FixtureComplications.data(type, null)

  private fun openItem(): PendingIntent =
    PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java)
        .putExtra(LaunchRequest.EXTRA_ITEM_ID, WearFixtureCatalog.FEATURED_ITEM_ID),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
