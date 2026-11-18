package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

/** Device-local values only. Implementations must never attach payloads to errors. */
interface PrototypeSecureValueStore {
  fun load(id: String): PrototypeStoredValues?

  fun save(id: String, stored: PrototypeStoredValues)

  fun delete(id: String): Int
}

/** Membership advertises persistence support; secure storage has no platform calls. */
class PrototypeSecureStorageModule(val store: PrototypeSecureValueStore) : PrototypePlatformModule {
  override val name = "secureStorage"
  override val capability = CAPABILITY
  override val state = MutableStateFlow(buildJsonObject { put("locked", false) }).asStateFlow()
  override val events: Flow<PlatformEvent> = emptyFlow()

  override fun availability() = PlatformAvailability.Ready

  override suspend fun call(call: PlatformCall) =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.UNSUPPORTED, "Secure storage has no platform calls"),
    )

  override fun close() = Unit

  companion object {
    const val CAPABILITY = "prototype_platform_secureStorage_v1"

    fun fileBacked(context: Context) =
      PrototypeSecureStorageModule(
        PrototypeSecureValueStores.inDirectory(
          prototypeStorageRoot(context.applicationContext.filesDir),
        ),
      )
  }
}

/** Public wire state omits secure entries, including biometric-bound live-only values. */
fun prototypePublicState(spec: dev.jasonpearson.automobile.protocol.PrototypeSpec) =
  spec.state.orEmpty().filterKeys { "state:$it" !in spec.storage?.secure.orEmpty() }
