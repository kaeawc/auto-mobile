package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.*

/** The state keys of secure text fields, for the library import policy (#18665). */
internal object PrototypeSecureStateKeys {
  private const val DERIVED_KEY_MESSAGE =
    "Secure state key cannot use a derived repeat field; key it by an item field or {index}"

  /** Each secure text field, reduced to its state key. */
  private fun secureFields(
    context: PrototypeStateChecks.Context,
  ): List<PrototypeStateChecks.Located> =
    context.nodes
      .filter {
        it.value.text("type") == "textField" &&
          (it.value["secure"] == JsonPrimitive(true) || it.value.text("keyboardType") == "password")
      }
      .map { it.copy(value = JsonObject(mapOf("stateKey" to it.value.getValue("stateKey")))) }

  /** The device formats a derived field, so the host cannot name the secure key it expands to. */
  fun derivedKeyError(
    scopes: List<PrototypeRepeatValidator.Scope>,
    context: PrototypeStateChecks.Context,
  ): PrototypeSpecError? =
    secureFields(context)
      .firstOrNull { PrototypeRepeatValidator.readsDerivedKey(scopes, it.value, it.path) }
      ?.let { PrototypeSpecError("${it.path}.stateKey", DERIVED_KEY_MESSAGE) }

  fun keys(
    scopes: List<PrototypeRepeatValidator.Scope>,
    context: PrototypeStateChecks.Context,
  ): Set<String> =
    secureFields(context)
      .flatMap { PrototypeRepeatValidator.keyInstances(scopes, it.value, it.path) }
      .mapNotNull { (value, _) -> value.text("stateKey") }
      .toSet()
}
