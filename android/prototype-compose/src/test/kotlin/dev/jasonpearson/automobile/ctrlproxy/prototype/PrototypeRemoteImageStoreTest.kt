package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PrototypeRemoteImageStoreTest {
  @get:Rule val temporary = TemporaryFolder()

  @Test
  fun `disk cache keys URLs across loader lifetimes and evicts least recently read bytes`() {
    val directory = temporary.newFolder()
    var now = 1000L
    val bytes = prototypeRemoteImageTestPng()
    val capacity = bytes.size.toLong() * 2
    val store = FilePrototypeRemoteImageStore(directory, maxBytes = capacity, clock = { now++ })
    val first = "https://images.example/a?token=private"
    val second = "https://images.example/b"
    val third = "https://images.example/c"
    store.put(first, bytes)
    store.put(second, bytes)
    assertArrayEquals(bytes, store.read(first))
    store.put(third, bytes)
    val reopened = FilePrototypeRemoteImageStore(directory, maxBytes = capacity, clock = { now++ })
    assertArrayEquals(bytes, reopened.read(first))
    assertNull(reopened.lookup(second))
    assertArrayEquals(bytes, reopened.read(third))
    assertEquals(capacity, directory.listFiles()!!.sumOf { it.length() })
    assertTrue(directory.listFiles()!!.all { it.name.length == 70 && !it.name.contains("private") })
  }
}
