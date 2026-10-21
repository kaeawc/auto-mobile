# Android `locksettings` / `dumpsys lock_settings` fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14107). Each file reproduces what the named command prints,
reconstructed from AOSP `LockSettingsService.dump()` and `LockSettingsShellCommand`
(Android 10 and Android 14 sources). Protector IDs, SIDs, timestamps and quality values
are plausible, not real. Replace them with verbatim captures when a device is available,
and record the device, API level and capture command here.

`locksettings` output is the shell command's stdout only; the AutoMobile exit-status
marker that `AdbLockSettingsClient` appends is added by the tests.

| File                                           | Command                                                  | Format point it pins                                                |
| ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `dumpsys-lock-settings-api34-none.txt`         | `dumpsys lock_settings` (no lock)                        | `CredentialType: None` under `User 0`                               |
| `dumpsys-lock-settings-api34-pin.txt`          | `dumpsys lock_settings` (after `set-pin`)                | `CredentialType: Pin`                                               |
| `dumpsys-lock-settings-api34-work-profile.txt` | `dumpsys lock_settings` (work profile)                   | Only user 0 counts; user 10 has its own `Password`                  |
| `dumpsys-lock-settings-api29-legacy-int.txt`   | `dumpsys lock_settings` (Android 10)                     | Integer constant `2` (PIN or password): secure, type unknown        |
| `dumpsys-lock-settings-no-credential-type.txt` | `dumpsys lock_settings` (no type line)                   | No `CredentialType`: falls back to `dumpsys window policy`          |
| `locksettings-set-pin-ok.txt`                  | `locksettings set-pin 1357`                              | Success echoes the new credential (`Pin set to '…'`)                |
| `locksettings-clear-ok.txt`                    | `locksettings clear --old 1357`                          | `Lock credential cleared`                                           |
| `locksettings-old-mismatch.txt`                | `locksettings set-pin --old 2468 1357` (another PIN set) | Refusal echoes the old credential (`Old password '…' didn't match`) |
| `locksettings-old-without-credential.txt`      | `locksettings clear --old 1357` (no lock)                | `Old password provided but user has no password`                    |
| `locksettings-no-secure-lock-screen.txt`       | `locksettings set-pin 1357` (no keyguard)                | Device without a secure lock screen                                 |

Both success and refusal messages echo a credential, which is why the client scrubs all
`locksettings` output before it can reach an error, a log or a tool result.
