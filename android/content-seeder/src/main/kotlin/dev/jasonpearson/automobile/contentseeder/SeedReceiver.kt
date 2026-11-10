package dev.jasonpearson.automobile.contentseeder

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.database.SQLException
import android.util.Log

/**
 * Send an ordered explicit broadcast with action dev.jasonpearson.automobile.contentseeder.SEED.
 * Success returns the inserted URI as result data; failures return RESULT_CANCELED and a reason.
 */
class SeedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_SEED) {
      setResult(Activity.RESULT_CANCELED, "Expected action $ACTION_SEED", null)
      return
    }
    try {
      val parameters = PARAMETER_NAMES.associateWith { intent.getStringExtra(it) }
      when (val parsed = parseSeedRequest(parameters)) {
        is SeedParseResult.Invalid -> setResult(Activity.RESULT_CANCELED, parsed.message, null)
        is SeedParseResult.Valid -> {
          val uri = ContentSeeder(context).seed(parsed.request)
          setResult(Activity.RESULT_OK, uri.toString(), null)
        }
      }
    } catch (error: SecurityException) {
      fail(error)
    } catch (error: IllegalArgumentException) {
      fail(error)
    } catch (error: IllegalStateException) {
      fail(error)
    } catch (error: SQLException) {
      fail(error)
    }
  }

  private fun fail(error: Exception) {
    Log.e(
      "ContentSeeder",
      "Seeding failed; check the SMS role and runtime permission grants",
      error,
    )
    setResult(Activity.RESULT_CANCELED, "Seeding failed: ${error.message}", null)
  }

  companion object {
    private const val ACTION_SEED = "dev.jasonpearson.automobile.contentseeder.SEED"
    private val PARAMETER_NAMES =
      listOf("kind", "title", "startMillis", "endMillis", "address", "body", "dateMillis")
  }
}
