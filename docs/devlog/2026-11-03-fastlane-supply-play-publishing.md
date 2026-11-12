# fastlane supply for ProtoViewer Google Play publishing

- Kind: decision
- Date: 2026-11-03
- Source: moved from `docs/decisions/fastlane-supply-play-publishing.md` (added in #16488)
- Shaped: [ProtoViewer: a prototype library app for iOS and Android](../how-it-works/protoviewer.md)

Status: accepted for #14147 (part of the ProtoViewer store-readiness epic #14142).

Dependency: `fastlane` (Ruby gem, `fastlane/Gemfile`), CI-only

## Decision

`publish-protoviewer-play.yml` talks to Google Play through fastlane's `supply` action. The gem is
pinned in `fastlane/Gemfile` and every transitive gem is locked with a checksum in
`fastlane/Gemfile.lock`. The `setup-fastlane` composite action installs it frozen, with no gem
cache, and only in publishing jobs. Nothing in `src/`, `android/` or the npm package depends on it.
`scripts/release/protoviewer-play.sh` builds every `supply` call, so the tracks, promotions and
skip flags are tested in bats without fastlane installed. See
`docs/how-it-works/protoviewer.md` section 8.3 for the pipeline.

Reasons:

- The store metadata is already in fastlane layout (`fastlane/metadata/android` and
  `fastlane/metadata/ios`, validated in Fast Validation). `supply` reads per-version release notes
  from `changelogs/<versionCode>.txt` in that tree.
- `supply` promotes an uploaded versionCode between tracks (`track_promote_to` with
  `skip_upload_aab`), so closed testing and production get the exact bundle that internal testers
  ran.
- An App Store pipeline can use the same tool (`deliver`, `pilot`), so there is one uploader and
  one metadata tree across both stores.

## Alternatives checked

| Alternative                                            | Why not                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gradle Play Publisher (`com.github.triplet.play`)      | Keeps everything in Gradle. It is also a third-party plugin on the release build's classpath, and it uses its own metadata layout (a `play` directory in the app module source set), so the fastlane tree would be duplicated. Nothing for iOS. |
| Third-party upload actions (e.g. `upload-google-play`) | A third-party action would hold the service-account key, and its promotion and rollout support is partial.                                                                                                                                      |
| Hand-written Android Publisher API client (edits API)  | The edit, track and rollout semantics would be reimplemented and maintained here. No such client exists in `src/` or `scripts/`.                                                                                                                |
