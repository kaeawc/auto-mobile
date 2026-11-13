# Android Auto stub and DHU 2.1 on a Play emulator

- Kind: concept
- Date: 2026-11-08
- Source: moved from `how-it-works/plat/android/form-factors.md`; #17553
- Shaped: [Android form factors: TV, Wear OS and Android Auto](../how-it-works/plat/android/form-factors.md)

## Measurements

Measured on a Mac arm64 host with DHU 2.1 (`Build: 2022-12-15-495527557`) against a `google_apis_playstore` API 36 phone emulator.

- **The Play image's Android Auto is a stub.** There is no head-unit server to project from until a person signs in to Play or sideloads a trusted Android Auto APK:

  ```
  package:com.google.android.projection.gearhead
      versionName=1.2.551000-stub
  ```

  `com.android.settings.action.SETTINGS` resolves to `com.google.android.projection.gearhead/com.google.android.apps.auto.components.app.stubapp.StubSettingsActivity`; starting it ends on `com.android.vending/com.google.android.finsky.unauthenticated.activity.UnauthenticatedMainActivity` (the Play sign-in wall), so Developer settings and **Start head unit server** are unreachable. Automated lanes must not sign in, so this step stays with a person.

- **The DHU exits against the stub.** With `adb forward tcp:5277 tcp:5277` and `desktop-head-unit --headless -a localhost:5277`, the DHU connects at the adb layer and exits when the transport drops, because nothing listens on the phone's 5277:

  ```
  [W]: No configuration specified - using default values.
  [E]: Could not load configuration from '~/.android/headunit.ini'.
  BoringSSL is the SSL implementation used in the receiver-lib.
  Starting link. Requested protocol version: 1.7
  [I]: Connecting over ADB to localhost:5277...
  [I]: connected.
  Android Auto - Desktop Head Unit
    Build: 2022-12-15-495527557
    Version: 2.1-mac-arm64

  > [E]: Failed to read from transport - disconnect. Exiting...
  ```

  (The `connected.` line carries ANSI colour codes in the raw output.)

- **Console commands.** Read from the installed binary's strings, not from a live `help`: `dpad <up|down|left|right|click|back|soft left|soft right|flick left|flick right|rotate left|rotate right|ul|ur|dl|dr|0-9|#|*|+>`, `rotary`, `day`, `night`, `mic begin|reject|repeat`, `focus <audio|nav|video|video toggle>`, `screenshot <filename.png>` ("Save screenshot to filename in PNG format."), `sleep <seconds>` and `quit`. There is no coordinate `tap` command: touch comes from the DHU window pointer, so an automated driver would go through `dpad`/`rotary` or window-level input.

- **Shipped configs.** `extras/google/auto/config` ships `all_720p auxillary_nav cluster default default_1080p default_6in default_720p default_sensors default_wide hybrid loaded_720p rotary touchpad` (`.ini`), selected with `-c`/`--config`. `default.ini` is `resolution = 800x480`, `dpi = 160`, `framerate = 30`.

- **Unverified.** A live `help`, `screenshot` and phone-side `observe` during projection need a real projection session and are unverified until a person completes the Play sign-in step. The phone-side `observe` should not show projected UI, because the host renders it into the head unit.
