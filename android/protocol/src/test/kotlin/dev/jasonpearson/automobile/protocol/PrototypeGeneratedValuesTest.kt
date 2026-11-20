package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

private class SeededPrototypeIds(private val ids: List<String>) : PrototypeIdGenerator {
  var count = 0

  override fun next(): String = ids[count++]
}

private class FixedPrototypeClock(private val ms: Long) : PrototypeClock {
  override fun nowEpochMs(): Long = ms
}

class PrototypeGeneratedValuesTest {
  private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

  private fun envelope(actions: JsonArray, extra: JsonObject = obj("{}")): JsonObject =
    obj(
        """{"id":"generated","window":{"placement":{"type":"fullscreen"}},"data":{"rows":[]},"root":{"type":"button","label":"Go"}}""",
      )
      .let {
        JsonObject(
          it +
            extra +
            ("root" to JsonObject(it.getValue("root").jsonObject + ("onTap" to actions))),
        )
      }

  private fun validate(actions: String, extra: JsonObject = obj("{}")) =
    PrototypeSpecValidator.validate(
      envelope(Json.parseToJsonElement(actions).jsonArray, extra).toString(),
    )

  @TestFactory
  fun sharedGeneratedFixtures(): List<DynamicTest> =
    Json.parseToJsonElement(File(fixtureDirectory(), "data/generated-values.json").readText())
      .jsonArray
      .map { raw ->
        val fixture = raw.jsonObject
        DynamicTest.dynamicTest(fixture.getValue("name").jsonPrimitive.content) {
          GeneratedFixtureRun(fixture).verify()
        }
      }

  @Test
  fun exactMarkersSortedMembersAndClockPreserveLastId() {
    val ids = SeededPrototypeIds(listOf("id-1", "id-2"))
    val context = PrototypeActionContext(ids, FixedPrototypeClock(1700000000000))
    val literal =
      obj(
        """{"value":{"z":{"lastGenerated":true},"b":{"generate":"id"},"a":{"generate":"id"},"time":{"now":"iso"},"opaque":{"generate":"id","extra":true}}}""",
      )
    val resolved =
      PrototypeGeneratedValues.resolveBinding(literal, context) as PrototypeDataValue.Resolved
    assertEquals(
      obj(
        """{"a":"id-1","b":"id-2","z":"id-2","time":"2023-11-14T22:13:20.000Z","opaque":{"generate":"id","extra":true}}""",
      ),
      resolved.value,
    )
    assertEquals(2, ids.count)
    assertEquals("id-2", context.lastGenerated)
    val failure =
      PrototypeGeneratedValues.resolveBinding(
        obj("""{"value":[{"lastGenerated":true},{"generate":"id"}]}"""),
        PrototypeActionContext(ids),
      ) as PrototypeDataValue.Failure
    assertEquals(PrototypeDataWriteErrorCode.LAST_GENERATED_UNSET, failure.error.code)
    assertEquals(2, ids.count)
  }

  @Test
  fun generatedBindingsAndKeyedRequestsRequireV2() {
    for (action in
      listOf(
        """{"type":"appendData","path":"/data/rows","value":{"generate":"id"}}""",
        """{"type":"setState","key":"at","value":{"now":"epochMs"}}""",
        """{"type":"request","url":"https://x.test","into":"/data/rows","where":{"field":"id","equals":{"value":"x"}},"member":"result"}""",
        """{"type":"request","url":"https://x.test","query":{"at":{"now":"iso"}}}""",
      )) {
      val spec = envelope(Json.parseToJsonElement("[$action]").jsonArray)
      val caps = PrototypeStrictPolicy.required(spec)
      assertTrue("prototype_data_actions_v2" in caps, action)
      assertEquals(
        caps,
        PrototypeBundleCapabilities.required(
            PrototypeBundleSpec.references(spec.toString().toByteArray()),
          )
          .toSet(),
        action,
      )
      assertTrue(
        PrototypeSpecValidator.validate(spec.toString(), caps) is PrototypeSpecValidation.Success,
        action,
      )
      val failure =
        PrototypeSpecValidator.validate(spec.toString(), caps - "prototype_data_actions_v2")
          as PrototypeSpecValidation.Failure
      assertTrue(failure.error.message.contains("prototype_data_actions_v2"), action)
    }
  }

  @Test
  fun strictShapesAndUnsetAnalysisRespectRequestSnapshots() {
    val generate = """{"type":"setState","key":"id","value":{"generate":"id"}}"""
    val read = """{"type":"setState","key":"id","value":{"lastGenerated":true}}"""
    val request = """{"type":"request","url":"https://x.test","onSuccess":[$read]}"""
    assertTrue(validate("[$generate,$request]") is PrototypeSpecValidation.Success)
    for (actions in
      listOf(
        "[$read]",
        "[$request,$generate]",
        "[{\"type\":\"startTimer\",\"id\":\"t\",\"afterMs\":100,\"actions\":[$read]}]",
      )) {
      val failure = validate(actions) as PrototypeSpecValidation.Failure
      assertTrue(failure.error.message.contains("lastGenerated_unset"), actions)
    }
    for (binding in
      listOf(
        """{"generate":"uuid"}""",
        """{"now":"local"}""",
        """{"lastGenerated":false}""",
        """{"generate":"id","extra":true}""",
      )) {
      assertTrue(
        validate("""[{"type":"appendData","path":"/data/rows","value":$binding}]""")
          is PrototypeSpecValidation.Failure,
        binding,
      )
    }
    for (action in
      listOf(
        """{"type":"request","url":"https://x.test","member":"x"}""",
        """{"type":"request","url":"https://x.test","where":{"field":"id","equals":{"value":"x"}}}""",
      )) assertTrue(validate("[$action]") is PrototypeSpecValidation.Failure)
  }

  @Test
  fun keyedSecureSelectorsUseExistingRequestOptInAndGeneratedValuesArePublic() {
    val extra =
      obj(
        """{"state":{"token":"","public":""},"requires":{"platform":["secureStorage"]},"storage":{"version":1,"keys":["state:public"],"secure":["state:token"]}}""",
      )
    val request =
      """{"type":"request","url":"https://x.test","into":"/data/rows","where":{"field":"id","equals":{"state":"token"}}}"""
    val dataRead = """[{"type":"setData","path":"/data/rows","value":{"state":"token"}}]"""
    assertTrue(validate(dataRead, extra) is PrototypeSpecValidation.Failure)
    val denied = validate("[$request]", extra) as PrototypeSpecValidation.Failure
    assertTrue(denied.error.path.endsWith(".where.equals"), denied.toString())
    assertTrue(
      validate("[${request.dropLast(1)},\"allowSecureInRequest\":true}]", extra)
        is PrototypeSpecValidation.Success,
    )
    assertTrue(
      validate("[${request.replace("\"state\":\"token\"", "\"generate\":\"id\"")}]", extra)
        is PrototypeSpecValidation.Success,
    )
  }

  companion object {
    @BeforeAll
    @JvmStatic
    fun warmModels() {
      PrototypeSpecFixtures.loadFixtures()
    }
  }
}

/**
 * Fixture orchestration is intentionally asynchronous: dispatch all siblings before completions.
 */
private class GeneratedFixtureRun(private val fixture: JsonObject) {
  private var data = fixture.getValue("initialData").jsonObject
  private var errorCode: String? = null
  private var responseIndex = 0
  private val completions = mutableListOf<() -> Unit>()
  private val context =
    PrototypeActionContext(
      SeededPrototypeIds(fixture.getValue("ids").jsonArray.map { it.jsonPrimitive.content }),
      FixedPrototypeClock(fixture.getValue("clockMs").jsonPrimitive.long),
    )

  fun verify() {
    run(fixture.getValue("actions").jsonArray, context)
    completions.forEach { it() }
    val expected = fixture.getValue("expected").jsonObject
    assertEquals(expected["errorCode"]?.jsonPrimitive?.content, errorCode)
    if ("data" in expected) assertEquals(expected["data"], data)
  }

  private fun inputs(scope: PrototypeActionContext) =
    object : EmitContextInputs {
      override val actionContext = scope

      override fun state(key: String): JsonElement? = null

      override fun page(id: String): Int? = null

      override fun data(pointer: String): JsonElement? = PrototypeDataPointer.resolve(data, pointer)
    }

  private fun resolve(binding: JsonObject, scope: PrototypeActionContext): JsonElement? =
    when (val result = PrototypeDataWriter.resolveValue(binding, inputs(scope))) {
      is PrototypeDataValue.Resolved -> result.value
      is PrototypeDataValue.Failure -> {
        errorCode = result.error.code.wireValue
        null
      }
    }

  private fun run(actions: JsonArray, scope: PrototypeActionContext) {
    for (raw in actions) {
      val action = raw.jsonObject
      val accepted =
        if (action.getValue("type") == JsonPrimitive("request")) startRequest(action, scope)
        else writeData(action, scope)
      if (!accepted) return
    }
  }

  private fun writeData(action: JsonObject, scope: PrototypeActionContext): Boolean {
    val value = action["value"]?.jsonObject?.let { resolve(it, scope) ?: return false }
    val where =
      (action["where"] as? JsonObject)?.let {
        PrototypeDataMatch(
          it.getValue("field").jsonPrimitive.content,
          resolve(it.getValue("equals").jsonObject, scope) ?: return false,
        )
      }
    val path = action.getValue("path").jsonPrimitive.content
    val write =
      when (action.getValue("type").jsonPrimitive.content) {
        "appendData" -> PrototypeDataWrite.Append(path, checkNotNull(value))
        "removeData" -> PrototypeDataWrite.Remove(path, where)
        else ->
          PrototypeDataWrite.Set(
            path,
            checkNotNull(value),
            where,
            action["member"]?.jsonPrimitive?.content,
          )
      }
    return when (val result = PrototypeDataWriter.apply(data, write)) {
      is PrototypeDataWriteResult.Success -> {
        data = result.data
        true
      }
      is PrototypeDataWriteResult.Failure -> {
        errorCode = result.error.code.wireValue
        false
      }
    }
  }

  private fun startRequest(action: JsonObject, scope: PrototypeActionContext): Boolean {
    val decoded =
      Json.decodeFromJsonElement(PrototypeAction.serializer(), action) as PrototypeRequestAction
    val resolved =
      when (val result = PrototypeRequestResolver.resolve(decoded, decoded.url, inputs(scope))) {
        is PrototypeResolvedRequestResult.Success -> result.request
        is PrototypeResolvedRequestResult.Failure -> {
          errorCode = result.error.code.wireValue
          return false
        }
      }
    val response = fixture.getValue("mockResponses").jsonArray[responseIndex++].jsonObject
    completions += { finishRequest(action, resolved, response) }
    return true
  }

  private fun finishRequest(
    action: JsonObject,
    request: PrototypeResolvedRequest,
    response: JsonObject,
  ) {
    val outcome =
      PrototypeRequestOutcome.apply(
        data,
        action["into"]?.jsonPrimitive?.content,
        PrototypeRequestResponse.Received(
          response.getValue("status").jsonPrimitive.int,
          emptyMap(),
          response["body"],
          0,
        ),
        options = PrototypeRequestWriteOptions(where = request.where, member = request.member),
      )
    data = checkNotNull(outcome.data)
    errorCode = outcome.result.meta.error?.code?.wireValue
    val branch = action[if (outcome.result.succeeded) "onSuccess" else "onError"] as? JsonArray
    if (branch != null) {
      errorCode = null
      run(branch, checkNotNull(request.context))
    }
  }
}
