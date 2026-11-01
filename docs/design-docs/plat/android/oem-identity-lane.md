# OEM identity lane

An opt-in lane for exercising an app's own OEM branches (`if (Build.MANUFACTURER == "samsung")`)
on an emulator (#14059). It is QA only. It does not mimic OEM behaviour (that is the
[manufacturer profile](../../../using/oem-personas.md) facets' job) and it is never a way past
Play Integrity or any other attestation.

## Scope

AutoMobile defines **descriptors only**: the identity props and OEM system features a persona
would present, in `src/features/utility/OemIdentityDescriptor.ts`. Nothing applies a descriptor
yet. AutoMobile installs no root tooling and ships no OEM APKs, images or firmware. Any rung below
that needs root or a writable system stays out until it has its own security review.

## What an app can detect

Apps tell OEMs apart through four layers, and a prop reaches only the first:

| Layer                             | Source                                          | Reachable by a descriptor                          |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `Build.*` fields                  | `ro.product[.<partition>].*` props              | Yes: `props`                                       |
| `PackageManager.hasSystemFeature` | Permission XMLs under `/system/etc/permissions` | Yes: `features` (needs a writable system to apply) |
| Installed OEM packages            | The OEM's system apps                           | No: shipping OEM APKs is out of scope              |
| OEM framework classes             | The OEM's framework jars                        | No                                                 |

A test that depends on the last two layers belongs on a real device.

## Descriptor

| Field       | Rule                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `personaId` | A catalog manufacturer profile id (`samsung-oneui`, `xiaomi-hyperos`, …)                                                                                                                                    |
| `version`   | A positive integer, bumped when any value changes                                                                                                                                                           |
| `props`     | `ro.product.<field>` or `ro.product.<partition>.<field>`, where `<field>` is `manufacturer`, `brand`, `model`, `device` or `name` and `<partition>` is `system`, `vendor`, `odm`, `product` or `system_ext` |
| `features`  | Unique OEM feature names, for example `com.samsung.feature.samsung_experience_mobile`; `android.*` is refused                                                                                               |
| `evidence`  | The persona evidence shape: `status`, `note`, optional `source`                                                                                                                                             |

Unknown fields are refused, so an APK or image reference cannot ride along. At least one prop or
feature is required.

Values are 1–91 characters of `[A-Za-z0-9 ._/+:-]`. 91 is the classic `PROP_VALUE_MAX` less its
terminator, and the character set leaves nothing a device shell could interpret if a later
executor passes the value to `setprop` or writes it into `build.prop`.

Props are limited to the `Build` identity fields. `ro.build.fingerprint`, `ro.build.tags`,
`ro.build.type`, `ro.debuggable`, `ro.secure` and the `ro.boot.*` verified-boot props are
integrity signals, and spoofing them is out of scope. Version props an OEM adds (for example
`ro.miui.ui.version.name`) are not in the schema yet.

## Privilege rungs

Each rung reaches further and costs more. None is wired.

| Rung                                                                   | Privilege         | Reaches                       | Notes                                                         |
| ---------------------------------------------------------------------- | ----------------- | ----------------------------- | ------------------------------------------------------------- |
| Stock AVD `-prop`                                                      | none              | Nothing useful                | Only `qemu_prop`-labelled names; `ro.product.*` cannot be set |
| Genymotion `setprop persist.ro.product.*`, then reboot                 | supported         | Part of `props`               | Fixed prop list that omits the model                          |
| `-writable-system`, `adb remount`, edit `build.prop`, add feature XMLs | writable system   | `props` and `features`        | Changes a temporary system copy                               |
| rootAVD and Magisk `resetprop`                                         | root              | `props`                       | Bumps the prop-area serial, which apps can detect             |
| LSPosed or Frida hooks on `Build` / `SystemProperties`                 | root and Zygisk   | `props`, per app              | Detectable                                                    |
| Cuttlefish or an AOSP product build                                    | build from source | `props`, `features`, overlays | Consistent props, overlays and XMLs                           |

The writable-system rung is the first that covers both descriptor fields without root tooling,
which makes it the likely first executor once it is reviewed. A run on a rung that needs an
emulator uses a dedicated AVD, never a shared one.
