package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.withContext

/**
 * Re-sends the user's last appearance choice under the session once it registers (#11363). The
 * daemon drops a session's choice when it releases the session for good, so the session a rotation
 * (idle release, hidden host, device switch) brings would otherwise read the global default. It
 * goes over the plain client: restoring a choice is not input, so it allocates nothing, and the
 * daemon applies it when the session claims a device. A re-registration of the same session sends
 * it again, since a daemon restart prunes the rows of sessions it did not keep.
 */
@Composable
internal fun DesktopDaemonCompositionState.AppearanceRestoreEffect(
  options: DesktopDaemonSessionOptions,
  session: DesktopDaemonSession?,
  registered: Boolean,
) {
  with(options) {
    LaunchedEffect(session, registered) {
      val mode = appearanceChoices?.lastChoice
      if (session == null || !registered || mode == null) return@LaunchedEffect
      // The session's own UUID even if it is released meanwhile: the daemon refuses a released
      // one, where an omitted UUID would overwrite the global default.
      val sessionUuid = session.sessionUuid
      val restored =
        withContext(ioDispatcher) {
          runCatching { appearanceClientFactory { sessionUuid }.setMode(mode) }
            .onFailure { error ->
              DESKTOP_DAEMON_COMPOSITION_LOG.warn(
                "Could not restore appearance ${mode.wireName}: ${error.message}",
              )
            }
            .isSuccess
        }
      if (restored) appearanceRestores++
    }
  }
}
