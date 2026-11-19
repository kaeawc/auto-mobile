package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.Activity
import android.content.pm.PackageManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.*

/** Framework boundary, injected independently of the coroutine and outcome policy. */
internal interface AndroidBiometricGateway {
  val sdk: Int
  val foreground: Boolean

  fun canAuthenticate(credential: Boolean): Int

  fun show(
    request: PrototypeBiometricRequest,
    deliver: (PrototypeBiometricOutcome) -> Unit,
  ): () -> Unit
}

class AndroidBiometricSource
internal constructor(
  private val gateway: AndroidBiometricGateway,
  private val dispatcher: CoroutineDispatcher,
) : PrototypeBiometricSource {
  constructor(
    activity: Activity,
  ) : this(FrameworkBiometricGateway(activity), Dispatchers.Main.immediate)

  private var finish: (() -> Unit)? = null
  private var closed = false

  override fun authenticate(request: PrototypeBiometricRequest): Flow<PrototypeBiometricOutcome> =
    callbackFlow {
      val refusal =
        when {
          closed -> PrototypeBiometricOutcome.UNAVAILABLE
          gateway.sdk < 28 || (gateway.sdk == 28 && request.allowDeviceCredential) ->
            PrototypeBiometricOutcome.NO_HARDWARE
          !gateway.foreground -> PrototypeBiometricOutcome.UNAVAILABLE
          finish != null -> PrototypeBiometricOutcome.BUSY
          else -> biometricError(gateway.canAuthenticate(request.allowDeviceCredential))
        }
      if (refusal != null) {
        trySend(refusal)
        close()
        return@callbackFlow
      }
      val end = {
        trySend(PrototypeBiometricOutcome.CANCELLED)
        close()
        Unit
      }
      finish = end
      try {
        val cancel =
          gateway.show(request) { outcome ->
            trySend(outcome)
            if (outcome != PrototypeBiometricOutcome.ATTEMPT_FAILED) close()
          }
        awaitClose { cancel() }
      } finally {
        if (finish === end) finish = null
      }
    }
    .buffer(Channel.UNLIMITED)
    .flowOn(dispatcher)

  // Hosts and composition disposal call close on main, like the other Android platform sources.
  override fun close() {
    closed = true
    finish?.invoke()
  }
}

/** Error constants shared by framework canAuthenticate and AuthenticationCallback. */
internal fun biometricError(code: Int): PrototypeBiometricOutcome? =
  when (code) {
    0 -> null
    BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
    BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED -> PrototypeBiometricOutcome.CANCELLED
    BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS,
    BiometricPrompt.BIOMETRIC_ERROR_NO_DEVICE_CREDENTIAL -> PrototypeBiometricOutcome.NOT_ENROLLED
    BIOMETRIC_ERROR_HW_NOT_PRESENT,
    BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE -> PrototypeBiometricOutcome.NO_HARDWARE
    BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT,
    BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT -> PrototypeBiometricOutcome.LOCKOUT
    else -> PrototypeBiometricOutcome.ERROR
  }

private class FrameworkBiometricGateway(private val activity: Activity) : AndroidBiometricGateway {
  override val sdk
    get() = Build.VERSION.SDK_INT

  override val foreground
    get() = !activity.isFinishing && !activity.isDestroyed && activity.hasWindowFocus()

  @Suppress("DEPRECATION") // API 28 has no BiometricManager; API 29 has only the no-arg preflight.
  override fun canAuthenticate(credential: Boolean): Int =
    when {
      Build.VERSION.SDK_INT >= 30 ->
        activity
          .getSystemService(BiometricManager::class.java)
          .canAuthenticate(authenticators(credential))
      Build.VERSION.SDK_INT >= 29 ->
        activity.getSystemService(BiometricManager::class.java).canAuthenticate()
      // API 28 exposes no BiometricManager. The prompt reports enrollment and lockout errors.
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) -> 0
      else -> BIOMETRIC_ERROR_HW_NOT_PRESENT
    }

  @RequiresApi(28)
  @Suppress("DEPRECATION") // Framework credential fallback on API 29 predates authenticator flags.
  override fun show(
    request: PrototypeBiometricRequest,
    deliver: (PrototypeBiometricOutcome) -> Unit,
  ): () -> Unit {
    val builder = BiometricPrompt.Builder(activity).setTitle(request.title)
    request.subtitle?.let { builder.setSubtitle(it) }
    if (Build.VERSION.SDK_INT >= 30)
      builder.setAllowedAuthenticators(authenticators(request.allowDeviceCredential))
    else if (Build.VERSION.SDK_INT == 29)
      builder.setDeviceCredentialAllowed(request.allowDeviceCredential)
    if (!request.allowDeviceCredential)
      builder.setNegativeButton("Cancel", activity.mainExecutor) { _, _ ->
        deliver(PrototypeBiometricOutcome.CANCELLED)
      }
    val cancellation = CancellationSignal()
    builder
      .build()
      .authenticate(
        cancellation,
        activity.mainExecutor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            deliver(PrototypeBiometricOutcome.SUCCESS)
          }

          override fun onAuthenticationFailed() {
            deliver(PrototypeBiometricOutcome.ATTEMPT_FAILED)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            deliver(biometricError(errorCode) ?: PrototypeBiometricOutcome.ERROR)
          }
        },
      )
    return { cancellation.cancel() }
  }

  @RequiresApi(30)
  private fun authenticators(credential: Boolean) =
    BiometricManager.Authenticators.BIOMETRIC_STRONG or
      (if (credential) BiometricManager.Authenticators.DEVICE_CREDENTIAL else 0)
}

// BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT, which only API 28 declares.
private const val BIOMETRIC_ERROR_HW_NOT_PRESENT = 12
