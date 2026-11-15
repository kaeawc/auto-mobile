# Device resources: configuring and reconciling

Part of [device resources](device-resources.md).

## Configuring resources

`setDeviceResources` is disabled by default. Enable it for the MCP session with
`setToolEnabled` using `{"toolName":"setDeviceResources","enabled":true}`, or
start AutoMobile with `--enable-tool setDeviceResources`. Tool names are
case-sensitive. The optional `provisionDevice.resources` field does not require
enabling the standalone tool.

Both tools accept the same partial map of resource names to `enabled`/`disabled`.
Omitted entries are untouched; an empty map, raw service names, unknown keys and
profile names are rejected.

```json
{
  "resources": {
    "wallpaperRendering": "disabled",
    "widgets": "enabled",
    "liveActivities": "enabled",
    "healthServices": "disabled",
    "fitnessServices": "disabled"
  }
}
```

Pass the map to `setDeviceResources` (usual targeting) or alongside `device` in
`provisionDevice`, which requires `boot: true` and applies settings before
automation readiness; each provision call re-reads and reconciles state.

`setDeviceResources.timeoutMs` defaults to 300,000 milliseconds for requests
that configure many services. Provisioning uses its existing shared deadline
for creation, boot, resource configuration, and automation readiness.
Within that deadline, resource configuration reserves time for readiness and
session binding. It cannot consume the whole remaining provisioning budget.

The iOS Simulator implementation controls narrow, disjoint service groups
(disabling wallpaper never disables widgets or Live Activities). Nothing is
disabled by default; settings are workload choices and can degrade optional system
features.

| Controls                                                                   | Scope and tradeoff                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallpaperRendering`, `widgets`, `liveActivities`                          | Separate wallpaper rendering, widget refresh, and Live Activity updates. App widgets need `widgets` enabled.                                                                                                                     |
| `healthServices`, `homeServices`, `fitnessServices`                        | HealthKit/Health, HomeKit, and Fitness background services. Apps using those integrations need them enabled.                                                                                                                     |
| `familyServices`, `screenTime`                                             | Family approvals/parental controls and Screen Time/usage tracking. Keep enabled for restriction tests.                                                                                                                           |
| `newsServices`, `weatherServices`, `tipsServices`, `gameServices`          | Apple content apps and Game Center/save sync; controller input remains untouched.                                                                                                                                                |
| `mapsSync`                                                                 | Maps synchronization and suggested destinations; MapKit rendering and general location services remain untouched.                                                                                                                |
| `advertising`, `diagnosticReporting`                                       | Promoted Apple content and selected diagnostic reporting. Ad privacy, DeviceCheck, setup state, and feature configuration remain untouched. Disabling reporting reduces diagnostic evidence.                                     |
| `siriAndAppIntents`, `speechServices`, `mediaTranscoding`                  | Separate Siri/App Intents, speech/dictation, and Photos conversion services; dependent integrations may fail.                                                                                                                    |
| `photoAnalysis`                                                            | Only background Photos analysis. Library access, cloud transfers, and shared media-analysis services remain untouched. Photo search and recognition can degrade.                                                                 |
| `assistantSuggestions`, `appleIntelligence`                                | Selected Siri suggestion and Apple Intelligence background services. Speech, system voices, shared language/model services, and runtime-gated intelligence workflows remain untouched. System intelligence features may degrade. |
| `searchIndexing`                                                           | System search and app-provided Spotlight indexes; excludes an app's own search service. Settings/Spotlight search may fail.                                                                                                      |
| `appStoreServices`, `appleMediaSync`                                       | App Store installation/update services and Apple media-library/subscription services; push, generic audio/video transport, and StoreKit payment daemons remain untouched by these controls.                                      |
| `mailServices`, `calendarServices`, `reminderServices`, `personalDataSync` | Local Mail, Calendar, Reminders, and Exchange/CalDAV/CardDAV sync. Local Contacts access remains untouched. These are separate from apps' server-side calendars and reminders.                                                   |
| `safariSync`, `icloudSettingsSync`                                         | Safari history/bookmark sync and selected system-settings sync/storage recommendations. Associated domains, shared credentials, browsing protection, Apple accounts, CloudKit, Drive, and Photos transfers remain untouched.     |
| `messagingMaintenance`                                                     | Apple Messages history cleanup/attachment transfer and FaceTime message storage; database XPC helpers, identity, CallKit, and VoIP infrastructure remain untouched.                                                              |
| `watchConnectivity`, `carPlay`, `tvRemote`, `findMy`, `continuity`         | Separate companion/device services. Continuity affects cross-device workflows; system share sheets, keyboard stickers, and avatars remain untouched.                                                                             |
| `walletServices`, `businessServices`                                       | Wallet/payment/digital-identity services and Apple business messaging. Disabling Wallet can also prevent dependent StoreKit payment sheets; keep it enabled for payment tests.                                                   |

App-hosted XPC helpers and the runtime-gated intelligence workflow engine remain
under OS control; these are not standalone service definitions to force-load.

The shared schema is defined by `src/models/deviceResourceDescriptions.ts`; native
labels are scoped in `src/utils/iosDeviceResourceCatalog.ts`. Callers cannot supply
raw launchd labels, shell commands, or arbitrary service paths. Every group is
preflighted against the exact booted runtime before writing. Missing labels are
reported individually and excluded from the group; a group with no
installed services is unsupported. A mismatched, default-disabled, or conditional
definition makes the whole group unsupported without mutations. Native read
failures are unknown, not evidence that a service is absent.

For compatible definitions the controller changes the launchd override, unloads
or restores the exact job without rebooting, then verifies both the override and
job registration. Runtime discovery is shared within a request. Group membership
does not overlap, so enabling one resource cannot silently restore another.

Every native command is argv-based and bounded by both the request deadline and
`IOS_RESOURCE_COMMAND_TIMEOUT_MS` (30,000 ms). Idempotent inventory and
`launchctl print-disabled` reads retry at most twice with a 100/400 ms backoff when
the deadline allows. Writes never retry, because the post-write verification
re-reads state and a retry of the whole request reconciles any partial change.
Resource operations hold the device's lifecycle lease, so they serialize per device
with boot, shutdown, teardown and other configuration, and the device-aware tool
path enforces session ownership.

Broad `backgroundSync` and `icloudSync` remain unsupported. Physical iOS devices
remain unsupported. Android controls are described below; requests can apply
supported entries and report unsupported entries in the same result.

After mutation, `setDeviceResources` and `provisionDevice.resources` also return
an independent `observed` platform snapshot alongside `requested`. This read-only
snapshot covers the full platform resource map, including unrequested groups;
missing read paths report `unsupported` with a reason, and failed reads report
`unknown`. The existing `resources`, `services`, `changed`, `verification`, and
`restore` mutation evidence is preserved. An explicitly opposite enabled/disabled
observation sets `success: false` and lists the resource names in
`observationContradictions`; unknown/unsupported observations do not add failures.
Observation uses the mutation's same deadline and abort signal, including the
readiness reserve during provisioning and fresh observation on a repeated call. A non-abort
observation failure is logged and omits `observed`, preserving mutation results;
cancellation still propagates through the existing tool failure handling.

Results contain `requested`, a `resources` map of observed states for requested
entries, `services` with per-daemon evidence, `changed` (resource groups with
acknowledged native writes), `verification: "current_boot"`,
and `success`. Only a full match of every requested entry is successful. Native
failures or incomplete evidence produce `unknown`, never a guessed enabled or
disabled state. Group success requires every installed compatible service to
match; runtime-absent services remain visible as unsupported in `services`.
Retrying reconciles partial changes. Overrides may survive a
reboot depending on the runtime, but these tools verify only the current boot.

For `setDeviceResources`, an incomplete result is an MCP tool error with the
evidence intact.

`provisionDevice.resources` is all-or-nothing on an iOS Simulator (owner decision
2026-10-09, #6695). After the write and the independent re-read, every requested
entry must be proven. Provisioning fails with the typed error code
`resource_profile_unproven` for an entry that is contradicted (`missingRequested`),
`unsupported`, or has unknown or missing evidence (`commandFailure`). The error is
non-retryable and its `resourceDrift` lists the unproven entries in the same shape
as `reconcileDeviceResources` drift. The message names them too, so a replayed
operation keeps them.

Failure happens before CtrlProxy readiness and session binding. No session is bound,
provisioning releases a replayed session and the lifecycle lease, and the normal
failed-provision cleanup rolls back a simulator this operation created. On an adopted
simulator provisioning deliberately does not revert the overrides it already wrote.
They stay in effect and remain recorded as AutoMobile-owned, because a compensating
write could itself fail and would hide which state the device is really in. Use `reconcileDeviceResources`
(`repair`, optionally `releaseOwnedExtras`) or `setDeviceResources` to converge or
undo them. On Android and physical iOS targets the result
is returned under `resources`, the response is marked as an error, and the
provisioned device identity and session are retained. Booted provisioning
responses expose the session as a top-level `sessionId` field, with no
`sessionUuid` alias, including replayed operations. With `boot: false`, no
top-level session field is present.

## Reconciling workload profiles

After a verified write, the iOS controller records which services AutoMobile
changed to `disabled` in `device_resource_applications`, keyed by the simulator
incarnation: UDID, runtime identifier and device type together, never the UDID
alone. Only resources AutoMobile changed are recorded; a service that was already
disabled is never claimed. Re-enabling a resource removes it. The record is
ownership of an override, not of the simulator. Recording is best effort and never
changes the mutation result.

`reconcileDeviceResources` (opt-in, like `setDeviceResources`) compares a requested
map with an independent observation and returns typed drift:

| Kind               | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `missingRequested` | A requested state is explicitly contradicted.                                |
| `ownedExtra`       | A recorded AutoMobile override outside the requested map is still in effect. |
| `unsupported`      | The runtime cannot provide or control the requested resource.                |
| `commandFailure`   | Native evidence is unknown, mixed or missing; never a guessed state.         |

The default is report only, with no writes. `repair: true` passes only the drifted
`missingRequested` and `commandFailure` entries to the controller, then re-reads every
resource; `releaseOwnedExtras: true` also re-enables owned extras. A second run with
no drift issues no commands. `success` is true only when the final observation proves
every requested entry and no owned extra remains, so unsupported resources fail
closed. After an erase the overrides are gone: requested entries report
`missingRequested`, recorded entries observed enabled are neither extras nor kept,
and a repair reapplies them. A recreated simulator or a replaced runtime is a new
incarnation without a record. Physical devices, Android targets and simulators that
are not booted are rejected before any command runs.

`provisionDevice.resources` already applies resources after boot and before
automation readiness under the provisioning lifecycle lease; its writes are recorded
the same way, so a later reconciliation recognizes them. On an iOS Simulator it
fails closed when the profile cannot be proven (see above).

## Impact of disabling iOS Simulator services

AutoMobile refuses to disable `calendarServices` (`com.apple.calaccessd`) on a booted
simulator with `unsafe_device_resource_combination` whenever the service is still loaded.
Booting it out makes the Calendar app (MobileCal) retry its invalidated connection in a
tight loop for the rest of the boot (about 100-130% of a core, plus 20-50% in
diagnosticd; #15218). The same label disabled before first boot, or one that is already
unloaded, is safe. Request it when `provisionDevice` creates the simulator (applied by
the preboot profile), or leave it enabled. `provisionDevice` adopting an existing simulator that boots first, and
`setDeviceResources`, `reconcileDeviceResources` repair, take the refusal. A hazard is
judged on the resources requested in the one call; members already disabled earlier are
not counted. Disabled resource impacts expose `unsafeWith` (empty `withResources` for this
single-resource hazard), the applicable phases, reason, and evidence.

Verified means exercised on a device; inferred means a dependency-based expectation,
not a measured feature result. The #15097 14-step driving check passed: `startDevice` runner start and process presence, non-degraded
observe, screenshot, launchApp/terminateApp for Settings and Safari, `tapOn`, and
`sendKeys` with typed text visible. This verifies only the shared core driving claim
below, on the measured runtime; it does not verify Siri, Health, wallpaper/widget
visuals, push, or App Intents. All feature-specific AutoMobile and app impacts are
inferred, including where the table says unavailable.

`disabledResources` is the structured companion to the inventory in `observed.resources`.
It appears on `setDeviceResources`, under `provisionDevice.resources`, and on
`reconcileDeviceResources` results when any catalog group is proven disabled.
Each entry contains `resource`, `labels`, `automobileImpact`, and `appImpact`;
each impact has `description`, `confidence`, and optional `evidence`.
Entries follow catalog order, include observed disabled groups outside the requested
map, and exclude unknown/unsupported states. For configuration results, controller-proven
states survive absent or unreadable observations; direct enabled/disabled observations
win. If observation fails, proven controller states still produce the report.
The field is omitted when no catalog resource is disabled and on Android results.
Reconciliation uses its final observed snapshot. Booted-device MCP resources remain
free of resource probes.

`startDevice` and `provisionDevice` also report top-level `disabledResources` for
newly created iOS simulators. This lists catalog resources disabled before first
boot by the default `minimal` profile and explicit requests (explicit enabled
resources remove profile entries). It records the successful host disabled-database
write; it is not independently re-read, unlike `setDeviceResources` verification.
It is omitted for adopted devices, Android, failed writes and empty profiles, and
appears on both boot and no-boot provisioning paths alongside any
`resources.disabledResources` post-boot evidence. Set
`AUTOMOBILE_IOS_PREBOOT_LEAN_PROFILE=none` to opt out of the default profile.

| Resource               | Launchd labels                                                                                                                                                                        | AutoMobile functionality affected                                                                                                                                                                                                                                                                                                                                               | App functionality affected                                                                                         | Confidence                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `wallpaperRendering`   | `com.apple.PosterBoard`                                                                                                                                                               | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Wallpaper visuals may be missing in `observe` results and screenshots.                                                                                                                                                                    | Home and Lock Screen wallpaper does not render.                                                                    | Core driving: verified (#15097); feature impacts: inferred                                        |
| `widgets`              | `com.apple.chronod`                                                                                                                                                                   | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Home and Lock Screen widget visuals may be missing or stale in `observe` results and screenshots.                                                                                                                                         | Widgets do not render or update.                                                                                   | Core driving: verified (#15097); feature impacts: inferred                                        |
| `liveActivities`       | `com.apple.liveactivitiesd`                                                                                                                                                           | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Live Activity visuals may be missing in `observe` results and screenshots.                                                                                                                                                                | Live Activities and Dynamic Island updates do not show.                                                            | Core driving: verified (#15097); feature impacts: inferred                                        |
| `healthServices`       | `com.apple.healthd`<br>`com.apple.healthappd`<br>`com.apple.healthcontentd`<br>`com.apple.healtheventsd`<br>`com.apple.healthrecordsd`                                                | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect HealthKit-backed data may be unavailable.                                                                                                                                                                          | HealthKit data and Health app background functionality are unavailable.                                            | Core driving: verified (#15097); feature impacts: inferred                                        |
| `homeServices`         | `com.apple.homed`<br>`com.apple.homeeventsd`                                                                                                                                          | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise HomeKit accessories or automations may fail.                                                                                                                                                                      | HomeKit accessory control and automations are unavailable.                                                         | Core driving: verified (#15097); feature impacts: inferred                                        |
| `fitnessServices`      | `com.apple.fitcore`<br>`com.apple.fitcore.session`<br>`com.apple.fitnesscoachingd`<br>`com.apple.fitnessintelligenced`<br>`com.apple.activityawardsd`<br>`com.apple.activitysharingd` | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Fitness coaching, awards, or shared activity may fail.                                                                                                                                                             | Fitness coaching, activity awards, and activity sharing may be unavailable.                                        | Core driving: verified (#15097); feature impacts: inferred                                        |
| `familyServices`       | `com.apple.familycircled`<br>`com.apple.FamilyControlsAgent`<br>`com.apple.familynotification`<br>`com.apple.askpermissiond`<br>`com.apple.asktod`                                    | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise family approvals or parental controls may behave differently.                                                                                                                                                     | Family Sharing approvals and parental controls may stop working.                                                   | Core driving: verified (#15097); feature impacts: inferred                                        |
| `screenTime`           | `com.apple.ScreenTimeAgent`<br>`com.apple.ScreenTimeSettingsAgent`<br>`com.apple.UsageTrackingAgent`                                                                                  | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise usage tracking or Screen Time restrictions may behave differently.                                                                                                                                                | Screen Time limits and usage tracking may stop working.                                                            | Core driving: verified (#15097); feature impacts: inferred                                        |
| `newsServices`         | `com.apple.newsd`                                                                                                                                                                     | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect refreshed Apple News content may see stale content.                                                                                                                                                                | Apple News background content may not refresh.                                                                     | Core driving: verified (#15097); feature impacts: inferred                                        |
| `weatherServices`      | `com.apple.weatherd`                                                                                                                                                                  | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Apple Weather forecasts may see stale content.                                                                                                                                                                     | Apple Weather background forecasts may not refresh.                                                                | Core driving: verified (#15097); feature impacts: inferred                                        |
| `tipsServices`         | `com.apple.tipsd`                                                                                                                                                                     | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Apple Tips content may see stale content.                                                                                                                                                                          | Apple Tips background content may not refresh.                                                                     | Core driving: verified (#15097); feature impacts: inferred                                        |
| `gameServices`         | `com.apple.gamed`<br>`com.apple.gamesaved`                                                                                                                                            | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise Game Center or saved-game synchronization may fail.                                                                                                                                                               | Game Center and saved-game synchronization may be unavailable.                                                     | Core driving: verified (#15097); feature impacts: inferred                                        |
| `mapsSync`             | `com.apple.Maps.mapssyncd`<br>`com.apple.Maps.mapspushd`<br>`com.apple.Maps.geocorrectiond`<br>`com.apple.maps.destinationd`                                                          | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect synced Maps favorites, history, or destinations may fail.                                                                                                                                                          | Maps favorites, history, and suggested destinations may not synchronize.                                           | Core driving: verified (#15097); feature impacts: inferred                                        |
| `advertising`          | `com.apple.ap.promotedcontentd`                                                                                                                                                       | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect promoted Apple content may see missing content.                                                                                                                                                                    | Promoted Apple content may not appear.                                                                             | Core driving: verified (#15097); feature impacts: inferred                                        |
| `diagnosticReporting`  | `com.apple.diagnosticextensionsd`<br>`com.apple.feedbackd`<br>`com.apple.rtcreportingd`<br>`com.apple.geoanalyticsd`                                                                  | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that depend on system diagnostic evidence may have less evidence.                                                                                                                                                               | Diagnostic collection, feedback, location analytics, and call-quality reports may be unavailable.                  | Core driving: verified (#15097); feature impacts: inferred                                        |
| `siriAndAppIntents`    | `com.apple.assistantd`<br>`com.apple.assistant_service`<br>`com.apple.assistant_cdmd`<br>`com.apple.siriactionsd`<br>`com.apple.linkd`                                                | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. The future siri tool (#14892) will need these services once shipped, and App Intents workflows may fail.                                                                                                                                  | Siri requests, Shortcuts actions, App Intents, and widget configuration or Controls that use them are unavailable. | Core driving: verified (#15097); feature impacts: inferred                                        |
| `speechServices`       | `com.apple.corespeechd`<br>`com.apple.speechmaintenanced`<br>`com.apple.sirittsd`                                                                                                     | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise dictation or speech input may fail.                                                                                                                                                                               | Dictation, speech recognition, and Siri speech synthesis are unavailable.                                          | Core driving: verified (#15097); feature impacts: inferred                                        |
| `mediaTranscoding`     | `com.apple.photos.ImageConversionService`<br>`com.apple.photos.VideoConversionService`                                                                                                | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. `putAppFile` with media_library imports and workflows using photo-picker conversions may fail when transcoding is required.                                                                                                               | Image and video transcoding may fail during media imports or photo selection.                                      | Core driving: verified (#15097); feature impacts: inferred                                        |
| `photoAnalysis`        | `com.apple.photoanalysisd`                                                                                                                                                            | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect photo recognition or photo-search results may fail.                                                                                                                                                                | Photo analysis, recognition, and analysis-backed photo search are unavailable.                                     | Core driving: verified (#15097); feature impacts: inferred                                        |
| `assistantSuggestions` | `com.apple.siriinferenced`<br>`com.apple.siriknowledged`<br>`com.apple.parsecd`<br>`com.apple.parsec-fbf`<br>`com.apple.proactiveeventtrackerd`                                       | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Siri or proactive suggestions may see missing suggestions.                                                                                                                                                         | Siri inference, knowledge, and proactive suggestions may be unavailable.                                           | Core driving: verified (#15097); feature impacts: inferred                                        |
| `appleIntelligence`    | `com.apple.intelligenceplatformd`<br>`com.apple.intelligencecontextd`<br>`com.apple.intelligencetasksd`<br>`com.apple.generativeexperiencesd`                                         | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise Writing Tools or Apple Intelligence integrations may fail.                                                                                                                                                        | Writing Tools and Apple Intelligence integrations are unavailable.                                                 | Core driving: verified (#15097); feature impacts: inferred                                        |
| `searchIndexing`       | `com.apple.searchd`<br>`com.apple.searchtoold`<br>`com.apple.spotlightknowledged`<br>`com.apple.spotlightknowledged.updater`<br>`com.apple.corespotlightservice`                      | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that use Spotlight or Settings search lookups may fail.                                                                                                                                                                         | Spotlight donations do nothing and system-indexed search results may be unavailable.                               | Core driving: verified (#15097); feature impacts: inferred                                        |
| `appStoreServices`     | `com.apple.appstored`<br>`com.apple.appstorecomponentsd`                                                                                                                              | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that use App Store installation or updates may fail.                                                                                                                                                                            | App Store installations and updates may be unavailable.                                                            | Core driving: verified (#15097); feature impacts: inferred                                        |
| `appleMediaSync`       | `com.apple.itunescloudd`<br>`com.apple.musicd`<br>`com.apple.videosubscriptionsd`<br>`com.apple.assetsubscriptiond`                                                                   | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Apple Music or subscribed media may see missing or stale content.                                                                                                                                                  | Apple Music and subscribed or purchased media may not synchronize.                                                 | Core driving: verified (#15097); feature impacts: inferred                                        |
| `mailServices`         | `com.apple.email.maild`                                                                                                                                                               | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that retrieve sign-in email through Apple Mail may fail.                                                                                                                                                                        | Apple Mail background mail access may be unavailable.                                                              | Core driving: verified (#15097); feature impacts: inferred                                        |
| `calendarServices`     | `com.apple.calaccessd`                                                                                                                                                                | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Disabling on a running simulator is refused with unsafe_device_resource_combination because it makes Calendar spin the CPU. Applying before first boot is allowed. Workflows that inspect or change the local Calendar database may fail. | Local Calendar database access may be unavailable.                                                                 | Core driving: verified (#15097); bootout CPU hazard: verified (#15218); feature impacts: inferred |
| `reminderServices`     | `com.apple.remindd`                                                                                                                                                                   | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect or change Apple Reminders may fail.                                                                                                                                                                                | Apple Reminders database access and background updates may be unavailable.                                         | Core driving: verified (#15097); feature impacts: inferred                                        |
| `personalDataSync`     | `com.apple.exchangesyncd`<br>`com.apple.dataaccess.dataaccessd`                                                                                                                       | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect synchronized Exchange, CalDAV, or CardDAV data may see stale data.                                                                                                                                                 | Exchange, CalDAV, and CardDAV synchronization may stop working.                                                    | Core driving: verified (#15097); feature impacts: inferred                                        |
| `safariSync`           | `com.apple.SafariBookmarksSyncAgent`<br>`com.apple.Safari.History`                                                                                                                    | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect synchronized Safari history or bookmarks may see stale data.                                                                                                                                                       | Safari bookmarks and history may not synchronize.                                                                  | Core driving: verified (#15097); feature impacts: inferred                                        |
| `icloudSettingsSync`   | `com.apple.cloudsettingssyncagent`<br>`com.apple.syncdefaultsd`<br>`com.apple.icloudsubscriptionoptimizerd`                                                                           | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect synchronized iCloud system settings may see stale settings.                                                                                                                                                        | iCloud system settings may not synchronize and storage-plan recommendations may be unavailable.                    | Core driving: verified (#15097); feature impacts: inferred                                        |
| `messagingMaintenance` | `com.apple.imautomatichistorydeletionagent`<br>`com.apple.imcore.imtransferagent`<br>`com.apple.facetimemessagestored`                                                                | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Messages attachment transfers or FaceTime messages may fail.                                                                                                                                                       | Messages history cleanup, attachment transfer, and FaceTime message storage may stop working.                      | Core driving: verified (#15097); feature impacts: inferred                                        |
| `watchConnectivity`    | `com.apple.wcd`<br>`com.apple.companiond`                                                                                                                                             | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise paired Watch or companion-device communication may fail.                                                                                                                                                          | Paired Watch and companion-device communication may be unavailable.                                                | Core driving: verified (#15097); feature impacts: inferred                                        |
| `carPlay`              | `com.apple.carkitd`                                                                                                                                                                   | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise CarPlay connectivity may fail.                                                                                                                                                                                    | CarPlay vehicle connectivity may be unavailable.                                                                   | Core driving: verified (#15097); feature impacts: inferred                                        |
| `tvRemote`             | `com.apple.tvremoted`                                                                                                                                                                 | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise Apple TV discovery or remote control may fail.                                                                                                                                                                    | Apple TV discovery and remote control may be unavailable.                                                          | Core driving: verified (#15097); feature impacts: inferred                                        |
| `findMy`               | `com.apple.findmy.findmylocated`                                                                                                                                                      | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that inspect Find My device locations may fail.                                                                                                                                                                                 | Find My device-location functionality may be unavailable.                                                          | Core driving: verified (#15097); feature impacts: inferred                                        |
| `continuity`           | `com.apple.rapportd`                                                                                                                                                                  | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise cross-device Continuity discovery may fail.                                                                                                                                                                       | Nearby-device discovery and cross-device Continuity workflows may stop working.                                    | Core driving: verified (#15097); feature impacts: inferred                                        |
| `walletServices`       | `com.apple.passd`<br>`com.apple.financed`<br>`com.apple.merchantd`<br>`com.apple.coreidvd`                                                                                            | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise Wallet, payment sheets, or digital identity may fail.                                                                                                                                                             | Wallet, Apple Pay, digital identity, and dependent StoreKit payment sheets may fail.                               | Core driving: verified (#15097); feature impacts: inferred                                        |
| `businessServices`     | `com.apple.businessservicesd`                                                                                                                                                         | Core driving (`startDevice` runner start, `observe`, screenshots, `launchApp`/`terminateApp`, `tapOn`, and `sendKeys`) is unaffected. Workflows that exercise Apple business messaging may fail.                                                                                                                                                                                | Apple business messaging may be unavailable.                                                                       | Core driving: verified (#15097); feature impacts: inferred                                        |
