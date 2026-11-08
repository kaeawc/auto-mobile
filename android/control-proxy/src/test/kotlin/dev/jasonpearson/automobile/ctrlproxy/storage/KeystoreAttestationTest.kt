package dev.jasonpearson.automobile.ctrlproxy.storage

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeystoreAttestationTest {
  private class FakeKeyStore : AttestationKeyStore {
    val calls = mutableListOf<String>()
    var failGenerate = false
    var failRead = false
    var chain = listOf(byteArrayOf(1, 2), byteArrayOf(3, 4))

    override fun generate(alias: String, challenge: ByteArray) {
      calls += "generate:$alias:${challenge.size}"
      if (failGenerate) error("generation failed")
    }

    override fun certificateChain(alias: String): List<ByteArray> {
      calls += "read:$alias"
      if (failRead) error("read failed")
      return chain
    }

    override fun delete(alias: String) {
      calls += "delete:$alias"
    }
  }

  private fun handler(store: FakeKeyStore) =
    KeystoreAttestation(
      store,
      alias = { "throwaway" },
      challenge = { ByteArray(32) },
      encode = { Base64.getEncoder().encodeToString(it) },
    )

  @Test
  fun `exports public DER certificates leaf first and removes the key`() {
    val store = FakeKeyStore()
    assertEquals(listOf("AQI=", "AwQ="), handler(store).export())
    assertEquals(listOf("generate:throwaway:32", "read:throwaway", "delete:throwaway"), store.calls)
  }

  @Test
  fun `deletes alias even when generation or certificate retrieval fails`() {
    for (failGenerate in listOf(true, false)) {
      val store =
        FakeKeyStore().apply {
          this.failGenerate = failGenerate
          failRead = !failGenerate
        }
      assertTrue(runCatching { handler(store).export() }.isFailure)
      assertEquals("delete:throwaway", store.calls.last())
    }
  }

  @Test
  fun `rejects an incomplete chain and still deletes the alias`() {
    val store = FakeKeyStore().apply { chain = listOf(byteArrayOf(1)) }
    assertTrue(runCatching { handler(store).export() }.isFailure)
    assertEquals("delete:throwaway", store.calls.last())
  }
}
