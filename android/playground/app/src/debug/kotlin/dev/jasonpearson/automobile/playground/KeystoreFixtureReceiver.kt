package dev.jasonpearson.automobile.playground

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.ProviderException

/** DUMP-guarded trigger packaged only in debug builds. */
class KeystoreFixtureReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_SEED) return
    try {
      KeystoreFixtureSeeder(AndroidKeystoreFixtureStore()).seed()
      resultCode = Activity.RESULT_OK
      resultData = "Keystore fixture seeded"
    } catch (error: GeneralSecurityException) {
      handleSeedFailure(error)
    } catch (error: IOException) {
      handleSeedFailure(error)
    } catch (error: ProviderException) {
      handleSeedFailure(error)
    } catch (error: IllegalArgumentException) {
      handleSeedFailure(error)
    } catch (error: IllegalStateException) {
      handleSeedFailure(error)
    }
  }

  private fun handleSeedFailure(error: Exception) {
    Log.e("KeystoreFixture", "Could not seed AndroidKeyStore fixture", error)
    resultCode = Activity.RESULT_CANCELED
    resultData = "Could not seed AndroidKeyStore fixture: ${error.javaClass.simpleName}"
  }

  companion object {
    const val ACTION_SEED =
      "dev.jasonpearson.automobile.playground.action.TEST_SEED_KEYSTORE_FIXTURE"
  }
}
