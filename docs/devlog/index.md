# Devlog

Dated entries that record why AutoMobile works the way it does. The [how it works](../how-it-works/index.md)
pages say what is true now; each entry here keeps the context, options and history behind a choice,
and links to the pages it shaped. Kinds:

- **decision**: a decision record with context, options, decision and consequences;
- **concept**: a write-up of an idea, audit, measurement or experiment the design rests on;
- **idea**: a proposal or plan not yet built.

To add one, copy the [template](template.md).

| Date       | Kind     | Entry                                                                                                                              |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-14 | decision | [Observation screenshots stay readable for a bounded window](2026-11-14-observation-screenshot-retention-window.md)                |
| 2026-11-13 | decision | [Pin a `navigateTo` attempt to one transition](2026-11-13-pinned-navigate-transition.md)                                           |
| 2026-11-13 | concept  | [iOS Simulator fleet capacity measurements](2026-11-13-ios-simulator-fleet-capacity-measurements.md)                               |
| 2026-11-13 | decision | [Split the audit tool into `accessibilityAudit` and `performanceAudit`](2026-11-13-split-audit-tool.md)                            |
| 2026-11-13 | decision | [Android TV explore: dry-run input mode and focus-only dispatch](2026-11-13-android-tv-explore-dry-run-and-focus-only-dispatch.md) |
| 2026-11-13 | decision | [Docs readability gate per section](2026-11-13-docs-readability-section-gate.md)                                                   |
| 2026-11-13 | decision | [Banned-phrase lint takes source lines from mdast positions](2026-11-13-banned-phrase-lint-mdast-positions.md)                     |
| 2026-11-11 | decision | [Build the camera poster dylib on demand](2026-11-11-simulator-camera-poster-on-demand-build.md)                                   |
| 2026-11-11 | decision | [Live preview server uses node:http and SSE, not Vite](2026-11-11-prototype-web-preview-server-no-vite.md)                         |
| 2026-11-11 | idea     | [Headless prototype follow-ups](2026-11-11-prototype-headless-follow-ups.md)                                                       |
| 2026-11-11 | idea     | [Car App templates: head-unit visibility from host state](2026-11-11-car-app-templates-host-visibility.md)                         |
| 2026-11-10 | decision | [Interactive observe App spike](2026-11-10-observe-app-interactive-spike.md)                                                       |
| 2026-11-10 | decision | [Post-action screenshot timing](2026-11-10-interaction-loop-screenshot-timing.md)                                                  |
| 2026-11-10 | decision | [Android Auto projection: no Google account](2026-11-10-android-auto-projection-provisioning-no-account.md)                        |
| 2026-11-08 | concept  | [Android Auto stub and DHU 2.1 on a Play emulator](2026-11-08-form-factors-android-auto-dhu-stub.md)                               |
| 2026-11-08 | decision | [AndroidX baseline profile tooling for CtrlProxy](2026-11-08-androidx-baseline-profile-generator.md)                               |
| 2026-11-06 | decision | [Keystore StrongBox fault: pre-generation check](2026-11-06-keystore-strongbox-fault-pre-generation-check.md)                      |
| 2026-11-06 | decision | [AndroidX TV libraries for the Android TV fixture apps](2026-11-06-androidx-tv-fixture-libraries.md)                               |
| 2026-11-05 | decision | [Prototype remote image URLs](2026-11-05-prototype-ux-remote-image-urls.md)                                                        |
| 2026-11-05 | decision | [Eject scaffold covers a fixed node subset](2026-11-05-prototype-embedding-eject-subset.md)                                        |
| 2026-11-04 | decision | [visionOS XCUITest runner scope](2026-11-04-xcuitest-capabilities-visionos-runner-scope.md)                                        |
| 2026-11-04 | idea     | [Device farm design](2026-11-04-device-farm-design.md)                                                                             |
| 2026-11-04 | decision | [AndroidX Wear libraries for the Wear OS fixture app](2026-11-04-androidx-wear-fixture-libraries.md)                               |
| 2026-11-04 | decision | [androidx.car.app for Car App Library template snapshots](2026-11-04-androidx-car-app-template-snapshots.md)                       |
| 2026-11-03 | decision | [Device Streaming tokens come from gcloud](2026-11-03-session-broker-remote-devices-gcloud-token.md)                               |
| 2026-11-03 | decision | [qrcode-generator for the prototype share QR](2026-11-03-qrcode-generator-share-qr.md)                                             |
| 2026-11-03 | decision | [Embeddable web prototype library plan](2026-11-03-prototype-web-library-plan.md)                                                  |
| 2026-11-03 | decision | [CSS 3D transforms for the web device view](2026-11-03-prototype-web-3d-css-transforms.md)                                         |
| 2026-11-03 | decision | [Material Icons SVG package for prototype web icon glyphs](2026-11-03-material-icons-web-glyphs.md)                                |
| 2026-11-03 | decision | [fastlane supply for ProtoViewer Google Play publishing](2026-11-03-fastlane-supply-play-publishing.md)                            |
| 2026-11-03 | decision | [Defer CarPlay prototypes](2026-11-03-carplay-prototypes-deferred.md)                                                              |
| 2026-11-02 | decision | [playwright-core for the prototype web screenshot check](2026-11-02-playwright-core-web-screenshots.md)                            |
| 2026-10-31 | decision | [watchOS XCUITest runner spike](2026-10-31-xcuitest-spike-watchos-runner.md)                                                       |
| 2026-10-31 | decision | [tvOS XCUITest runner spike](2026-10-31-xcuitest-spike-tvos-runner.md)                                                             |
| 2026-10-31 | concept  | [SDK prerequisite captures](2026-10-31-prototype-sdk-matrix-prerequisite-captures.md)                                              |
| 2026-10-31 | idea     | [OEM identity lane: first executor rung](2026-10-31-oem-identity-lane-first-executor.md)                                           |
| 2026-10-28 | decision | [watchOS as its own platform, fail-closed per tool](2026-10-28-watchos-platform.md)                                                |
| 2026-10-28 | decision | [Prototype map backends and tile sources](2026-10-28-prototype-ux-map-backends.md)                                                 |
| 2026-10-28 | concept  | [Persona robustness harness: survival measurements](2026-10-28-persona-robustness-harness-survival-measurements.md)                |
| 2026-10-28 | decision | [Emulator gRPC audio: transport choice and open questions](2026-10-28-emulator-grpc-audio-transport.md)                            |
| 2026-10-27 | decision | [Workflow de-duplication audit and plan](2026-10-27-workflow-deduplication-audit.md)                                               |
| 2026-10-27 | idea     | [MCP SDK v2 adoption survey](2026-10-27-sdk-v2-adoption-survey-proposals.md)                                                       |
| 2026-10-27 | decision | [Prototype glass surfaces and custom AGSL shaders](2026-10-27-prototype-ux-glass-and-custom-shaders.md)                            |
| 2026-10-27 | decision | [Declarative mock backend for prototypes](2026-10-27-prototype-mock-backend.md)                                                    |
| 2026-10-27 | decision | [Attestation store layout and read cache](2026-10-27-attestation-store-layout.md)                                                  |
| 2026-10-27 | decision | [Ed25519 for the attestation envelope](2026-10-27-attestation-envelope-ed25519.md)                                                 |
| 2026-10-26 | decision | [Prototype native look and motion profiles](2026-10-26-prototype-ux-native-look-and-motion-profiles.md)                            |
| 2026-10-26 | decision | [Read-only live observe App shell](2026-10-26-observe-app-shell-read-only.md)                                                      |
| 2026-10-26 | decision | [Elicitation for an ambiguous device target](2026-10-26-elicitation-ambiguous-device-scope.md)                                     |
| 2026-10-26 | concept  | [Android emulator host cost research](2026-10-26-android-emulator-host-cost-research.md)                                           |
| 2026-10-25 | decision | [ProtoViewer open-source notice generators](2026-10-25-protoviewer-open-source-notices.md)                                         |
| 2026-10-24 | concept  | [Simulator first-boot CPU measurements](2026-10-24-simulator-load-reduction-measurements.md)                                       |
| 2026-10-24 | decision | [Lean profile and template clone defaults](2026-10-24-simulator-load-reduction-defaults.md)                                        |
| 2026-10-23 | concept  | [Session broker native qualification](2026-10-23-session-broker-experiment-native-qualification.md)                                |
| 2026-10-23 | decision | [Unpersisted recording gap is an accepted residual](2026-10-23-session-broker-device-mutation-journal-unpersisted-gap.md)          |
| 2026-10-23 | idea     | [ProtoViewer on-device agent and tool surfaces](2026-10-23-protoviewer-agent-design.md)                                            |
| 2026-10-23 | concept  | [Manual-test batch incidents](2026-10-23-manual-test-harness-batch-incidents.md)                                                   |
| 2026-10-23 | idea     | [macOS-only test subset on a PR lane](2026-10-23-macos-only-tests-pr-lane.md)                                                      |
| 2026-10-22 | idea     | [Android form-factor spike: TV, Wear OS and Android Auto](2026-10-22-form-factors-spike.md)                                        |
| 2026-10-22 | decision | [Device-condition attestation ceiling](2026-10-22-device-condition-attestation-ceiling.md)                                         |
| 2026-10-21 | idea     | [Android windowing: verification plan and follow-ups](2026-10-21-windowing-verification-plan.md)                                   |
| 2026-10-21 | decision | [Keep-booted reset is operational cleanup](2026-10-21-session-broker-experiment-keep-booted-cleanup.md)                            |
| 2026-10-21 | concept  | [Session broker reuse measurements](2026-10-21-session-broker-device-reuse-measurements.md)                                        |
| 2026-10-21 | idea     | [Legacy-restorer import into the mutation journal](2026-10-21-session-broker-device-mutation-journal-legacy-restorer-import.md)    |
| 2026-10-21 | decision | [Best-effort keep-booted cleaning](2026-10-21-ios-keep-booted-reset-best-effort.md)                                                |
| 2026-10-21 | idea     | [Device-condition capability probe: spike and helper proposal](2026-10-21-device-condition-capability-probe-spike.md)              |
| 2026-10-21 | concept  | [Linux GPU renderer qualification](2026-10-21-android-emulator-optimization-linux-gpu.md)                                          |
| 2026-10-20 | decision | [Spy-only unit files in the shared process](2026-10-20-unit-lane-scaling-spy-only-shared.md)                                       |
| 2026-10-20 | decision | [ProtoViewer design decisions](2026-10-20-protoviewer-design.md)                                                                   |
| 2026-10-20 | decision | [Request routing for embedded prototype renderers](2026-10-20-prototype-embedded-request-routing.md)                               |
| 2026-10-19 | decision | [@types/bun for the test/ type-check](2026-10-19-types-bun-test-typecheck.md)                                                      |
| 2026-10-19 | decision | [Stylus, pressure and hover injection spike](2026-10-19-stylus-pressure-hover-injection-spike.md)                                  |
| 2026-10-18 | decision | [Pressure, hover and stylus input research](2026-10-18-pressure-hover-stylus-input-research.md)                                    |
| 2026-10-17 | decision | [MCP TypeScript SDK v2 split packages](2026-10-17-mcp-sdk-v2-split-packages.md)                                                    |
| 2026-10-16 | decision | [Retrofit for prototype `request` actions on the device](2026-10-16-prototype-request-retrofit.md)                                 |
| 2026-10-15 | decision | [Session state record and row writer design](2026-10-15-session-state-record-design.md)                                            |
| 2026-10-15 | decision | [Verifying iOS Photos full access](2026-10-15-photos-full-access-verification.md)                                                  |
| 2026-10-15 | decision | [Android dependency injection: Metro only](2026-10-15-dependency-injection-metro-only.md)                                          |
| 2026-10-14 | decision | [Physical panel identity: hidden-API finding and fingerprint decision](2026-10-14-physical-panel-identity-fingerprint.md)          |
| 2026-10-14 | concept  | [Android 17 Playground audit](2026-10-14-android17-playground-audit.md)                                                            |
| 2026-10-14 | concept  | [Android 17 CtrlProxy targetSdk 37 audit](2026-10-14-android-17-target-sdk-audit.md)                                               |
| 2026-10-13 | decision | [Prototype performance measurements](2026-10-13-prototype-performance-measurement-results.md)                                      |
| 2026-10-09 | idea     | [Prototype spec open follow-ups](2026-10-09-prototype-ux-open-follow-ups.md)                                                       |
| 2026-10-09 | decision | [iOS prototype agent decisions](2026-10-09-prototype-agent-ios-decisions.md)                                                       |
| 2026-10-09 | decision | [macOS CI capacity plan choices](2026-10-09-macos-capacity-plan-choices.md)                                                        |
| 2026-10-09 | decision | [Moving GitHub-hosted macOS jobs to CircleCI](2026-10-09-circleci-macos-migration-plan.md)                                         |
| 2026-10-08 | decision | [Unit lane scaling study](2026-10-08-unit-lane-scaling-study.md)                                                                   |
| 2026-10-08 | idea     | [iOS prototype agent verification backlog](2026-10-08-prototype-agent-ios-verification-backlog.md)                                 |
| 2026-10-08 | concept  | [Golden replay of the nearest-match tie-break](2026-10-08-golden-replay-tie-break-results.md)                                      |
| 2026-10-06 | decision | [Keep iproxy behind a typed tunnel client](2026-10-06-iproxy-tunnel-client.md)                                                     |
| 2026-10-04 | decision | [Prototype spec shape and host-escape decisions](2026-10-04-prototype-ux-spec-decisions.md)                                        |
| 2026-10-04 | concept  | [Prototype device verification status](2026-10-04-prototype-ux-device-verification-status.md)                                      |
| 2026-10-02 | concept  | [devicectl simulator probe findings](2026-10-02-simctl-devicectl-boundary-probe-findings.md)                                       |
| 2026-10-01 | decision | [HierarchyMerger range-index matching](2026-10-01-fixup-hierarchy-merger-geometry-range-index.md)                                  |
| 2026-09-18 | decision | [Canonical device description: alias removal and live audit](2026-09-18-device-description-audit-canonical-shape.md)               |
| 2026-09-13 | decision | [System tray: header-less Silent rows](2026-09-13-system-tray-lookfor-headerless-rows.md)                                          |
| 2026-09-13 | concept  | [Android emulator optimization measurements](2026-09-13-android-emulator-optimization-measurements.md)                             |
| 2026-09-09 | concept  | [CtrlProxy Swift 6 rewrite status and race ledger](2026-09-09-status-ctrlproxy-swift6-rewrite.md)                                  |
| 2026-09-09 | decision | [CtrlProxy Swift 6 parallel rewrite](2026-09-09-readme-ctrlproxy-swift6-parallel-rewrite.md)                                       |
| 2026-09-05 | decision | [Accessibility-data-sensitive windows: null roots on Android 14](2026-09-05-accessibility-data-sensitive-windows-null-roots.md)    |
| 2026-08-28 | decision | [iOS `user_files` provider](2026-08-28-ios-user-files-provider.md)                                                                 |
| 2026-08-21 | decision | [Pinning the published runtime dependency graph](2026-08-21-runtime-dependency-pinning.md)                                         |
| 2026-07-29 | decision | [MCP SDK v2 and stateless daemon migration](2026-07-29-sdk-v2-stateless-migration-decisions.md)                                    |
