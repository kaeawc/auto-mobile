# Session broker remote devices

How AutoMobile rents a real Android device from Android Device Streaming (#14054)
and turns it into an adb device. Remote minutes are billed to the caller's Google
Cloud project, so every step is built to fail closed and never leave a session
running.

## Layers

- **Provider** (`RemoteDeviceProvider`): reserves, extends and releases a
  session through the Device Streaming REST API. Requests are refused without an
  explicit opt-in and above the per-session minute cap, extensions included.
- **Configuration** (`createDeviceStreamingProvider`): opt-in, Google Cloud
  project id and `maxSessionMinutes` (30 when unset). Invalid configuration builds
  nothing.
- **Acquisition** (`RemoteDeviceAcquisition`): reserve, connect adb through a
  `RemoteAdbTransport`, reinstall and enable CtrlProxy, read the device identity
  (manufacturer, brand, model). It reports cost and whole minutes remaining for
  tool responses.

The transport is the `DirectAccessService.AdbConnect` bridge (#14464). Until it
lands, acquisition is not reachable from any tool or from the broker.

## Token source

The access token comes from `gcloud auth print-access-token`, run through the
host command seam; it carries the `cloud-platform` scope for user credentials, and
gcloud keeps credential storage and refresh. A token is reused for 45 minutes
(gcloud issues one-hour tokens), and concurrent callers share one gcloud run. A
failed run is not cached.

## Invariants

- A failure after reservation (adb connect, CtrlProxy install) closes adb and
  releases the session before the error surfaces. If that release also fails, the
  error names the session and says to cancel it in the Google Cloud console.
- A failed identity read leaves the identity null; the device stays usable.
- A remote serial is a loopback port that a later session can reuse for a
  different device. Each connect drops the serial's cached CtrlProxy state and
  reads traits with an uncached reader.
- A session is held from reservation until the provider confirms release.
  `releaseAll` (session end, daemon shutdown) first cancels and drains
  acquisitions still in progress, so none can return a live session afterwards,
  then retries every held session and returns the ids it still could not release.

## Background

- [Device Streaming tokens come from gcloud](../devlog/2026-11-03-session-broker-remote-devices-gcloud-token.md)
