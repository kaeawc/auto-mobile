# Build source revision

A navigation build is identified by `(appId, versionCode, contentHash)`. That key
is hard to map back to source, so an app may also declare the git branch and
commit it was built from. The revision is display metadata: it never takes part
in build-key identity, matching, filtering or diffing.

## Declaration

The app declares two string values under the same names on both platforms:

| Key                                           | Value                           |
| --------------------------------------------- | ------------------------------- |
| `dev.jasonpearson.automobile.build.gitBranch` | Branch name, 1–255 characters   |
| `dev.jasonpearson.automobile.build.gitSha`    | Commit sha, 7–64 hex characters |

- Android: `<meta-data>` in the app manifest. CtrlProxy reads
  `applicationInfo.metaData` (`GET_META_DATA`) while answering
  `request_package_info` and returns the raw strings as the optional
  `gitBranch` / `gitSha` fields of `package_info_result`. A value Android typed
  as a number is not a string declaration and is not returned.
- iOS simulator: keys in the bundle's `Info.plist`. The daemon reads the
  installed bundle's `Info.plist` on the host while resolving the build context.
  Physical iOS devices resolve no build key, so they record no revision either.

No SDK runtime API is involved; the keys work whether or not the SDK is linked.

## Validation

The daemon accepts a revision only when both values are present: the branch is
trimmed, non-empty, at most 255 characters and free of control characters; the
sha is trimmed, lower-cased and 7–64 hex characters. Anything else is treated as
no declaration, and the build keeps its plain build key. Resolution never fails
or retries because of a revision.

## Recording

The resolved build context carries the optional revision. Each navigation write
upserts the build-key row with it into the nullable `git_branch` / `git_sha`
columns of `navigation_build_keys`; the unique `(app_id, version_code,
content_hash)` index is unchanged. The latest declaration wins, so a same-key
rebuild from a later commit relabels the build. A write without a revision (an
old build, an unreadable manifest) never clears a recorded one. Rows written
before the columns existed stay null.

## Wire and display

Each provenance record on the `automobile:navigation/graph` resource adds an
optional `sourceRevision: { gitBranch, gitSha }`, omitted when the build has
none. Every record of one build carries the same value because it comes from the
build-key row.

The desktop build lens labels a build `branch@shortsha` (the first 7 sha
characters) when its records carry a revision, and `v<versionCode> (<hash
prefix>)` otherwise. Filter chips, compare pickers, the compare header and the
filtered node descriptions all use that label.
