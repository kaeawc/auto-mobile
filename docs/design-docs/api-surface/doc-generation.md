# SDK API Documentation Generation

How to generate and publish API reference docs for AutoMobile's mobile SDKs.

## Android (Dokka)

The Android SDK uses [Dokka](https://github.com/Kotlin/dokka) to generate HTML API docs from KDoc comments.

### Prerequisites

- JDK 17+ (same as the Android build)
- No additional installation required; the Dokka Gradle plugin is already applied.

### Generate docs

```bash
scripts/android/generate-dokka.sh
```

Or directly via Gradle:

```bash
cd android && ./gradlew :auto-mobile-sdk:dokkaGeneratePublicationHtml
```

Output: `android/auto-mobile-sdk/build/dokka/html/`

### Copy to a custom directory

```bash
scripts/android/generate-dokka.sh --output-dir docs/site/android-api
```

## iOS (DocC) -- Future

Swift packages support DocC for API documentation generation. When the iOS SDK's public API surface is finalized:

1. Add DocC catalog to each Swift target under `Sources/<Target>/Documentation.docc/`.
2. Generate with `swift package generate-documentation --target <Target>`.
3. Export static HTML with `swift package generate-documentation --target <Target> --output-path docs/site/ios-api --transform-for-static-hosting`.

## GitHub Pages Integration

The project uses MkDocs for its documentation site. To include generated SDK docs:

1. Generate platform docs into subdirectories of `docs/site/`:
   - `docs/site/android-api/` for Dokka output
   - `docs/site/ios-api/` for DocC output (future)
2. Link to these from the MkDocs nav in `mkdocs.yml`.
3. In CI, run generation scripts before `mkdocs build` so the generated HTML is included in the deployed site.

### CI workflow sketch

```yaml
- name: Generate Android API docs
  run: scripts/android/generate-dokka.sh --output-dir docs/site/android-api

# Future:
# - name: Generate iOS API docs
#   run: scripts/ios/generate-docc.sh --output-dir docs/site/ios-api

- name: Build MkDocs site
  run: mkdocs build
```
