# Attestation GitHub App transport

## Purpose and trust boundary

This implements the transport boundary for #11981 in epic #11972 (milestone
"Pre-push Attestation CI"). The remote service owns policy and attestation truth
in Neon. This client does not access a database or validate signed envelopes.
GitHub authenticates the caller and displays informational checks; nothing stored
on GitHub is authoritative evidence for skipping work.

Always ask the service for a fresh decision. Apply `combineDecisions` only after
obtaining that authoritative decision. Optional GitHub-side cached state can only
downgrade it: `ignore > advisory > skip`. Equal severity keeps the service's
reason. Missing or invalid cached state is ignored. Never use a cached result as
the authoritative argument. Every transport failure yields `ignore`, meaning run
the job for real. An `advisory` decision also does not authorize a skip; only a
fully validated service `skip` does. The attestation check run is informational
only: it must never be configured as a required status check or used as a merge
gate input. The actual CI caller enforces the returned decision.

## Create and install the App

1. In the owning GitHub account's **Settings → Developer settings → GitHub Apps**,
   select **New GitHub App**. Supply a recognizable name and homepage URL.
   No user authorization callback is needed for this installation-token flow.
2. Disable **Active** under webhooks. No webhook, webhook secret, events, user
   tokens, or OAuth client secret is needed.
3. Set exactly these repository permissions:

   | Permission | Access                                         |
   | ---------- | ---------------------------------------------- |
   | Checks     | Read and write                                 |
   | Metadata   | Read-only (GitHub's mandatory metadata access) |

   Leave all other permissions at **No access**, including Contents, Actions,
   Pull requests, and Secrets. Do not grant organization or account permissions.

4. Create the App, note its numeric App ID, and generate an RSA private key.
   Keep that PEM in the trusted secret store. Do not commit it or print it.
5. Install the App using **Only select repositories**, selecting
   **kaeawc/auto-mobile only**. Record the numeric installation ID if desired.
   If omitted, the client resolves it with the repository installation endpoint.

See GitHub's [App registration guide](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app)
and [installation token guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## CI configuration and secrets

Add these GitHub Actions secrets with these exact names, then map them into the
trusted attestation-gate job's environment. This change adds no workflow wiring.

| Secret / environment variable            | Requirement                                                       |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `AUTOMOBILE_ATTESTATION_APP_ID`          | Required positive numeric App ID                                  |
| `AUTOMOBILE_ATTESTATION_APP_PRIVATE_KEY` | Required PEM; literal `\n` escapes are accepted                   |
| `AUTOMOBILE_ATTESTATION_INSTALLATION_ID` | Optional positive numeric installation ID                         |
| `AUTOMOBILE_ATTESTATION_SERVICE_URL`     | Required HTTPS service base URL, optionally including a base path |
| `GITHUB_API_URL`                         | Optional HTTPS API base URL; defaults to `https://api.github.com` |

Only expose the private key to the trusted **attestation-gate** job. Never expose
it to PR-from-fork workflows or execute untrusted PR code in a job that has it.
Missing or invalid configuration disables this path: the caller must produce
`{ kind: "ignore", reason: "unauthenticated" }` and run real work. Configuration
errors list setting names only. Config `toString`, `toJSON`, and Node inspection
redact the PEM, which is also kept out of enumerable properties.

`AUTOMOBILE_ATTESTATION_ALLOW_INSECURE_LOCALHOST=1` is a **local test-only**
environment switch, not a deployed Actions secret. It permits HTTP only for
`localhost`, `127.0.0.1`, or `[::1]` on the service endpoint. Never set it in CI.
GitHub API URLs always require HTTPS. `GITHUB_API_URL` is trusted configuration
set by the runner, including for GitHub Enterprise Server. The App JWT is sent
to that API URL for installation lookup and token issuance; never take it from
untrusted PR input. Both base URLs reject embedded credentials,
query strings, and fragments. Credentials appear only in authorization headers,
never URL queries. Runtime callers should use the validated config loader rather
than construct unchecked configuration objects.

## Token lifetime and scoping

The injected clock supplies wall time. An RS256 App JWT has `iat = now - 60s`,
`exp = now + 540s`, and `iss = appId`. The JWT is used only for installation
lookup and token issuance. `getInstallationToken(owner, repo, purpose)` issues
two separately scoped tokens, both restricted by `repositories: [repo]`:

- `service` requests only `permissions: { metadata: "read" }`, and is sent to
  the external service for uploads and decisions.
- `checks` requests `permissions: { metadata: "read", checks: "write" }`, and
  is sent only to GitHub for informational check reporting.

Concurrent calls for the same owner, repository, and purpose share one in-flight
acquisition; tokens are never shared across owners, repositories, or purposes.
Tokens stay in process memory only, refreshing five minutes before `expires_at`. Failed
requests are not cached and an expired entry is never used as fallback.
GitHub installation tokens normally expire after one hour; the client honors
the expiry returned by GitHub. Rotate/revoke the App key through GitHub if needed.

The native fetch adapter rejects redirects, including same-host redirects.
The reused `FetchLike` type has no `redirect` field, so injected fetch adapters
must themselves reject redirects; the narrow interface cannot enforce that
behavior. No shared fetch type was changed. Responses are capped at 64 KiB
before JSON parsing, using both declared length and UTF-8 byte length. The native
adapter counts bytes while reading the body stream and cancels it immediately
when the cap is exceeded. Injected `FetchLike` adapters expose only `text()`: a
declared oversize length is rejected before reading, but an absent or inaccurate
length can still allocate an oversize body before the post-read check. The
deadline bounds both native and injected reads.

Each HTTP exchange has a ten-second deadline including its body read, driven by
an injected Timer and abort signal. Authentication's transient network, 429, or
5xx failure gets exactly one retry with the repository Backoff seam (100ms by
default, capped at 1000ms). Timeout, authentication, and malformed-response
failures are not retried. Service operations and check reporting are not retried.
Service and reporter callers also bound token acquisition to ten seconds.

## CI flow and endpoints

1. Load configuration; on failure run real work. Construct the token provider
   with an injected `Clock`, and the service client with owner/repository identity.
   Time, signing, network, backoff, and timers have injectable test seams.
2. Producers call `AttestationUploader.upload({ inputHash, tier, envelope })`.
   `NoopAttestationUploader` is the local default and returns
   `{ ok: false, reason: "uploads-disabled" }`. Envelopes remain opaque JSON here.
3. CI calls `decide({ owner, repo, sha, tier, inputHash })`. The service verifies
   the bearer installation token against GitHub, checks repository scope, then
   evaluates its Neon records and policy. An upload acknowledgment never grants
   a skip. This module does not implement the service or its authorization policy.
4. Optionally combine the fresh decision with cached state, then run work unless
   the result is `skip`. Report that final decision with `PrDecisionReporter`.
   It creates `attestation / tier-N`, success for skip and neutral otherwise, with
   a human sentence explaining every reason. Reporting errors are warned and
   swallowed without changing the decision. Checks must not be consulted for grants.

| Endpoint                                                 | Authentication            | Request / successful response                                                               |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `GET GITHUB_API_URL/repos/OWNER/REPO/installation`       | App JWT                   | Used only without configured installation ID; response `{ id: number }`                     |
| `POST GITHUB_API_URL/app/installations/ID/access_tokens` | App JWT                   | Restricted permissions/repositories above; response `{ token: string, expires_at: string }` |
| `PUT BASE/v1/attestations/INPUTHASH`                     | Installation bearer token | `{ tier, envelope }`; acknowledgment `{ ok: true, id?: string }`                            |
| `POST BASE/v1/decisions`                                 | Installation bearer token | `{ owner, repo, sha, tier, inputHash }`; response `{ kind, reason, detail?: string }`       |
| `POST GITHUB_API_URL/repos/OWNER/REPO/check-runs`        | Installation bearer token | Completed informational check run                                                           |

`inputHash` must be exactly 64 lowercase hexadecimal characters and is checked
before token acquisition or fetch. Decision kinds are `skip`, `advisory`, and
`ignore`. Reasons are `verified-match`, `no-attestation`, `hash-mismatch`, `stale`,
`env-mismatch`, `policy-tier`, `transport-unavailable`, `invalid-response`, and
`unauthenticated`. A `skip` is valid only with `verified-match`. An `advisory`
accepts only `policy-tier`, `verified-match`, `stale`, `env-mismatch`,
`hash-mismatch`, or `no-attestation`. An `ignore` accepts any listed reason;
`transport-unavailable`, `invalid-response`, and `unauthenticated` are valid only
with `ignore`. Unknown values, invalid pairs, and non-string details are rejected.
Optional free-form details and upload IDs are deliberately omitted from client results, and reports use
only fixed human reason text, preventing arbitrary service text from echoing
credentials. Provider and service-client inspection and JSON serialization reveal
only the class name; credential-bearing state uses ES private fields. Error text,
exception causes, and response bodies are never logged. Reporter input must have
a valid decision, a safe-integer tier from 1 through 3, and a 40- or 64-character
lowercase hexadecimal commit SHA; invalid input warns with fixed text and sends
nothing, including no token request.

## Failure matrix

| Failure                                                                                           | Decision / behavior                                                                                 |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Missing/invalid credentials or signing failure                                                    | `ignore / unauthenticated`                                                                          |
| Service or GitHub HTTP 401/403                                                                    | `ignore / unauthenticated`                                                                          |
| Network error, timeout, non-2xx, rejected redirect, exhausted auth retry                          | `ignore / transport-unavailable`                                                                    |
| Invalid hash, oversize body, bad JSON, malformed token/installation/decision, unknown kind/reason | `ignore / invalid-response`                                                                         |
| Upload failure                                                                                    | `{ ok: false, reason }`; never grants anything; decision still requires a service call              |
| Check reporting failure                                                                           | Warn and swallow; preserve existing decision, which remains `ignore` if decision acquisition failed |
| Cached skip while service returns ignore                                                          | `ignore`; cached state cannot grant a skip                                                          |

Every decision-acquisition failure means **ignore and run the job for real**.

## Acceptance check

**Delete all GitHub-side state does not change any decision.** Delete check runs
and cached attestation evidence, then make the same fresh service request with
unchanged Neon records and policy: it returns the same authoritative decision.
This criterion concerns evidence/check/cache state, not deleting the App or its
installation credentials (which fails closed to ignore). Optional cached
downgrades may force more work while present, but deleting them cannot create a
service grant. Test the full 3×3 downgrade matrix and absent/invalid cache cases.
Use only fakes, a fixed clock, and FakeTimer for unit verification; no network,
devices, database, webhook, or GitHub-state read is required.
