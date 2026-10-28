package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatform
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class PrototypePlatformLifecycleTest {
  private class ClosingModule(override val name: String, private val fails: Boolean = false) :
    PrototypePlatformModule {
    var closes = 0
    override val capability = "prototype_platform_${name}_v1"
    override val events = emptyFlow<PlatformEvent>()
    override val state = MutableStateFlow(JsonObject(emptyMap()))

    override fun availability() = PlatformAvailability.Ready

    override suspend fun call(call: PlatformCall): PlatformCallResult =
      PlatformCallResult.Failure(PlatformError(PlatformErrorCode.UNSUPPORTED, "none"))

    override fun close() {
      closes++
      if (fails) throw IllegalStateException("boom")
    }
  }

  @Test
  fun `every module closes once even when one fails`() {
    val modules = listOf(ClosingModule("a"), ClosingModule("b", fails = true), ClosingModule("c"))
    val warnings = mutableListOf<String>()
    closePrototypeModules(PrototypePlatform(modules)) { message, _ -> warnings += message }
    assertEquals(listOf(1, 1, 1), modules.map { it.closes })
    assertEquals(listOf("Closing platform module b failed"), warnings)
  }
}
