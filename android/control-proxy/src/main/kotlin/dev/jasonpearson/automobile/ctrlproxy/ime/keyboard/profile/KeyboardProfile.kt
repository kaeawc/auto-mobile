package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

data class KeyboardProfile(
  val id: String,
  val displayName: String,
  val behavior: TypingBehavior,
  val style: KeyboardStyle,
  /** Increment when this profile's behavior contract changes. */
  val version: Int = 1,
  val evidenceStatus: String = "experimental",
  val evidenceNote: String = "Evidence has not been recorded.",
)

object KeyboardProfiles {
  /** Increment when the catalog response shape or its shared semantics change. */
  const val CATALOG_VERSION = 1
  val SUPPORTED_CATALOG_VERSIONS = listOf(CATALOG_VERSION)

  val DIRECT =
    KeyboardProfile(
      id = "direct",
      displayName = "Direct",
      style =
        KeyboardStyle(
          52f,
          40f,
          4f,
          6f,
          0xFF202124,
          0xFF414347,
          0xFF55575B,
          0xFF707278,
          0xFFFFFFFF,
          0xFF8AB4F8,
        ),
      behavior =
        TypingBehavior(
          composeWords = false,
          enterStrategy = EnterStrategy.KEY_EVENT,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = false,
          recomposeOnBackspaceIntoWord = false,
          batchEdits = false,
        ),
      evidenceStatus = "baseline",
      evidenceNote = "AutoMobile direct InputConnection policy.",
    )

  /**
   * Behavior verified on-device (2026-09-23): per-character `setComposingText` word composing with
   * `finishComposingText` on separators, batched edits, and direct `commitText` for symbols. In a
   * rich markdown composer the fenced-code autoformat fires, and the InputConnection call sequence
   * is byte-identical to the stock Gboard (captured via the IC trace recorder). Prediction and
   * autocorrect nuances are out of scope by design.
   */
  val GBOARD =
    KeyboardProfile(
      id = "gboard",
      displayName = "Gboard",
      style =
        KeyboardStyle(
          52f,
          40f,
          5f,
          10f,
          0xFF20232A,
          0xFF4B5059,
          0xFF626874,
          0xFF79818E,
          0xFFFFFFFF,
          0xFF8AB4F8,
        ),
      behavior =
        TypingBehavior(
          composeWords = true,
          enterStrategy = EnterStrategy.KEY_EVENT,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = true,
          recomposeOnBackspaceIntoWord = true,
          batchEdits = true,
        ),
      evidenceStatus = "focused_trace",
      evidenceNote =
        "A focused call sequence matched captured Gboard traces; cursor-move recomposition is enabled pending emulator trace confirmation, and full vendor equivalence is not claimed.",
    )

  /**
   * Behavior verified functional on-device (2026-09-23): word composing, cursor-move recompose
   * (`setComposingRegion` when the caret enters committed text), no batch edits, commit-newline
   * enter, and the green accent style. Triggers the rich-composer fenced-code autoformat. Fidelity
   * against the real Samsung Keyboard (Honeyboard) prediction/composing nuances is still pending a
   * trace from Samsung hardware, which cannot be installed on a non-Samsung device.
   */
  val SAMSUNG =
    KeyboardProfile(
      id = "samsung",
      displayName = "Samsung",
      style =
        KeyboardStyle(
          56f,
          42f,
          4f,
          8f,
          0xFF1C1D21,
          0xFF40434A,
          0xFF575B64,
          0xFF747985,
          0xFFFFFFFF,
          0xFFA9D26F,
        ),
      behavior =
        TypingBehavior(
          composeWords = true,
          enterStrategy = EnterStrategy.COMMIT_NEWLINE,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = true,
          recomposeOnBackspaceIntoWord = true,
          batchEdits = false,
        ),
      evidenceStatus = "experimental",
      evidenceNote =
        "Experimental AutoMobile behavior model; real Samsung Keyboard comparison remains pending.",
    )

  val DEFAULT: KeyboardProfile = GBOARD
  val all: List<KeyboardProfile> = listOf(DIRECT, GBOARD, SAMSUNG)

  fun byId(id: String): KeyboardProfile? = all.firstOrNull { it.id.equals(id, ignoreCase = true) }

  fun negotiateCatalogVersion(clientVersions: List<Int>): Int? =
    SUPPORTED_CATALOG_VERSIONS.filter { it in clientVersions }.maxOrNull()
}
