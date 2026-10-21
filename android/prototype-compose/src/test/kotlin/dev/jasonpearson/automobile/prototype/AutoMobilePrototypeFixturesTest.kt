package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

@RunWith(ParameterizedRobolectricTestRunner::class)
class AutoMobilePrototypeFixturesTest(private val name: String, private val input: String) {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    // One fixture per test keeps each render isolated; every valid fixture is covered (#13725).
    @JvmStatic
    @Parameters(name = "{0}")
    fun fixtures(): List<Array<Any>> =
      fixtureFile("prototype-spec/valid")
        .listFiles()
        .orEmpty()
        .filter { it.extension == "json" }
        .sortedBy { it.name }
        .map { arrayOf<Any>(it.name, it.readText()) }

    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `valid fixture renders without load errors`() {
    val errors = mutableListOf<PrototypeLoadError>()
    val storage = FakePrototypeStorage()
    val network = PrototypeNetwork(FakePrototypeHttp())
    compose.setContent {
      host.Content {
        AutoMobilePrototype(input, storage = storage, network = network, onError = { errors += it })
      }
    }
    compose.onRoot().assertExists()
    compose.runOnIdle { assertTrue("$name: $errors", errors.isEmpty()) }
  }
}
