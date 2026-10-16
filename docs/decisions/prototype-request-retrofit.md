# Retrofit for prototype `request` actions on the device

Status: accepted for #12528.

Dependency: `com.squareup.retrofit2:retrofit`

## Decision

The Android runtime for the prototype `request` action (`via: "device"`) uses Retrofit 3.0.0 over
the OkHttp the version catalog already pins (5.5.0, a direct dependency of `control-proxy`).
One interface, `PrototypeHttpService`, declares a dynamic endpoint per HTTP method
(`@Url`, `@HeaderMap`, raw `@Body RequestBody`, `@Streaming` raw `ResponseBody`), so a request needs
no per-endpoint code. No converter artifact is added: requests and responses stay raw and JSON goes
through kotlinx.serialization, which is already a direct dependency.

`okhttp3:mockwebserver3` (the same OkHttp version) is added as a **test** dependency so the service
runs against a real server, for the dynamic URL, headers, bodies, the size cap and the timeout.

## Alternatives checked

| Alternative | Why not |
| --- | --- |
| `java.net.HttpURLConnection` / `java.net.http.HttpClient` | In the JDK/Android platform, but there is no coroutine cancellation, no redirect-policy or timeout composition, and `java.net.http` does not exist on Android. The repo would hand-roll what OkHttp already gives. |
| OkHttp alone | Already a direct dependency and still does the transport here. The issue asks for a typed Retrofit client behind `PrototypeHttpClient`; Retrofit adds suspend functions with call cancellation and annotation-declared methods for ~130 KB, with no new transitive libraries beyond OkHttp. |
| Ktor client | A dependency of the test source set only (`ktor.client.*`); the server-side Ktor in `control-proxy` is not a client. Adding the client engine to the app would be a second HTTP stack next to OkHttp. |
| An existing repository helper | `src/` and `scripts/lib/` are TypeScript; there is no Kotlin HTTP helper in `android/`. |

## Consequences

- Retrofit 3.0.0 declares OkHttp 4.12.0; Gradle resolves the catalog's 5.5.0 (binary compatible for
  the calls Retrofit makes), so there is a single OkHttp on the class path.
- Retrofit ships its own R8 consumer rules (`META-INF/proguard/retrofit2.pro`). `control-proxy`
  additionally keeps `PrototypeHttpService`, which is reached only through Retrofit's proxy.
- No npm dependency changes: `scripts/release/runtime-graph.json` pins the published npm package's
  runtime graph (`jimp`, `sharp`) and does not cover Gradle artifacts.
- Cleartext HTTP to any host is permitted for CtrlProxy (a `network_security_config` with
  `cleartextTrafficPermitted="true"`): prototype backends are commonly plain-HTTP dev servers, and
  CtrlProxy is sideloaded over adb and never distributed. There is no host allowlist.
