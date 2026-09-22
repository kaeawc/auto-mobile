package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard.profile

data class KeyboardProfile(
  val id: String,
  val displayName: String,
  val behavior: TypingBehavior,
)

object KeyboardProfiles {
  val DIRECT =
    KeyboardProfile(
      id = "direct",
      displayName = "Direct",
      behavior =
        TypingBehavior(
          composeWords = false,
          enterStrategy = EnterStrategy.KEY_EVENT,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = false,
          recomposeOnBackspaceIntoWord = false,
          batchEdits = false,
        ),
    )

  /**
   * Best-known defaults to be tuned from real-device InputConnection traces; fidelity is not yet
   * verified.
   */
  val GBOARD =
    KeyboardProfile(
      id = "gboard",
      displayName = "Gboard",
      behavior =
        TypingBehavior(
          composeWords = true,
          enterStrategy = EnterStrategy.KEY_EVENT,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = false,
          recomposeOnBackspaceIntoWord = true,
          batchEdits = true,
        ),
    )

  /**
   * Best-known defaults to be tuned from real-device InputConnection traces; fidelity is not yet
   * verified.
   */
  val SAMSUNG =
    KeyboardProfile(
      id = "samsung",
      displayName = "Samsung",
      behavior =
        TypingBehavior(
          composeWords = true,
          enterStrategy = EnterStrategy.COMMIT_NEWLINE,
          backspaceStrategy = BackspaceStrategy.DELETE_SURROUNDING,
          recomposeOnCursorMove = true,
          recomposeOnBackspaceIntoWord = true,
          batchEdits = false,
        ),
    )

  val DEFAULT: KeyboardProfile = GBOARD
  val all: List<KeyboardProfile> = listOf(DIRECT, GBOARD, SAMSUNG)

  fun byId(id: String): KeyboardProfile? = all.firstOrNull { it.id.equals(id, ignoreCase = true) }
}
