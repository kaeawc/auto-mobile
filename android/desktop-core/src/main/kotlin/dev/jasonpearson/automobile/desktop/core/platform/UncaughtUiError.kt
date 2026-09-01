package dev.jasonpearson.automobile.desktop.core.platform

/**
 * Human-readable message for the app's last-resort uncaught-UI-exception dialog.
 *
 * Compose Desktop's default handler shows a bare Swing dialog whose only content is the throwable's
 * `toString()` — for a [NoClassDefFoundError] that is just a slash-form class path
 * (`dev/jasonpearson/.../DaemonPidReadResult$Absent`), which reads as gibberish. The app installs
 * its own handler (see Main.kt) that logs the full stack and shows this message instead. The dialog
 * itself stays native (Swing) ON PURPOSE: the one situation this surface exists for is "composition
 * is broken" — e.g. the jar was rebuilt under the running JVM and Compose classes may no longer
 * load — so the error UI must not depend on Compose rendering.
 */
fun uncaughtUiErrorMessage(throwable: Throwable): String {
  val summary = "${throwable.javaClass.simpleName}: ${throwable.message ?: "no further detail"}"
  val hint =
    if (throwable is NoClassDefFoundError || throwable is ClassNotFoundException) {
      // The classic dev-loop trap: a jar rebuilt while this JVM is running poisons its
      // classloader; the first lazy class load afterwards fails. Nothing is wrong with the
      // source — restarting the app on the fresh build fixes it.
      "\n\nThe app's code on disk changed after launch (a rebuild while the app was " +
        "running). Restart AutoMobile to load the current build."
    } else {
      "\n\nDetails were written to the application log."
    }
  return "AutoMobile hit an unexpected error.\n\n$summary$hint"
}
