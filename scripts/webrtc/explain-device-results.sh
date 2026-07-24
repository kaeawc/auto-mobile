#!/usr/bin/env bash
# Explain how to read the WebRTC device-capture artifacts, printed into the job
# log (and the run summary) by both device lanes (#4308).
#
# A green run still emits ERROR lines into chrome.log/mediamtx.log — STUN DNS
# failures, an SDP congestion-control warning, a pre-validation non-STUN packet,
# and the SCTP abort at teardown — that are expected under the localhost/offline
# CI environment and are NOT what the test gates on. This legend keeps a reader
# from mistaking that noise for a failure, and points at the fields in
# result.txt / stage-latency.json that actually decide pass/fail.

set -euo pipefail

platform="${1:-device}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
results_dir="${AUTOMOBILE_WEBRTC_RESULTS_DIR:-${repo_root}/scratch/webrtc-device-integration}"

# Echo to the job log, and mirror to the run-summary page when one is available
# (that is where a reader downloads the artifacts from).
emit() {
  printf '%s\n' "$*"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$*" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

render_legend() {
  # Heading carries the only interpolation; the body is a quoted heredoc so its
  # backticks and any future `$(...)` stay literal text rather than running as
  # command substitution in a script whose whole job is printing static prose.
  printf '## How to read the %s WebRTC device-capture results\n\n' "${platform}"
  cat <<'EOF'
This lane proves the full pipeline works:
`capture -> WHIP -> MediaMTX -> WHEP -> browser decode`. The artifacts uploaded
below (result.txt, stage-latency.json, chrome.log, mediamtx.log) record it.

### What decides pass/fail
The test passes when a real frame is decoded in the browser and keeps advancing,
then the stream tears down cleanly. Concretely, in result.txt / stage-latency.json:
- `outcome=passed` — the capture pipeline reached the browser.
- `missingStages` is empty — all six stages below were observed, in order.
- `captureToBrowser=<n>ms` is present — first browser-decoded frame was timed.
- `decodedSize` width/height > 0 and frames advanced across the sample window.

### The six stages (elapsed from startRequest; +delta from the previous stage)
- `startRequest`      the daemon was asked to start the stream (origin, 0ms).
- `whipConnected`     the device's WHIP publish PeerConnection came up.
- `sourceStarted`     the device began producing encoded frames.
- `firstEncodedFrame` MediaMTX saw the first H264 frame on the path.
- `whepConnected`     the browser's WHEP subscribe PeerConnection came up.
- `firstDecodedFrame` the browser decoded the first frame (== captureToBrowser).

### Lifecycle phases (reported separately from outcome, per #4354)
`[phase] ... ok|failed|timedOut` lines (e.g. pipelineTeardown, fixtureRestore)
time bounded cleanup. A phase can fail or time out WITHOUT recolouring `outcome`:
outcome describes the capture pipeline, a phase describes teardown/restore. Read
both — an `ok` pipeline with a `timedOut` teardown is a real (separate) signal.

### Throughput metrics (measured at the browser, #4349)
- `egress=<n>kbps`   mean inbound-RTP bitrate the reader actually received.
- `decodedFps=<n>`   frames/s the runner sustained, vs the configured `fps=`.
These characterize the pipeline; they are diagnostic, not the pass gate. Source
vs decoded resolution differ by design (device portrait framing + the
resolution-aware bitrate cap, #4371) — that is not an error.

### ERROR lines that are EXPECTED here (green runs still print these)
chrome.log runs Chrome fully offline on a private/localhost network, so:
- "Failed to resolve address for stun.l.google.com., errorcode: -105" — no
  public DNS on the runner. Harmless: ICE succeeds on host candidates because
  every peer is on 127.0.0.1 / the local private net; no STUN reflexive
  candidate is needed.
- "Inconsistent congestion control feedback types, ignoring all." — a cosmetic
  SDP negotiation warning that Chromium logs at ERROR severity (note the literal
  "Warning:" prefix). WebRTC just ignores CC feedback and proceeds.
- "Received non-STUN packet from unknown address: ..." — RTP arrived a beat
  before ICE promoted that peer to a validated candidate. A normal startup race;
  the candidate validates moments later and media flows.
- "DcSctpTransport...OnAborted(...User-Initiated Abort...)" — the peer closing
  the data channel at end of test. This IS the deliberate teardown, matching
  MediaMTX's "closed: terminated" / "peer connection closed".

### When a run really failed
Look for `outcome=failed`, a non-empty `missingStages=...` (which stage was
never reached localizes the break), a `[phase] ... failed|timedOut` line, or an
absent `captureToBrowser`. The benign lines above do NOT indicate any of these.
EOF
}

emit "$(render_legend)"

# When the run produced a summary, echo the real numbers right under the legend
# so the log has both the interpretation and the data.
if [[ -f "${results_dir}/result.txt" ]]; then
  emit ""
  emit "### This run's result.txt"
  emit '```'
  emit "$(cat "${results_dir}/result.txt")"
  emit '```'
else
  emit ""
  emit "(No result.txt at ${results_dir} — the run did not get far enough to write one.)"
fi
