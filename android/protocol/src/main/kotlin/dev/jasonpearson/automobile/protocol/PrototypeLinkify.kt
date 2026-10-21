package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * `linkify` detection and `{match}` binding (#14233), the twin of TypeScript's
 * `prototypeLinkify.ts`, pinned by `test/fixtures/prototype-spec/linkify/cases.json`. A match
 * starts at the start of the text or after whitespace: a mention is `@` and 1 to 30 of
 * `[A-Za-z0-9_]`, a hashtag `#` and 1 to 100 code units of letters, marks, `[0-9]` or `_` (not all
 * digits), and a URL `http://` or `https://` up to whitespace, trailing `.,;:!?'")]}` removed, in
 * the `checks` url format. Offsets are UTF-16 code units.
 */
object PrototypeLinkify {
  data class Match(val kind: String, val text: String, val start: Int, val end: Int)

  private const val MAX_MENTION = 30
  private const val MAX_HASHTAG = 100
  private val urlFormat = Regex("^https?://[^\\s/?#]+([/?#]\\S*)?$")
  private const val TRAILING = ".,;:!?'\")]}"
  private val spaces =
    setOf(
      0x09,
      0x0a,
      0x0b,
      0x0c,
      0x0d,
      0x20,
      0xa0,
      0x1680,
      0x2000,
      0x2001,
      0x2002,
      0x2003,
      0x2004,
      0x2005,
      0x2006,
      0x2007,
      0x2008,
      0x2009,
      0x200a,
      0x2028,
      0x2029,
      0x202f,
      0x205f,
      0x3000,
      0xfeff,
    )
  private val hashtagTypes =
    setOf(
      Character.UPPERCASE_LETTER,
      Character.LOWERCASE_LETTER,
      Character.TITLECASE_LETTER,
      Character.MODIFIER_LETTER,
      Character.OTHER_LETTER,
      Character.NON_SPACING_MARK,
      Character.ENCLOSING_MARK,
      Character.COMBINING_SPACING_MARK,
    )

  private fun isSpace(text: String, at: Int) = text[at].code in spaces

  private fun isWord(char: Char) =
    char in '0'..'9' || char in 'A'..'Z' || char in 'a'..'z' || char == '_'

  private fun mentionEnd(text: String, at: Int): Int? {
    var end = at + 1
    while (end < text.length && isWord(text[end])) end++
    return if (end - at - 1 in 1..MAX_MENTION) end else null
  }

  private fun hashtagEnd(text: String, at: Int): Int? {
    var end = at + 1
    var digitsOnly = true
    while (end < text.length) {
      val point = text.codePointAt(end)
      val digit = point in '0'.code..'9'.code
      if (!digit && point != '_'.code && Character.getType(point).toByte() !in hashtagTypes) break
      digitsOnly = digitsOnly && digit
      end += Character.charCount(point)
    }
    return if (end - at - 1 in 1..MAX_HASHTAG && !digitsOnly) end else null
  }

  private fun urlEnd(text: String, at: Int): Int? {
    if (!text.startsWith("http://", at) && !text.startsWith("https://", at)) return null
    var end = at
    while (end < text.length && !isSpace(text, end)) end++
    while (end > at && text[end - 1] in TRAILING) end--
    return if (urlFormat.matches(text.substring(at, end))) end else null
  }

  private fun end(kind: String, text: String, at: Int): Int? =
    when (kind) {
      "mention" -> if (text[at] == '@') mentionEnd(text, at) else null
      "hashtag" -> if (text[at] == '#') hashtagEnd(text, at) else null
      "url" -> urlEnd(text, at)
      else -> null
    }

  /** The matches of [kinds] in [text], in order and never overlapping. */
  fun matches(text: String, kinds: List<String>): List<Match> {
    val found = mutableListOf<Match>()
    var at = 0
    while (at < text.length) {
      val match =
        if (at == 0 || isSpace(text, at - 1))
          kinds.firstNotNullOfOrNull { kind -> end(kind, text, at)?.let { kind to it } }
        else null
      if (match == null) {
        at++
      } else {
        found.add(Match(match.first, text.substring(at, match.second), at, match.second))
        at = match.second
      }
    }
    return found
  }

  /** True for a `{match: field}` binding object. */
  fun isMatchBinding(value: JsonElement?): Boolean =
    value is JsonObject &&
      value.size == 1 &&
      (value["match"] as? JsonPrimitive)?.takeIf { it.isString } != null

  private fun isLiteral(value: JsonObject) = value.size == 1 && value.containsKey("value")

  /** [actions] with each `{match: field}` replaced by [match]'s text or kind. */
  fun bind(actions: JsonElement, match: Match): JsonElement {
    fun bound(value: JsonElement, literal: Boolean): JsonElement =
      when {
        value is JsonArray -> JsonArray(value.map { bound(it, false) })
        value !is JsonObject || isLiteral(value) -> value
        isMatchBinding(value) -> {
          val field = (value["match"] as JsonPrimitive).content
          val text = JsonPrimitive(if (field == "kind") match.kind else match.text)
          if (literal) text else JsonObject(mapOf("value" to text))
        }
        else ->
          JsonObject(
            value.mapValues { (key, child) ->
              if (key == "payload") child
              else
                bound(
                  child,
                  key == "value" && (value["type"] as? JsonPrimitive)?.content == "setState",
                )
            },
          )
      }
    return bound(actions, false)
  }

  /** The decoded actions one tap on [match] runs. */
  fun actions(onTap: JsonArray, match: Match): List<PrototypeAction> =
    PrototypeSpecContract.json.decodeFromJsonElement(
      ListSerializer(PrototypeAction.serializer()),
      bind(onTap, match),
    )
}
