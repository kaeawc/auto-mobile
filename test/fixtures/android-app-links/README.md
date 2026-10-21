# Android App Links fixtures

Captured-shape output of the Android 12+ domain verification shell
(`DomainVerificationShell` in AOSP), used by the `getDeepLinks` App Links section
and the `setAppLinks` tool (#14110).

> [!NOTE]
> These fixtures are **hand-reconstructed** from the AOSP shell implementation
> and published sample output, not captured from a device in this change. No
> emulator was available when they were written. Replace them with real
> captures (`adb shell pm get-app-links --user <id> <pkg> > file.txt`) when a
> device run disagrees with them.

| File                                               | Device | Shape                                                                                                                                                                         |
| -------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-app-links-api31-user0.txt`                    | API 31 | `verified` and `none` autoVerify domains; one non-autoVerify domain; everything under `Disabled:`                                                                             |
| `get-app-links-api34-user0-mixed.txt`              | API 34 | `Domain verification status:` header, `approved`, `denied`, `legacy_failure` and a numeric verifier code; `Enabled:` and `Disabled:` lists; a second package after the target |
| `get-app-links-api35-user10-handling-disabled.txt` | API 35 | `User 10:` with link handling disallowed and tab indentation                                                                                                                  |
| `get-app-links-no-user.txt`                        | API 33 | read without `--user`: verification states only                                                                                                                               |
| `get-app-links-api30-unknown-command.txt`          | API 30 | `pm` without the app-links commands                                                                                                                                           |
