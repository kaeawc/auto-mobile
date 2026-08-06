package dev.jasonpearson.automobile.sdk.capabilities

import kotlinx.serialization.Serializable
import java.util.LinkedHashMap

/** The lifecycle or availability state of an SDK capability. */
@Serializable
enum class SdkCapabilityState {
  SUPPORTED,
  DISABLED,
  UNSUPPORTED,
  PERMISSION_DENIED,
  NOT_INITIALIZED,
}

/** A stable identifier and current availability state for one SDK capability. */
@Serializable
data class SdkCapabilityDescriptor(
  val id: String,
  val state: SdkCapabilityState,
  val reason: String? = null,
)

/** Explicit controls for potentially sensitive capture and mutation behavior. */
@Serializable
data class SdkCapturePolicy(
  val captureHeaders: Boolean = false,
  val captureBodies: Boolean = false,
  val allowMutations: Boolean = false,
)

/** Versioned machine-readable description of the SDK integration. */
@Serializable
data class SdkCapabilityDocument(
  val schemaVersion: Int = 1,
  val capabilities: List<SdkCapabilityDescriptor>,
  val policy: SdkCapturePolicy,
)

/**
 * Thread-safe capability and policy registry.
 *
 * Registration replaces an existing descriptor with the same id. Policy changes replace the
 * complete immutable policy snapshot after validating that sensitive access has an available
 * capability.
 */
internal class SdkCapabilityRegistry {
  private val lock = Any()
  private val descriptors = LinkedHashMap<String, SdkCapabilityDescriptor>()
  private var initialized = false
  private var enabled = true
  private var policy = SdkCapturePolicy()

  init {
    registerDefaults()
  }

  fun markInitialized() {
    synchronized(lock) { initialized = true }
  }

  fun markShutdown() {
    synchronized(lock) {
      initialized = false
      enabled = true
      policy = SdkCapturePolicy()
      descriptors.clear()
      registerDefaults()
    }
  }

  fun setEnabled(value: Boolean) {
    synchronized(lock) { enabled = value }
  }

  fun register(descriptor: SdkCapabilityDescriptor) {
    require(descriptor.id.isNotBlank()) { "Capability id must not be blank" }
    synchronized(lock) { descriptors[descriptor.id] = descriptor }
  }

  fun unregister(id: String) {
    synchronized(lock) { descriptors.remove(id) }
  }

  fun updatePolicy(next: SdkCapturePolicy) {
    synchronized(lock) {
      if (next.allowMutations) {
        require(isSupported("storage.mutation")) {
          "Mutation access requires the storage.mutation capability"
        }
      }
      if (next.captureHeaders || next.captureBodies) {
        require(isSupported("network.capture")) {
          "Payload or header capture requires the network.capture capability"
        }
      }
      policy = next
    }
  }

  fun snapshot(): SdkCapabilityDocument {
    synchronized(lock) {
      val visible =
        descriptors.values.map { descriptor ->
          when {
            !initialized && descriptor.state != SdkCapabilityState.UNSUPPORTED ->
              descriptor.copy(
                state = SdkCapabilityState.NOT_INITIALIZED,
                reason = "SDK has not been initialized",
              )
            !enabled && descriptor.state == SdkCapabilityState.SUPPORTED ->
              descriptor.copy(
                state = SdkCapabilityState.DISABLED,
                reason = "SDK tracking is disabled",
              )
            else -> descriptor
          }
        }
      return SdkCapabilityDocument(capabilities = visible, policy = policy)
    }
  }

  private fun isSupported(id: String): Boolean {
    val descriptor = descriptors[id]
    return initialized && enabled && descriptor?.state == SdkCapabilityState.SUPPORTED
  }

  private fun registerDefaults() {
    descriptors["events.navigation"] =
      SdkCapabilityDescriptor("events.navigation", SdkCapabilityState.SUPPORTED)
    descriptors["events.lifecycle"] =
      SdkCapabilityDescriptor("events.lifecycle", SdkCapabilityState.SUPPORTED)
    descriptors["network.capture"] =
      SdkCapabilityDescriptor("network.capture", SdkCapabilityState.SUPPORTED)
    descriptors["storage.read"] =
      SdkCapabilityDescriptor("storage.read", SdkCapabilityState.SUPPORTED)
    descriptors["storage.mutation"] =
      SdkCapabilityDescriptor(
        "storage.mutation",
        SdkCapabilityState.UNSUPPORTED,
        "No application-provided storage driver is registered",
      )
    descriptors["ui.observe"] =
      SdkCapabilityDescriptor(
        "ui.observe",
        SdkCapabilityState.UNSUPPORTED,
        "No UI observation hook is registered",
      )
    descriptors["ui.control"] =
      SdkCapabilityDescriptor(
        "ui.control",
        SdkCapabilityState.UNSUPPORTED,
        "No UI control hook is registered",
      )
    descriptors["network.control"] =
      SdkCapabilityDescriptor(
        "network.control",
        SdkCapabilityState.UNSUPPORTED,
        "No network control hook is registered",
      )
  }
}
