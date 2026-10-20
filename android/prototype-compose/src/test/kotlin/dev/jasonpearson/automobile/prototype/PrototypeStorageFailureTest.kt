package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import java.io.IOException
import kotlinx.serialization.SerializationException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

@RunWith(ParameterizedRobolectricTestRunner::class)
class PrototypeStorageFailureTest(private val failure: Exception) {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic
    @Parameters(name = "{0}")
    fun failures(): List<Array<Any>> =
      listOf(
        arrayOf(IOException("Disk unavailable")),
        arrayOf(IllegalStateException("App storage failed")),
        arrayOf(SerializationException("Invalid stored document")),
      )

    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `storage failure draws only typed load error`() {
    val errors = mutableListOf<PrototypeLoadError>()
    val storage = FakePrototypeStorage(failure)
    val input = embeddedSpec("""{"type":"text","testTag":"content","text":"Loaded"}""")
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          storage = storage,
          onError = {
            errors += it
            DefaultPrototypeError(it)
          },
        )
      }
    }
    compose.onNodeWithText("Cannot load prototype storage: ${failure.message}").assertIsDisplayed()
    compose.onNodeWithTag("content").assertDoesNotExist()
    compose.runOnIdle {
      assertEquals(failure.message, (errors.last() as PrototypeLoadError.Storage).message)
    }
  }
}
