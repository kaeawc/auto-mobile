package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeStorageRestorer
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import kotlinx.serialization.json.JsonElement

/** Side-effect-free secure restore; reconciliation waits until the host accepts the show. */
internal class PrototypeSecureStoragePreparation(
  private val spec: PrototypeSpec,
  private val disk: PrototypeStoredValues?,
  unsaved: PrototypeStoredValues?,
) {
  val keys = spec.storage?.secure.orEmpty().filter { it !in spec.storage?.secureAuth.orEmpty() }
  private val stored =
    if (unsaved != null) {
      PrototypeStoredValues(
        unsaved.version,
        emptyMap(),
        secure = disk?.takeIf { it.version == unsaved.version }?.values.orEmpty() + unsaved.secure,
      )
    } else disk?.let { PrototypeStoredValues(it.version, emptyMap(), secure = it.values) }
  private val usable = stored?.copy(secure = stored.secure.filterKeys { it in keys })
  private var restore = PrototypeStorageRestorer.restore(spec, usable)
  val restored: PrototypeSpec
    get() = restore.spec

  val applied: Boolean
    get() = restore.applied.isNotEmpty()

  val kept: Map<String, JsonElement>
    get() = stored?.secure.orEmpty().filterKeys { it in restore.applied }

  val persisted: Map<String, JsonElement>
    get() = disk?.values.orEmpty().filterKeys { it in restore.applied }

  fun reject() {
    restore = restore.copy(spec = spec, applied = emptyList())
  }

  /** Dropped/versioned/biometric entries disappear without touching the accepted live state. */
  fun commit(store: PrototypeSecureValueStore?) {
    if (disk == null || store == null || disk.values.keys.none { it !in restore.applied }) return
    val retained = disk.values.filterKeys { it in restore.applied }
    if (retained.isEmpty()) store.delete(spec.id)
    else store.save(spec.id, PrototypeStoredValues(disk.version, retained))
  }
}
