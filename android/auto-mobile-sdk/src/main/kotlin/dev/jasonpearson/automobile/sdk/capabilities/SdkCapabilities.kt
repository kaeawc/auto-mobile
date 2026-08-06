package dev.jasonpearson.automobile.sdk.capabilities

import kotlinx.serialization.Serializable
import kotlinx.serialization.EncodeDefault
import java.util.LinkedHashMap

/** The lifecycle or availability state of an SDK capability. */
@Serializable
enum class SdkCapabilityState {
  SUPPORTED,
  DISABLED,
  UNSUPPORTED,
  PERMISSION_DENIED,
  NOT_INITIALIZED,
  UNKNOWN,
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
  @EncodeDefault(EncodeDefault.Mode.ALWAYS)
  val captureHeaders: Boolean = false,
  @EncodeDefault(EncodeDefault.Mode.ALWAYS)
  val captureBodies: Boolean = false,
  @EncodeDefault(EncodeDefault.Mode.ALWAYS)
  val allowMutations: Boolean = false,
)

/** Versioned machine-readable description of the SDK integration. */
@Serializable
data class SdkCapabilityDocument(
  @EncodeDefault(EncodeDefault.Mode.ALWAYS)
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

  fun markLifecycleReady() {
    synchronized(lock) {
      descriptors["events.lifecycle"] =
        SdkCapabilityDescriptor("events.lifecycle", SdkCapabilityState.SUPPORTED)
    }
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
    synchronized(lock) {
      require(descriptor.id !in reservedCapabilities || descriptor.id in hostManagedCapabilities) {
        "Capability ${descriptor.id} is managed by the SDK"
      }
      descriptors[descriptor.id] = descriptor
    }
  }

  fun unregister(id: String) {
    synchronized(lock) {
      if (id in defaultDescriptors) {
        descriptors[id] = defaultDescriptors.getValue(id)
        revokePolicyFor(id)
      } else {
        descriptors.remove(id)
      }
    }
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

  fun currentPolicy(): SdkCapturePolicy = synchronized(lock) { policy }

  private fun isSupported(id: String): Boolean {
    val descriptor = descriptors[id]
    return initialized && enabled && descriptor?.state == SdkCapabilityState.SUPPORTED
  }

  private fun registerDefaults() {
    defaultDescriptors.forEach { (id, descriptor) -> descriptors[id] = descriptor }
  }

  private fun revokePolicyFor(id: String) {
    policy =
      when (id) {
        "network.capture" ->
          policy.copy(captureHeaders = false, captureBodies = false)
        "storage.mutation", "network.control" ->
          policy.copy(allowMutations = false)
        else -> policy
      }
  }

  private companion object {
    val hostManagedCapabilities =
      setOf("storage.mutation", "ui.observe", "ui.control", "network.control")
    val defaultDescriptors =
      linkedMapOf(
        "events.navigation" to
          SdkCapabilityDescriptor("events.navigation", SdkCapabilityState.SUPPORTED),
        "events.lifecycle" to
          SdkCapabilityDescriptor(
            "events.lifecycle",
            SdkCapabilityState.UNSUPPORTED,
            "Lifecycle hook has not been installed",
          ),
        "network.capture" to
          SdkCapabilityDescriptor("network.capture", SdkCapabilityState.SUPPORTED),
        "storage.read" to
          SdkCapabilityDescriptor(
            "storage.read",
            SdkCapabilityState.UNSUPPORTED,
            "No application-provided storage driver is registered",
          ),
        "storage.mutation" to
          SdkCapabilityDescriptor(
            "storage.mutation",
            SdkCapabilityState.UNSUPPORTED,
            "No application-provided storage driver is registered",
          ),
        "ui.observe" to
          SdkCapabilityDescriptor(
            "ui.observe",
            SdkCapabilityState.UNSUPPORTED,
            "No UI observation hook is registered",
          ),
        "ui.control" to
          SdkCapabilityDescriptor(
            "ui.control",
            SdkCapabilityState.UNSUPPORTED,
            "No UI control hook is registered",
          ),
        "network.control" to
          SdkCapabilityDescriptor(
            "network.control",
            SdkCapabilityState.UNSUPPORTED,
            "No network control hook is registered",
          ),
      )
    val reservedCapabilities = defaultDescriptors.keys
  }
}
