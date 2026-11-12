# Car App templates: head-unit visibility from host state

- Kind: idea
- Date: 2026-11-11
- Source: moved from `how-it-works/plat/android/car-app-templates.md`; #17827, #17868
- Shaped: [Car App Library template snapshots](../how-it-works/plat/android/car-app-templates.md)

## Idea

Android Auto does not say which bound app is on the head unit (#17827), so the `androidAuto` block
never names a visible app. The templates host's own state (`dumpsys activity service <host>`,
`activity state:RESUMED`/`isShowing:true`) does tell visibility for a car app category with a single
bound app. It is not read until a capture of it is committed.
