# Android Auto projection provisioning

AutoMobile prepares a phone emulator for Android Auto projection with no person at the screen, then
starts a headless Desktop Head Unit (DHU) against it. The code lives in `src/features/androidAuto/`;
`provisionDevice` exposes it through its `androidAuto` option.

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
| `AdbAndroidAutoScreenDriver`       | The production screen driver: `uiautomator dump` (under the device's shared dump lock) and `input`, so it works before AutoMobile's on-device service exists.   |
| `DesktopHeadUnitLauncher`          | Spawns `desktop-head-unit --headless -c <config>`, waits for `connected.`, watches a settle window and then sends `focus video`.                                |
| `AndroidAutoProjectionProvisioner` | Runs the steps in order and owns one DHU session per emulator. One instance per host; it resolves each emulator's phone-side adapters per request.              |
| `AndroidAutoProjectionApplier`     | The `provisionDevice` seam: resolves the host inputs (APK directory, DHU binary, config) and runs the provisioner on the bound device.                          |

## provisionDevice entry point

`provisionDevice` resolves the host inputs before any lease, creation or boot, and refuses with one
`unsupported` error naming every missing path, because the run could only fail after a long boot.
The projection runs after the session is bound (beside the manufacturer profile), inside the
provision's try block, so its failure rolls back a created emulator like any other post-boot step.
The applier is a process-wide singleton: the provisioner it wraps is what tracks which DHU holds host
port 5277, so two instances would each think the port was theirs.

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
- **Head unit server** reads as on when port 5277 is listening on the phone. The server binds some
  time after **Start head unit server** is tapped, so the provisioner re-checks on a bounded backoff
  (250 ms doubling to 2 s, five re-checks) before reporting it as not listening.
- **Transport** is `adb emu redir add tcp:5277:5277`, not `adb forward`: a forward is dropped with the
  adb transport and takes the projection with it. A bound host port 5277 counts as redirected only when
  this provisioner redirected it to the same device; any other holder, such as another emulator's
  leftover redirect, is refused rather than risk projecting the wrong phone. The DHU dials host port
  5277, so one emulator per host projects at a time: a concurrent call for the same device joins the
  run in progress, and the provisioner refuses another device while a run is in progress or another
  device's DHU has not exited. An unhealthy but live DHU still holds the port, so it is refused too
  (naming the device), not stopped: provisioning never tears down another device's projection.
- **Welcome screen.** **Continue** accepts Android Auto's terms on the user's behalf, so it is tapped
  only when the request sets `acceptAndroidAutoTerms`; otherwise a pending screen is reported as
  `skipped`.

## DHU recovery

A launch fails as `no-connect` when no `connected.` line arrives before the connect timeout, and as
`stalled` when the DHU exits or repeats `Ping timeout` within the settle window after connecting. The
DHU prints `connected.` even when the head unit server is down, so the settle window is what tells a
held connection from that case. The launch reports `connected` only after the pipe accepts
`focus video`; a write the DHU's closed console rejects (EPIPE) is a `stalled` launch. Error
listeners on the child and on its stdin are attached before the first write, so a later EPIPE or
process error marks the session not running instead of escaping as an unhandled `error` event.
A failed launch settles only after its DHU exited through the session's bounded stop (SIGTERM, then
SIGKILL), so a relaunch never races the old process. A DHU that survives both settles as
`unkillable` with the session that still owns it; the provisioner keeps that session tracked (unhealthy,
alive) and fails the provisioning without relaunching. Because it stays in the session map, the
single-projection check refuses other devices while it lives, and the next provision of the same
device retries its stop before any relaunch; once the process exits, launches proceed.
After a failure the provisioner waits the injected backoff,
force-stops Android Auto, starts the head unit server again and relaunches, up to two relaunches by
default.
