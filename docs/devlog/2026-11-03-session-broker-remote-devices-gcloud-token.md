# Device Streaming tokens come from gcloud

- Kind: decision
- Date: 2026-11-03
- Source: moved from `how-it-works/session-broker-remote-devices.md`; #14054, #14468, #16555
- Shaped: [Session broker remote devices](../how-it-works/session-broker-remote-devices.md)

## Context

Renting a device from Android Device Streaming needs a Google Cloud access token with the
`cloud-platform` scope.

## Options

- `gcloud auth print-access-token` through the host command seam.
- Application Default Credentials.

## Decision

Use `gcloud auth print-access-token`.

## Consequences

- No new dependency; credential storage and refresh stay in gcloud.
- Application Default Credentials would have needed a Google auth library or a hand-written OAuth
  refresh, while `gcloud` is already required to enable the API and billing.
