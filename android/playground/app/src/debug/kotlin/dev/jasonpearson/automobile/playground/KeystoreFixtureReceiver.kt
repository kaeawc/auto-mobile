package dev.jasonpearson.automobile.playground

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher

/** DUMP-guarded trigger packaged only in debug builds. */
class KeystoreFixtureReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_SEED -> seedFixture()
      ACTION_PROBE_AUTH_BOUND_KEY -> probeAuthBoundKey()
      else -> return
    }
  }

  private fun seedFixture() {
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

  private fun probeAuthBoundKey() {
    val outcome = runCatching {
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (!store.containsAlias(KeystoreFixtureSeeder.AUTH_BOUND_KEY_ALIAS))
        return@runCatching "absent"
      val key = store.getKey(KeystoreFixtureSeeder.AUTH_BOUND_KEY_ALIAS, null)
      Cipher.getInstance("AES/GCM/NoPadding").init(Cipher.ENCRYPT_MODE, key)
      "ok"
    }
    val error = outcome.exceptionOrNull()
    resultCode = Activity.RESULT_OK
    resultData = if (error == null) outcome.getOrThrow() else authBoundProbeOutcome(error)
  }

  private fun handleSeedFailure(error: Exception) {
    Log.e("KeystoreFixture", "Could not seed AndroidKeyStore fixture", error)
    resultCode = Activity.RESULT_CANCELED
    resultData = "Could not seed AndroidKeyStore fixture: ${error.javaClass.simpleName}"
  }

  companion object {
    const val ACTION_SEED =
      "dev.jasonpearson.automobile.playground.action.TEST_SEED_KEYSTORE_FIXTURE"
    const val ACTION_PROBE_AUTH_BOUND_KEY =
      "dev.jasonpearson.automobile.playground.action.PROBE_AUTH_BOUND_KEY"
  }
}

internal fun authBoundProbeOutcome(error: Throwable?): String =
  when (error) {
    null -> "ok"
    else -> error.javaClass.simpleName
  }
