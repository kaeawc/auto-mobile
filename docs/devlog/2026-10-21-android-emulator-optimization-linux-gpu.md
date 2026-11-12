# Linux GPU renderer qualification

- Kind: concept
- Date: 2026-10-21
- Source: moved from `how-it-works/android-emulator-optimization.md`; #12453, #14120
- Shaped: [Android emulator optimization](../how-it-works/android-emulator-optimization.md)

## Results

Repeated post-ready `SIGSEGV` emulator exits on Linux hosts (#12453) were seen
with `-gpu swangle -feature -Vulkan` on emulator 37.2.12.0 and a
`medium_phone` Android 15/API 35 Google APIs `x86_64` image. The cause is still
open: no native backtrace was captured, and the crash has not been reproduced.

The manual `Linux Qualification` workflow
(`.github/workflows/linux-qualification.yml`, scripts under
`scripts/ci/linux-qualification/`) runs each GPU mode under three workloads:
AutoMobile tools, a raw `adb` control, and a heartbeat-only control. Run
38902077979 (main `f1fd091b81`, two cycles per cell, emulator 37.2.12.0,
`android-35;google_apis;x86_64`, GitHub-hosted `ubuntu-latest`, no GPU) gave:

| GPU mode               | AutoMobile             | Raw adb control        | Heartbeat only         |
| ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| `swiftshader_indirect` | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `swangle`              | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `angle_indirect`       | 2/2 clean              | 2/2 clean              | 2/2 clean              |
| `host`                 | fails at renderer init | fails at renderer init | fails at renderer init |

No software or indirect GPU cell crashed after readiness. `-gpu host` stops
before readiness with `Failed to get EGL display` / `Could not start renderer`
because the runner has no GPU render node. That is a startup failure, not the
post-ready signature. Two clean cycles per cell is weak evidence: it neither
clears nor implicates any software renderer.

The emulator's `-verbose` output shows what each flag actually selected on
37.2.12.0:

| Flag passed                     | Renderer the emulator used                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `-gpu swiftshader_indirect`     | mode `swiftshader`: SwiftShader GLES (`gles_swiftshader`, GLES 3.0), SwiftShader Vulkan |
| `-gpu swangle -feature -Vulkan` | ANGLE GLES (`gles_swangle`, GLES 3.1) on SwiftShader; host `Vulkan` feature off         |
| `-gpu angle_indirect`           | fell back to mode `lavapipe`: ANGLE GLES on Mesa llvmpipe Vulkan                        |

The `angle_indirect` row therefore measured ANGLE on Lavapipe, not a distinct
ANGLE-indirect path.

The emulator documentation deprecates `swiftshader_indirect`,
`swangle_indirect` and `guest` (36.4.9) and `angle_indirect` (34.2.14). The
current software modes are `software`, `swiftshader`, `lavapipe` and `swangle`.
CI (`.github/actions/android-emulator/action.yml`) passes `-gpu swiftshader`,
the mode the deprecated `swiftshader_indirect` already mapped to.

Linux configuration guidance until the cause is known:

- On headless hosts without a GPU, use a current software mode: `-gpu swangle`
  or `-gpu swiftshader`. Both were clean in this matrix. Pass it with
  `AUTOMOBILE_EMULATOR_ARGS='["-gpu","swangle"]'`.
- Use `-gpu host` only where `/dev/dri/renderD*` and a working EGL/Vulkan driver
  exist.
- `-feature -Vulkan` is the one non-default part of the crashing hosts'
  configuration. It was clean here, but it is unqualified beyond these runs;
  omit it unless a workload needs it.

When an emulator exits unexpectedly, the loss incident keeps the process exit
signal and a bounded, redacted `outputTail` of emulator output from launch
onward. `outputUnavailable: "adopted"` marks an emulator AutoMobile did not
launch, so no output was tracked. Slot recovery (`onLoss`) stays off by default
and never substitutes a different device.

The `swangle` cell matched the crashing hosts' flags, emulator build, image and
hardware profile. What still differs is the host machine, the experimental
broker build (these runs used the published 0.0.85 package), the repeated
acquire/release workload, and the cycle count. A longer soak on `swangle` and
`swiftshader` is the remaining step for #12453; no self-hosted GPU host is
available, so the `host` row stays unexercised.
