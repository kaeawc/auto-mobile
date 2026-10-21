/**
 * Real process starts captured by the driver on Darwin 25.6.0 / macOS 26.6.2
 * via sysctl kern.proc.pid and `LC_ALL=C TZ=UTC ps -A -o pid=,lstart=`.
 * The head bytes and ps text are verbatim, including single-digit day padding.
 */
export const DARWIN_SYSCTL_START_FIXTURES = {
  capturedOn: "darwin 25.6.0",
  samples: [
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "9260bd6a000000000709000000000000",
      startSeconds: 1790795922,
      psLstartUtc: "Wed Sep 30 19:18:42 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "a50fbe6a00000000737d090000000000",
      startSeconds: 1790840741,
      psLstartUtc: "Thu Oct  1 07:45:41 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "facdc66a000000003dc8060000000000",
      startSeconds: 1791413754,
      psLstartUtc: "Wed Oct  7 22:55:54 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "3decca6a0000000091fc030000000000",
      startSeconds: 1791683645,
      psLstartUtc: "Sun Oct 11 01:54:05 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "06afce6a000000009716050000000000",
      startSeconds: 1791930118,
      psLstartUtc: "Tue Oct 13 22:21:58 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "d95fcf6a000000003a71000000000000",
      startSeconds: 1791975385,
      psLstartUtc: "Wed Oct 14 10:56:25 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "cb5ac86a000000006406070000000000",
      startSeconds: 1791515339,
      psLstartUtc: "Fri Oct  9 03:08:59 2026",
    },
    {
      kinfoProcLength: 648,
      kinfoProcHead16Hex: "0208c56a000000004bf1010000000000",
      startSeconds: 1791297538,
      psLstartUtc: "Tue Oct  6 14:38:58 2026",
    },
  ],
} as const;
