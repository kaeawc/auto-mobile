package dev.jasonpearson.automobile.playground

import java.security.ProviderException
import org.junit.Assert.assertEquals
import org.junit.Test

class KeystoreStrongBoxProbeTest {
  private class FakeStrongBoxUnavailable : RuntimeException()

  private class FakeGenerator(
    private val gateFailsStrongBox: Boolean = false,
    private val hardwareFailsStrongBox: Boolean = false,
    private val fallbackError: Throwable? = null,
  ) : StrongBoxKeyGenerator {
    val calls = mutableListOf<String>()

    override fun checkGeneration(alias: String, strongBox: Boolean) {
      calls += "check:$alias:$strongBox"
      if (strongBox && gateFailsStrongBox) throw FakeStrongBoxUnavailable()
    }

    override fun generate(alias: String, strongBox: Boolean) {
      calls += "generate:$alias:$strongBox"
      if (strongBox && hardwareFailsStrongBox) throw FakeStrongBoxUnavailable()
      if (!strongBox && fallbackError != null) throw fallbackError
    }
  }

  private fun probe(generator: FakeGenerator) =
    KeystoreStrongBoxProbe(generator) { it is FakeStrongBoxUnavailable }

  private val alias = KeystoreStrongBoxProbe.ALIAS

  @Test
  fun reportsStrongBoxWhenGateAndHardwareBothAllowIt() {
    val generator = FakeGenerator()
    assertEquals("strongbox", probe(generator).run())
    assertEquals(listOf("check:$alias:true", "generate:$alias:true"), generator.calls)
  }

  @Test
  fun injectedFaultSkipsStrongBoxGenerationAndFallsBack() {
    val generator = FakeGenerator(gateFailsStrongBox = true)
    assertEquals("fallback:injected", probe(generator).run())
    assertEquals(
      listOf("check:$alias:true", "check:$alias:false", "generate:$alias:false"),
      generator.calls,
    )
  }

  @Test
  fun hardwareWithoutStrongBoxFallsBackAndIsReportedSeparately() {
    val generator = FakeGenerator(hardwareFailsStrongBox = true)
    assertEquals("fallback:hardware", probe(generator).run())
    assertEquals(
      listOf(
        "check:$alias:true",
        "generate:$alias:true",
        "check:$alias:false",
        "generate:$alias:false",
      ),
      generator.calls,
    )
  }

  @Test
  fun injectedFaultWinsWhenHardwareAlsoLacksStrongBox() {
    val generator = FakeGenerator(gateFailsStrongBox = true, hardwareFailsStrongBox = true)
    assertEquals("fallback:injected", probe(generator).run())
  }

  @Test
  fun otherStrongBoxFailuresAreReportedWithoutFallingBack() {
    val generator =
      object : StrongBoxKeyGenerator {
        val calls = mutableListOf<Boolean>()

        override fun checkGeneration(alias: String, strongBox: Boolean) = Unit

        override fun generate(alias: String, strongBox: Boolean) {
          calls += strongBox
          throw ProviderException("secret details")
        }
      }
    val outcome = KeystoreStrongBoxProbe(generator) { it is FakeStrongBoxUnavailable }.run()
    assertEquals("error:ProviderException", outcome)
    assertEquals(listOf(true), generator.calls)
  }

  @Test
  fun fallbackFailureIsReportedWithoutExceptionDetails() {
    val generator =
      FakeGenerator(gateFailsStrongBox = true, fallbackError = ProviderException("secret details"))
    assertEquals("error:fallback:ProviderException", probe(generator).run())
  }
}
