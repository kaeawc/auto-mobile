# Android Auto projection provisioning

AutoMobile prepares a phone emulator for Android Auto projection with no person at the screen, then
starts a headless Desktop Head Unit (DHU) against it. The code lives in `src/features/androidAuto/`.
No tool exposes it yet.

## No Google account, no credentials

Projection works on a Play emulator with no accounts. An account was only ever needed to update the
Android Auto stub through Play, and Play reports Android Auto as not compatible on the API 36 image, so
the supported path is a sideload. That needs no credentials, so the provisioner has no credential
inputs. Scripted Google sign-in is deliberately absent:

- Google's guidance disallows scripts that automate keystrokes or clicks to sign in.
- New emulators on datacenter IPs get "Verify it's you", 2-Step Verification and CAPTCHA challenges,
  which automation must not get past, and repeated sign-ins risk locking the account.
- There is no supported way to add a `com.google` account over adb:
  `AccountManager.addAccountExplicitly` needs the authenticator's signature.

A flow that needs a signed-in device uses an AVD snapshot that a person signed in to once.

## Pieces

| Piece                              | Role                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AndroidAutoPhone`                 | adb-only reads and writes: sideload state, `install-multiple`, keyguard, stay-awake, notification access, head unit server port, force-stop, emulator redirect. |
| `AndroidAutoSignerCheck`           | Refuses user-supplied APKs unless their signers match the installed stub (or carry it in their rotation lineage), reusing the package signing inspection.       |
| `AndroidAutoSettingsUi`            | The steps with no adb equivalent: developer mode, Unknown sources, Start head unit server, the welcome screen.                                                  |
| `ScriptedAndroidAutoSettingsUi`    | Implements those steps by visible text over an `AndroidAutoScreenDriver` (observe and tap).                                                                     |
| `DesktopHeadUnitLauncher`          | Spawns `desktop-head-unit --headless -c <config>`, waits for `connected.`, watches a settle window and then sends `focus video`.                                |
| `AndroidAutoProjectionProvisioner` | Runs the steps in order and owns one DHU session per emulator.                                                                                                  |

## Order and idempotence

Steps run in this order: install, keyguard off, stay awake, notification access, developer mode,
Unknown sources, head unit server, transport, DHU, welcome screen. Each step reads its state first and
changes nothing when it already holds, so a rerun on a provisioned phone reports every step
`already-done` and reuses the running DHU session.

- **Install.** An updated system app lives under `/data/app`; the stub lives on a read-only partition.
  APKs are needed only while the stub is still in use, and AutoMobile never downloads them.
- **Shell reads** wrap each device condition so the reply is the module's own `yes`/`no` token, not
  the tool's raw output, whose format varies across Android releases.
- **Notification access** is granted before the DHU connects, because the DHU's preflight poll does not
  notice a grant made after it timed out.
- **Developer mode** reads as on when Android Auto's overflow menu lists **Developer settings**.
- **Head unit server** reads as on when port 5277 is listening on the phone.
- **Transport** is `adb emu redir add tcp:5277:5277`, not `adb forward`: a forward is dropped with the
  adb transport and takes the projection with it. A bound host port 5277 counts as redirected only when
  this provisioner redirected it to the same device; any other holder, such as another emulator's
  leftover redirect, is refused rather than risk projecting the wrong phone. The DHU dials host port
  5277, so one emulator per host projects at a time: a concurrent call for the same device joins the
  run in progress, and the provisioner refuses another device while a run or a session is active.
- **Welcome screen.** **Continue** accepts Android Auto's terms on the user's behalf, so it is tapped
  only when the request sets `acceptAndroidAutoTerms`; otherwise a pending screen is reported as
  `skipped`.

## DHU recovery

A launch fails as `no-connect` when no `connected.` line arrives before the connect timeout, and as
`stalled` when the DHU exits or repeats `Ping timeout` within the settle window after connecting. The
DHU prints `connected.` even when the head unit server is down, so the settle window is what tells a
held connection from that case. After a failure the provisioner waits the injected backoff,
force-stops Android Auto, starts the head unit server again and relaunches, up to two relaunches by
default.
