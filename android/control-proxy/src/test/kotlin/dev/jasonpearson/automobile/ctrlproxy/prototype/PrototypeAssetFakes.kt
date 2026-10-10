package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.io.IOException
import java.util.concurrent.Executor

/** In-memory [PrototypeAssetFiles] with failure injection; nothing touches the file system. */
internal class FakePrototypeAssetFiles : PrototypeAssetFiles {
  val stored = LinkedHashMap<String, ByteArray>()
  var failWrites = false
  var failReads = false
  var deleteAllCalls = 0

  /** Runs inside every write, after the failure check and before the bytes land. */
  var onWrite: (() -> Unit)? = null

  override fun write(name: String, bytes: ByteArray) {
    if (failWrites) throw IOException("fake write failure")
    onWrite?.invoke()
    stored[name] = bytes
  }

  override fun read(name: String): ByteArray? {
    if (failReads) throw IOException("fake read failure")
    return stored[name]
  }

  override fun delete(name: String) {
    stored.remove(name)
  }

  override fun deleteAll() {
    deleteAllCalls++
    stored.clear()
  }
}

/** Holds work until [runAll], standing in for the IO executor the store defers file deletes to. */
internal class QueuedExecutor : Executor {
  private val tasks = ArrayDeque<Runnable>()
  val pending: Int
    get() = tasks.size

  override fun execute(command: Runnable) {
    tasks.addLast(command)
  }

  fun runAll() {
    while (tasks.isNotEmpty()) tasks.removeFirst().run()
  }
}

/** Smallest byte strings whose magic numbers satisfy the store's signature check. */
internal object PrototypeAssetBytes {
  fun png(size: Int = 16): ByteArray = padded(size, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

  fun jpeg(size: Int = 16): ByteArray = padded(size, 0xFF, 0xD8, 0xFF, 0xE0)

  fun webp(size: Int = 16): ByteArray =
    padded(size, 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)

  private fun padded(size: Int, vararg header: Int): ByteArray {
    require(size >= header.size)
    return ByteArray(size).also { bytes -> header.forEachIndexed { i, b -> bytes[i] = b.toByte() } }
  }
}
