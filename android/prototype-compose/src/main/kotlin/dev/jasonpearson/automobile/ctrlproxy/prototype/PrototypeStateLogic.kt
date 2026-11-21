package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeAction
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeDecrementAction
import dev.jasonpearson.automobile.protocol.PrototypeIncrementAction
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeStyle
import dev.jasonpearson.automobile.protocol.PrototypeStyleWhen
import dev.jasonpearson.automobile.protocol.PrototypeToggleAction
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Pure evaluation of the spec's state vocabulary: conditions for `visibleWhen` and the next value
 * for state-changing actions. The validator guarantees exactly one form per condition; a state key
 * of the wrong type simply fails numeric comparisons instead of throwing.
 */
internal fun PrototypeCondition.holds(
  state: Map<String, PrototypeScalar>,
  validity: Map<String, Boolean> = emptyMap(),
  derivedValues: Map<String, JsonElement?> = emptyMap(),
): Boolean {
  val derivedName = derived
  val raw = derivedName?.let { derivedValues[it] }
  val stored = if (derivedName == null) key?.let { state[it] } else derivedScalar(raw)
  val number = (stored as? PrototypeScalar.Numeric)?.value
  val text = (stored as? PrototypeScalar.Text)?.value
  val all = all
  val any = any
  val not = not
  val gt = gt
  val lt = lt
  val contains = (contains as? PrototypeScalar.Text)?.value
  val startsWith = (startsWith as? PrototypeScalar.Text)?.value
  val lengthGt = lengthGt
  val lengthLt = lengthLt
  val valid = valid
  return when {
    valid != null -> valid.keys().all { validity[it] == true }
    (key != null || derivedName != null) && equals != null -> stored.sameValue(equals)
    (key != null || derivedName != null) && notEquals != null -> !stored.sameValue(notEquals)
    contains != null -> text != null && text.contains(contains)
    startsWith != null -> text != null && text.startsWith(startsWith)
    lengthGt != null -> text != null && text.length > lengthGt
    lengthLt != null -> text != null && text.length < lengthLt
    gt != null -> number != null && number > gt
    lt != null -> number != null && number < lt
    derivedName != null && empty != null -> derivedEmpty(raw) == empty
    all != null -> all.all { it.holds(state, validity, derivedValues) }
    any != null -> any.any { it.holds(state, validity, derivedValues) }
    not != null -> !not.holds(state, validity, derivedValues)
    else -> false
  }
}

private fun derivedScalar(raw: JsonElement?): PrototypeScalar? {
  val scalar = raw as? JsonPrimitive ?: return null
  if (scalar.isString) return PrototypeScalar.Text(scalar.content)
  scalar.booleanOrNull?.let {
    return PrototypeScalar.BooleanValue(it)
  }
  return scalar.doubleOrNull?.takeIf { it.isFinite() }?.let { PrototypeScalar.Numeric(it) }
}

private fun derivedEmpty(raw: JsonElement?): Boolean =
  when (raw) {
    null,
    JsonNull -> true
    is JsonArray -> raw.isEmpty()
    is JsonObject -> raw.isEmpty()
    is JsonPrimitive ->
      if (raw.isString) raw.content.isEmpty() else raw.doubleOrNull?.isFinite() == false
  }

/**
 * Strict equality as the host's `===` and Swift's `==` see it: same type and same value, where
 * numbers compare numerically, so `-0` equals `0` (data-class equality tells them apart).
 */
private fun PrototypeScalar?.sameValue(other: PrototypeScalar?): Boolean =
  if (this is PrototypeScalar.Numeric && other is PrototypeScalar.Numeric) value == other.value
  else this == other

/** The flipped value, or null when the key no longer holds a boolean (the action is a no-op). */
internal fun PrototypeToggleAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? =
  (state[key] as? PrototypeScalar.BooleanValue)?.let { PrototypeScalar.BooleanValue(!it.value) }

/** The stepped value, or null when the key is not numeric or the result would not be finite. */
internal fun PrototypeIncrementAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? {
  val current = (state[key] as? PrototypeScalar.Numeric)?.value ?: return null
  val next = current + (by ?: 1.0)
  return if (next.isFinite()) PrototypeScalar.Numeric(next) else null
}

/** The stepped-down value: [PrototypeIncrementAction] with the sign of `by` flipped (default 1). */
internal fun PrototypeDecrementAction.nextValue(
  state: Map<String, PrototypeScalar>,
): PrototypeScalar? {
  val current = (state[key] as? PrototypeScalar.Numeric)?.value ?: return null
  val next = current - (by ?: 1.0)
  return if (next.isFinite()) PrototypeScalar.Numeric(next) else null
}

/**
 * The key and value a state-changing action writes given [state], or null when the action writes
 * nothing: it is not a state action, or it is a toggle or step that is a no-op for the stored type.
 */
internal fun PrototypeAction.stateWrite(
  state: Map<String, PrototypeScalar>,
): Pair<String, PrototypeScalar>? =
  when (this) {
    is PrototypeSetStateAction -> key to value
    is PrototypeToggleAction -> nextValue(state)?.let { key to it }
    is PrototypeIncrementAction -> nextValue(state)?.let { key to it }
    is PrototypeDecrementAction -> nextValue(state)?.let { key to it }
    else -> null
  }

/**
 * The base style with every `styleWhen` entry whose condition holds merged over it, in authored
 * order, so a later matching entry wins per property. A present property replaces the base value as
 * a whole (`padding`, `border`, `offset` and per-corner `cornerRadius` are replaced, not merged
 * field by field).
 */
internal fun resolvePrototypeStyle(
  base: PrototypeStyle?,
  styleWhen: List<PrototypeStyleWhen>?,
  state: Map<String, PrototypeScalar>,
  validity: Map<String, Boolean> = emptyMap(),
  derivedValues: Map<String, JsonElement?> = emptyMap(),
): PrototypeStyle {
  var resolved = base ?: PrototypeStyle()
  for (entry in styleWhen.orEmpty()) {
    if (entry.`when`.holds(state, validity, derivedValues))
      resolved = resolved.mergedOver(entry.style)
  }
  return resolved
}

/** Properties set on [prototype] win; unset ones keep this style's value. */
private fun PrototypeStyle.mergedOver(prototype: PrototypeStyle): PrototypeStyle =
  PrototypeStyle(
    width = prototype.width ?: width,
    height = prototype.height ?: height,
    weight = prototype.weight ?: weight,
    minWidth = prototype.minWidth ?: minWidth,
    maxWidth = prototype.maxWidth ?: maxWidth,
    minHeight = prototype.minHeight ?: minHeight,
    maxHeight = prototype.maxHeight ?: maxHeight,
    padding = prototype.padding ?: padding,
    background = prototype.background ?: background,
    cornerRadius = prototype.cornerRadius ?: cornerRadius,
    border = prototype.border ?: border,
    elevation = prototype.elevation ?: elevation,
    shadowColor = prototype.shadowColor ?: shadowColor,
    shadows = prototype.shadows ?: shadows,
    cornerStyle = prototype.cornerStyle ?: cornerStyle,
    gradient = prototype.gradient ?: gradient,
    aspectRatio = prototype.aspectRatio ?: aspectRatio,
    offset = prototype.offset ?: offset,
    alpha = prototype.alpha ?: alpha,
    pressScale = prototype.pressScale ?: pressScale,
    shimmer = prototype.shimmer ?: shimmer,
    scale = prototype.scale ?: scale,
    rotation = prototype.rotation ?: rotation,
    effects = prototype.effects ?: effects,
    alignment = prototype.alignment ?: alignment,
    arrangement = prototype.arrangement ?: arrangement,
    spacing = prototype.spacing ?: spacing,
    runSpacing = prototype.runSpacing ?: runSpacing,
    textSize = prototype.textSize ?: textSize,
    fontWeight = prototype.fontWeight ?: fontWeight,
    color = prototype.color ?: color,
    textAlign = prototype.textAlign ?: textAlign,
    maxLines = prototype.maxLines ?: maxLines,
    lineHeight = prototype.lineHeight ?: lineHeight,
    letterSpacing = prototype.letterSpacing ?: letterSpacing,
    textDecoration = prototype.textDecoration ?: textDecoration,
    fontStyle = prototype.fontStyle ?: fontStyle,
    overflow = prototype.overflow ?: overflow,
    fontFamily = prototype.fontFamily ?: fontFamily,
    shader = prototype.shader ?: shader,
    textStyle = prototype.textStyle ?: textStyle,
  )
