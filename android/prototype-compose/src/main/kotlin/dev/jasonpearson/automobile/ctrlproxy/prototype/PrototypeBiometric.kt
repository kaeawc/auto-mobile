package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

data class PrototypeBiometricRequest(
  val title: String,
  val subtitle: String? = null,
  val allowDeviceCredential: Boolean = false,
)

enum class PrototypeBiometricOutcome {
  SUCCESS,
  ATTEMPT_FAILED,
  CANCELLED,
  NOT_ENROLLED,
  NO_HARDWARE,
  LOCKOUT,
  UNAVAILABLE,
  BUSY,
  ERROR,
}

/**
 * One collection owns one prompt. Cancellation must dismiss it without retaining biometric data.
 */
interface PrototypeBiometricSource {
  fun authenticate(request: PrototypeBiometricRequest): Flow<PrototypeBiometricOutcome>

  fun close()
}

class FakePrototypeBiometricSource : PrototypeBiometricSource {
  val requests = mutableListOf<PrototypeBiometricRequest>()
  var outcomes: Flow<PrototypeBiometricOutcome> = flowOf(PrototypeBiometricOutcome.SUCCESS)
  var closed = false

  override fun authenticate(request: PrototypeBiometricRequest): Flow<PrototypeBiometricOutcome> =
    flow {
      requests += request
      emitAll(outcomes)
    }

  override fun close() {
    closed = true
  }
}

/** Presence only: no biometric material or persistent authentication state leaves the prompt. */
class PrototypeBiometricModule(private val source: PrototypeBiometricSource) :
  PrototypePlatformModule {
  companion object {
    const val CAPABILITY = "prototype_platform_biometric_v1"
  }

  override val name = "biometric"
  override val capability = CAPABILITY
  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()
  private val mutableEvents = MutableSharedFlow<PlatformEvent>()
  override val events = mutableEvents.asSharedFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    if (call.call != "biometric.authenticate") return failure(PlatformErrorCode.UNSUPPORTED)
    if (PrototypePlatformCalls.argumentsError(call.call, call.args) != null)
      return failure(PlatformErrorCode.INVALID_ARGS)
    val request =
      PrototypeBiometricRequest(
        call.args.getValue("title").jsonPrimitive.content,
        call.args["subtitle"]?.jsonPrimitive?.content,
        call.args["allowDeviceCredential"]?.jsonPrimitive?.boolean ?: false,
      )
    // first() cancels collection on the terminal outcome, releasing the system prompt immediately.
    val outcome =
      source.authenticate(request).first { outcome ->
        if (outcome == PrototypeBiometricOutcome.ATTEMPT_FAILED) {
          mutableEvents.emit(PlatformEvent("biometric.attemptFailed", JsonObject(emptyMap())))
          false
        } else true
      }
    return when (outcome) {
      PrototypeBiometricOutcome.SUCCESS -> PlatformCallResult.Success(JsonObject(emptyMap()))
      PrototypeBiometricOutcome.CANCELLED -> failure(PlatformErrorCode.CANCELLED)
      PrototypeBiometricOutcome.NOT_ENROLLED ->
        failure(PlatformErrorCode.UNAVAILABLE, "not_enrolled")
      PrototypeBiometricOutcome.NO_HARDWARE -> failure(PlatformErrorCode.UNAVAILABLE, "no_hardware")
      PrototypeBiometricOutcome.LOCKOUT -> failure(PlatformErrorCode.UNAVAILABLE, "lockout")
      PrototypeBiometricOutcome.UNAVAILABLE -> failure(PlatformErrorCode.UNAVAILABLE)
      PrototypeBiometricOutcome.BUSY -> failure(PlatformErrorCode.TOO_MANY_IN_FLIGHT)
      else -> failure(PlatformErrorCode.PLATFORM_ERROR)
    }
  }

  internal fun session() = PrototypeBiometricModule(source)

  override fun close() = source.close()

  private fun failure(code: PlatformErrorCode, reason: String? = null) =
    PlatformCallResult.Failure(
      PlatformError(code, "Biometric authentication ${code.wireValue}", reason),
    )
}
