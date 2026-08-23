import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  APK_SHA256_CHECKSUM,
  APK_URL,
  AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV,
  DAEMON_PACKAGE_NAME,
  DEFAULT_ASSET_BASE_URL,
  assertHttpsAssetUrl,
  IOS_CTRL_PROXY_IPA_URL,
  IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM,
  IOS_CTRL_PROXY_SHA256_CHECKSUM,
  NIGHTLY_CHECKSUM_ENTRY,
  RELEASE_CHECKSUM_REGISTRY,
  isExplicitPin,
  isPinnedVersionKnown,
  resolveApkChecksum,
  resolveApkUrl,
  resolveAssetBaseUrl,
  resolveAssetVersion,
  resolveChecksum,
  resolveDaemonInstallSpecifier,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolveLatestVersion,
  resolvePinnedVersion,
  resolveRunnerChecksum,
  resolveRunnerChecksumTarget,
  resolveScreenCaptureHelperChecksum,
  resolveScreenCaptureHelperUrl,
  resolveVideoJarChecksum,
  resolveVideoJarUrl,
  SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME,
  VIDEO_SERVER_JAR_FILENAME,
  type ReleaseChecksumEntry,
} from "../../src/constants/release";

describe("resolveChecksum", function () {
  test("latest resolves to registry[0] (newest entry)", function () {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("latest", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum("latest", "ios")).toBe(newest.ipaSha256);
  });

  test("latest is case-insensitive and trims whitespace", function () {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("LATEST", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum(" latest ", "ios")).toBe(newest.ipaSha256);
  });

  test("pinned 0.0.18 resolves to its specific checksums", function () {
    expect(resolveChecksum("0.0.18", "android")).toBe(
      "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
    );
    expect(resolveChecksum("0.0.18", "ios")).toBe(
      "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
    );
  });

  test("pinned 0.0.17 resolves to its specific checksums, not latest", function () {
    expect(resolveChecksum("0.0.17", "android")).toBe(
      "916033440931666644474f227c8e39d13d9c80c3515e4292cc5581fd5bd4cc2f",
    );
    expect(resolveChecksum("0.0.17", "ios")).toBe(
      "e4dcf064d024f2371b8fd79281000e2d49751ef95b8817d1494d685aeda746ac",
    );
  });

  test("latest and pinned 0.0.17 return different checksums", function () {
    expect(resolveChecksum("latest", "android")).not.toBe(resolveChecksum("0.0.17", "android"));
    expect(resolveChecksum("latest", "ios")).not.toBe(resolveChecksum("0.0.17", "ios"));
  });

  test("pinned version not in registry returns empty string", function () {
    expect(resolveChecksum("99.99.99", "android")).toBe("");
    expect(resolveChecksum("99.99.99", "ios")).toBe("");
  });

  test("empty version returns empty string", function () {
    expect(resolveChecksum("", "android")).toBe("");
  });

  test("empty registry returns empty string", function () {
    const empty: ReleaseChecksumEntry[] = [];
    expect(resolveChecksum("latest", "android", empty)).toBe("");
    expect(resolveChecksum("0.0.18", "ios", empty)).toBe("");
  });

  test("multi-entry registry resolves each version independently", function () {
    const registry: ReleaseChecksumEntry[] = [
      { version: "0.0.20", apkSha256: "apk20", ipaSha256: "ipa20", runnerSha256: "runner20" },
      { version: "0.0.19", apkSha256: "apk19", ipaSha256: "ipa19", runnerSha256: "runner19" },
      { version: "0.0.18", apkSha256: "apk18", ipaSha256: "ipa18", runnerSha256: "runner18" },
    ];
    expect(resolveChecksum("latest", "android", registry)).toBe("apk20");
    expect(resolveChecksum("0.0.19", "android", registry)).toBe("apk19");
    expect(resolveChecksum("0.0.18", "ios", registry)).toBe("ipa18");
    expect(resolveChecksum("0.0.17", "android", registry)).toBe("");
  });
});

describe("resolveLatestVersion", function () {
  test("returns first registry entry version", function () {
    expect(resolveLatestVersion()).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("resolveAssetVersion", function () {
  test("passes through concrete versions unchanged", function () {
    expect(resolveAssetVersion("0.0.18")).toBe("0.0.18");
  });

  test("resolves the 'latest' placeholder to the newest registry entry", function () {
    expect(resolveAssetVersion("latest")).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("module-level URL and checksum exports", function () {
  // Guards against the pre-existing drift between APK_URL (was keyed off
  // resolveLatestVersion()) and APK_SHA256_CHECKSUM (was keyed off the
  // "latest" literal). Both must resolve via the same RELEASE_VERSION path.
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("APK_URL and IPA_URL reference the newest registered version", function () {
    expect(APK_URL).toContain(`/releases/download/${newest.version}/control-proxy-debug.apk`);
    expect(IOS_CTRL_PROXY_IPA_URL).toContain(
      `/releases/download/${newest.version}/control-proxy.ipa`,
    );
  });

  test("APK and IPA checksums match the newest registered entry", function () {
    expect(APK_SHA256_CHECKSUM).toBe(newest.apkSha256);
    expect(IOS_CTRL_PROXY_SHA256_CHECKSUM).toBe(newest.ipaSha256);
  });

  test("iOS runner checksum matches the newest registered entry", function () {
    expect(IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM).toBe(newest.runnerSha256);
  });

  test("malformed mirror config does not prevent importing release constants (#3491)", async function () {
    const prevBaseUrl = process.env.AUTOMOBILE_ASSET_BASE_URL;
    process.env.AUTOMOBILE_ASSET_BASE_URL = "https://mirror.test/am?";
    try {
      const module = await import(
        `../../src/constants/release.ts?malformed-mirror-import-${Date.now()}`
      );

      expect(module.RELEASE_VERSION).toBe("latest");
      expect(module.APK_URL).toContain("/releases/download/");
    } finally {
      if (prevBaseUrl === undefined) {
        delete process.env.AUTOMOBILE_ASSET_BASE_URL;
      } else {
        process.env.AUTOMOBILE_ASSET_BASE_URL = prevBaseUrl;
      }
    }
  });
});

// --- Issue #2746: hermetic single-version pinning knobs ---

describe("resolvePinnedVersion (AUTOMOBILE_VERSION single knob)", function () {
  test("returns 'latest' when AUTOMOBILE_VERSION is unset", function () {
    expect(resolvePinnedVersion({})).toBe("latest");
  });

  test("returns 'latest' when AUTOMOBILE_VERSION is blank", function () {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "   " })).toBe("latest");
  });

  test("returns the pinned version trimmed", function () {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: " 0.0.18 " })).toBe("0.0.18");
  });
});

describe("resolveAssetBaseUrl (AUTOMOBILE_ASSET_BASE_URL mirror knob)", function () {
  test("defaults to the GitHub releases base when unset", function () {
    expect(resolveAssetBaseUrl({})).toBe(DEFAULT_ASSET_BASE_URL);
    expect(DEFAULT_ASSET_BASE_URL).toContain("github.com/kaeawc/auto-mobile/releases/download");
  });

  test("uses the mirror base when set, stripping trailing slashes", function () {
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/" })).toBe(
      "https://mirror.test/am",
    );
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am///" })).toBe(
      "https://mirror.test/am",
    );
  });

  test("normalizes parser-accepted mirror bases before URL composition", function () {
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https:mirror.test/am/" })).toBe(
      "https://mirror.test/am",
    );
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test\\am" })).toBe(
      "https://mirror.test/am",
    );
  });

  test("ignores a blank mirror base", function () {
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "  " })).toBe(DEFAULT_ASSET_BASE_URL);
  });

  test("rejects mirror bases with query strings", function () {
    expect(() =>
      resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am?token=abc" }),
    ).toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
  });

  test("rejects mirror bases with fragments", function () {
    expect(() =>
      resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am#release" }),
    ).toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
  });

  test("rejects mirror bases with empty query or fragment delimiters", function () {
    expect(() =>
      resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am?" }),
    ).toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
    expect(() =>
      resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am#" }),
    ).toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
  });

  test("rejects non-absolute mirror bases", function () {
    expect(() => resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "/mirror/am" })).toThrow(
      "AUTOMOBILE_ASSET_BASE_URL must be an absolute URL",
    );
  });

  test("rejects a plaintext http:// mirror base by default (#4761)", function () {
    expect(() =>
      resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "http://mirror.test/am" }),
    ).toThrow("AUTOMOBILE_ASSET_BASE_URL must use https://");
  });

  test("allows a plaintext http:// mirror base when the opt-out is set (#4761)", function () {
    expect(
      resolveAssetBaseUrl({
        AUTOMOBILE_ASSET_BASE_URL: "http://127.0.0.1:8080/am/",
        [AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV]: "1",
      }),
    ).toBe("http://127.0.0.1:8080/am");
  });
});

describe("assertHttpsAssetUrl (#4761 https enforcement)", function () {
  test("accepts an https:// URL", function () {
    expect(() =>
      assertHttpsAssetUrl("https://mirror.test/am/control-proxy.ipa", "LABEL", {}),
    ).not.toThrow();
  });

  test("rejects an http:// URL by default", function () {
    expect(() =>
      assertHttpsAssetUrl("http://mirror.test/am/control-proxy.ipa", "LABEL", {}),
    ).toThrow("LABEL must use https://");
  });

  test("rejects a non-http(s) scheme by default", function () {
    expect(() =>
      assertHttpsAssetUrl("ftp://mirror.test/am/control-proxy.ipa", "LABEL", {}),
    ).toThrow("LABEL must use https://");
  });

  test("permits http:// under the AUTOMOBILE_ALLOW_INSECURE_ASSET_URL opt-out", function () {
    expect(() =>
      assertHttpsAssetUrl("http://localhost:8080/control-proxy.ipa", "LABEL", {
        [AUTOMOBILE_ALLOW_INSECURE_ASSET_URL_ENV]: "true",
      }),
    ).not.toThrow();
  });

  test("rejects a non-absolute URL", function () {
    expect(() => assertHttpsAssetUrl("/relative/path", "LABEL", {})).toThrow(
      "LABEL must be an absolute URL",
    );
  });
});

describe("resolveApkUrl / resolveIpaUrl (EC1, EC2, EC3)", function () {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("EC8: unset env resolves to the concrete latest version on the default host", function () {
    expect(resolveApkUrl({})).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy-debug.apk`,
    );
    expect(resolveIpaUrl({})).toBe(`${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy.ipa`);
  });

  test("EC1: AUTOMOBILE_VERSION pins the URL version", function () {
    expect(resolveApkUrl({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.18/control-proxy-debug.apk`,
    );
    expect(resolveIpaUrl({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.18/control-proxy.ipa`,
    );
  });

  test("EC2: AUTOMOBILE_ASSET_BASE_URL mirrors the download host", function () {
    expect(resolveApkUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" })).toBe(
      `https://mirror.test/am/${newest.version}/control-proxy-debug.apk`,
    );
  });

  test("EC3: both knobs compose", function () {
    expect(
      resolveApkUrl({
        AUTOMOBILE_VERSION: "0.0.18",
        AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/",
      }),
    ).toBe("https://mirror.test/am/0.0.18/control-proxy-debug.apk");
    expect(
      resolveIpaUrl({
        AUTOMOBILE_VERSION: "0.0.18",
        AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/",
      }),
    ).toBe("https://mirror.test/am/0.0.18/control-proxy.ipa");
  });
});

describe("resolveApkChecksum / resolveIpaChecksum (EC1, EC4)", function () {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("EC8: unset env resolves to the latest entry checksums", function () {
    expect(resolveApkChecksum({})).toBe(newest.apkSha256);
    expect(resolveIpaChecksum({})).toBe(newest.ipaSha256);
  });

  test("EC1: AUTOMOBILE_VERSION selects that version's checksums coherently", function () {
    expect(resolveApkChecksum({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834",
    );
    expect(resolveIpaChecksum({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39",
    );
  });

  test("EC4: an unknown pinned version yields an empty checksum", function () {
    expect(resolveApkChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
    expect(resolveIpaChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
  });
});

describe("resolveRunnerChecksum", function () {
  test("unset env resolves to the latest entry runner checksum", function () {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveRunnerChecksum({})).toBe(newest.runnerSha256);
  });

  test("AUTOMOBILE_VERSION selects that version's runner checksum", function () {
    const registry: ReleaseChecksumEntry[] = [
      {
        version: "0.0.20",
        apkSha256: "apk20",
        ipaSha256: "ipa20",
        runnerSha256: "runner20",
      },
      {
        version: "0.0.18",
        apkSha256: "apk18",
        ipaSha256: "ipa18",
        runnerSha256: "runner18",
      },
    ];

    expect(resolveRunnerChecksum({ AUTOMOBILE_VERSION: "0.0.18" }, registry)).toBe("runner18");
  });

  test("unknown pinned version yields an empty checksum", function () {
    expect(resolveRunnerChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
  });
});

describe("resolveRunnerChecksumTarget", function () {
  test("legacy entries without a target retain the outer XCTRunner checksum target", function () {
    expect(resolveRunnerChecksumTarget({ AUTOMOBILE_VERSION: "0.0.44" })).toBe("runner");
  });

  test("uses the target recorded by a newer release entry", function () {
    const registry: ReleaseChecksumEntry[] = [
      {
        version: "0.0.45",
        apkSha256: "apk45",
        ipaSha256: "ipa45",
        runnerSha256: "runner45",
        runnerSha256Target: "xctest",
      },
    ];

    expect(resolveRunnerChecksumTarget({}, registry)).toBe("xctest");
  });
});

describe("resolveVideoJarUrl (video-server jar delivery, #3830)", function () {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("unset env resolves to the concrete latest version on the default host", function () {
    expect(resolveVideoJarUrl({})).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/${VIDEO_SERVER_JAR_FILENAME}`,
    );
    expect(VIDEO_SERVER_JAR_FILENAME).toBe("automobile-video.jar");
  });

  test("AUTOMOBILE_VERSION pins the URL version", function () {
    expect(resolveVideoJarUrl({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.18/${VIDEO_SERVER_JAR_FILENAME}`,
    );
  });

  test("AUTOMOBILE_ASSET_BASE_URL mirrors the download host", function () {
    expect(resolveVideoJarUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" })).toBe(
      `https://mirror.test/am/${newest.version}/${VIDEO_SERVER_JAR_FILENAME}`,
    );
  });

  test("both knobs compose", function () {
    expect(
      resolveVideoJarUrl({
        AUTOMOBILE_VERSION: "0.0.18",
        AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/",
      }),
    ).toBe(`https://mirror.test/am/0.0.18/${VIDEO_SERVER_JAR_FILENAME}`);
  });

  test("empty registry + mirror falls back to a conventional /latest/ path", function () {
    expect(resolveVideoJarUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" }, [])).toBe(
      `https://mirror.test/am/latest/${VIDEO_SERVER_JAR_FILENAME}`,
    );
  });
});

describe("resolveVideoJarChecksum (video-server jar delivery, #3830)", function () {
  const registry: ReleaseChecksumEntry[] = [
    {
      version: "0.0.46",
      apkSha256: "apk46",
      ipaSha256: "ipa46",
      runnerSha256: "runner46",
      videoJarSha256: "jar46",
    },
    { version: "0.0.45", apkSha256: "apk45", ipaSha256: "ipa45", runnerSha256: "runner45" },
  ];

  test("latest/unset resolves to registry[0]'s videoJarSha256", function () {
    expect(resolveVideoJarChecksum({}, registry)).toBe("jar46");
  });

  test("AUTOMOBILE_VERSION selects that version's videoJarSha256", function () {
    expect(resolveVideoJarChecksum({ AUTOMOBILE_VERSION: "0.0.46" }, registry)).toBe("jar46");
  });

  test("an entry predating jar delivery (no videoJarSha256) resolves to empty", function () {
    expect(resolveVideoJarChecksum({ AUTOMOBILE_VERSION: "0.0.45" }, registry)).toBe("");
  });

  test("an unknown pinned version yields an empty checksum", function () {
    expect(resolveVideoJarChecksum({ AUTOMOBILE_VERSION: "99.99.99" }, registry)).toBe("");
  });

  test("empty registry yields an empty checksum", function () {
    expect(resolveVideoJarChecksum({}, [])).toBe("");
  });

  test("current committed registry tolerates an absent videoJarSha256 (empty until delivery)", function () {
    // The field is populated by the tooling in #3833; until then every entry
    // resolves to "" without throwing.
    expect(resolveVideoJarChecksum({})).toBe(RELEASE_CHECKSUM_REGISTRY[0].videoJarSha256 ?? "");
  });

  test("registry entries carry empty or well-formed 64-char videoJarSha256 values", function () {
    expect(RELEASE_CHECKSUM_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of RELEASE_CHECKSUM_REGISTRY) {
      const jar = entry.videoJarSha256 ?? "";
      expect(jar === "" || /^[a-f0-9]{64}$/.test(jar)).toBe(true);
    }
  });
});

describe("screen-capture-helper release delivery", function () {
  const registry: ReleaseChecksumEntry[] = [
    {
      version: "0.0.46",
      apkSha256: "apk46",
      ipaSha256: "ipa46",
      runnerSha256: "runner46",
      screenCaptureHelperSha256: "helper46",
    },
    { version: "0.0.45", apkSha256: "apk45", ipaSha256: "ipa45", runnerSha256: "runner45" },
  ];

  test("builds a version-pinned release URL", function () {
    expect(resolveScreenCaptureHelperUrl({}, registry)).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.46/${SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME}`,
    );
    expect(resolveScreenCaptureHelperUrl({ AUTOMOBILE_VERSION: "0.0.45" }, registry)).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.45/${SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME}`,
    );
  });

  test("resolves the matching helper checksum and leaves pre-delivery releases unverifiable", function () {
    expect(resolveScreenCaptureHelperChecksum({}, registry)).toBe("helper46");
    expect(resolveScreenCaptureHelperChecksum({ AUTOMOBILE_VERSION: "0.0.45" }, registry)).toBe("");
  });

  test("registry helper checksums are empty or SHA-256 values", function () {
    expect(RELEASE_CHECKSUM_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of RELEASE_CHECKSUM_REGISTRY) {
      const checksum = entry.screenCaptureHelperSha256 ?? "";
      expect(checksum === "" || /^[a-f0-9]{64}$/.test(checksum)).toBe(true);
    }
  });
});

describe("resolveDaemonInstallSpecifier (EC5)", function () {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("yields a concrete specifier, never @latest, when unset", function () {
    const spec = resolveDaemonInstallSpecifier({});
    expect(spec).toBe(`${DAEMON_PACKAGE_NAME}@${newest.version}`);
    expect(spec).not.toContain("@latest");
  });

  test("honors AUTOMOBILE_VERSION", function () {
    expect(resolveDaemonInstallSpecifier({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DAEMON_PACKAGE_NAME}@0.0.18`,
    );
  });
});

// --- Review feedback: mixed-case `latest` normalization (Priya) ---

describe("resolvePinnedVersion normalizes the 'latest' sentinel", function () {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("upper/mixed-case latest collapses to the canonical 'latest'", function () {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "LATEST" })).toBe("latest");
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: " Latest " })).toBe("latest");
  });

  test("mixed-case latest yields a coherent url + checksum + specifier (no /LATEST/ 404)", function () {
    const env = { AUTOMOBILE_VERSION: "LATEST" };
    expect(resolveApkUrl(env)).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy-debug.apk`,
    );
    expect(resolveIpaUrl(env)).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy.ipa`,
    );
    expect(resolveApkChecksum(env)).toBe(newest.apkSha256);
    expect(resolveDaemonInstallSpecifier(env)).toBe(`${DAEMON_PACKAGE_NAME}@${newest.version}`);
    // The bug: an un-normalized "LATEST" produced a real SHA but a .../LATEST/... URL.
    expect(resolveApkUrl(env)).not.toContain("/LATEST/");
  });

  test("a concrete version keeps its exact casing (registry keys are exact)", function () {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "0.0.18" })).toBe("0.0.18");
  });
});

// --- Review feedback: fail-closed predicates (Sofia) ---

describe("isExplicitPin", function () {
  test("false when unset or the latest sentinel (any case)", function () {
    expect(isExplicitPin({})).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "  " })).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "latest" })).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "LATEST" })).toBe(false);
  });

  test("true for a concrete pin, known or unknown", function () {
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(true);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "99.99.99" })).toBe(true);
  });
});

describe("isPinnedVersionKnown", function () {
  test("latest/unset is known iff the registry is non-empty", function () {
    expect(isPinnedVersionKnown({})).toBe(true);
    expect(isPinnedVersionKnown({}, [])).toBe(false);
  });

  test("a concrete pin is known iff it is in the registry", function () {
    expect(isPinnedVersionKnown({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(true);
    expect(isPinnedVersionKnown({ AUTOMOBILE_VERSION: "99.99.99" })).toBe(false);
  });
});

// --- Review feedback: degenerate empty-registry URL branch is now testable (Priya) ---

describe("resolveApkUrl / resolveIpaUrl with an injected registry", function () {
  const registry: ReleaseChecksumEntry[] = [
    { version: "0.0.20", apkSha256: "apk20", ipaSha256: "ipa20", runnerSha256: "runner20" },
  ];

  test("uses the injected registry's newest version", function () {
    expect(resolveApkUrl({}, registry)).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.20/control-proxy-debug.apk`,
    );
  });

  test("empty registry + default host falls back to GitHub's /latest/download redirect", function () {
    expect(resolveApkUrl({}, [])).toBe(
      "https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy-debug.apk",
    );
  });

  test("empty registry + mirror falls back to a conventional /latest/ path", function () {
    expect(resolveIpaUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" }, [])).toBe(
      "https://mirror.test/am/latest/control-proxy.ipa",
    );
  });
});

describe("package.json as canonical version source", function () {
  // The npm version (package.json) is the canonical release version. The
  // checksum registry's newest entry must name that same version, or "latest"
  // resolves assets for a version that npm never published. The release gate
  // (scripts/ci/verify-release-integrity.sh) enforces this across every
  // manifest at release time; this test enforces it in the checked-in source.
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as {
    version: string;
  };

  test("keeps a non-empty newest registry entry coherent with package.json", function () {
    expect(RELEASE_CHECKSUM_REGISTRY.length).toBeGreaterThan(0);
    expect(RELEASE_CHECKSUM_REGISTRY[0].version).toBe(pkg.version);
    expect(resolveLatestVersion()).toBe(pkg.version);
  });
});

describe("iOS runner-binary checksum", function () {
  test("registry entries carry empty or well-formed 64-char runner sha256 values", function () {
    expect(RELEASE_CHECKSUM_REGISTRY.length).toBeGreaterThan(0);
    for (const entry of RELEASE_CHECKSUM_REGISTRY) {
      expect(entry.runnerSha256 === "" || /^[a-f0-9]{64}$/.test(entry.runnerSha256)).toBe(true);
    }
  });

  test("module-level runner checksum export resolves from registry[0]", function () {
    expect(IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM).toBe(RELEASE_CHECKSUM_REGISTRY[0].runnerSha256);
  });

  test("the 0.0.44 entry is a coherent triple after the #3784 runner-sha repair", function () {
    // Addressed by version, not by index: the registry is prepended on every
    // release, so pinning [0] made each version bump red main (#4353) — and bumps
    // ship [skip ci], so nothing caught it until the next PR branched.
    const v0044 = RELEASE_CHECKSUM_REGISTRY.find((entry) => entry.version === "0.0.44");
    expect(v0044).toBeDefined();
    // The runner inside the published 0.0.44 IPA, not the orphaned nightly sha.
    expect(v0044?.runnerSha256).toBe(
      "b281f9fd516116164a76dc049a413d5123bfb7bf96c79c6ad654ba90c08ed982",
    );
    expect(v0044?.runnerSha256).not.toBe(NIGHTLY_CHECKSUM_ENTRY.runnerSha256);
  });
});

describe("NIGHTLY_CHECKSUM_ENTRY (dedicated mutable nightly slot)", function () {
  test("is the 'nightly' sentinel with a well-formed, populated triple", function () {
    expect(NIGHTLY_CHECKSUM_ENTRY.version).toBe("nightly");
    for (const sha of [
      NIGHTLY_CHECKSUM_ENTRY.apkSha256,
      NIGHTLY_CHECKSUM_ENTRY.ipaSha256,
      NIGHTLY_CHECKSUM_ENTRY.runnerSha256,
    ]) {
      expect(/^[a-f0-9]{64}$/.test(sha)).toBe(true);
    }
  });

  test("is kept OUT of the release registry so resolvers never see it", function () {
    // The whole point of the separate slot: nightly can overwrite it in place
    // without ever corrupting a tagged release entry (the #3784 failure mode).
    expect(RELEASE_CHECKSUM_REGISTRY.some((e) => e.version === "nightly")).toBe(false);
    expect(RELEASE_CHECKSUM_REGISTRY).not.toContain(NIGHTLY_CHECKSUM_ENTRY);
  });

  test("does not leak into 'latest' or pinned resolution", function () {
    expect(resolveLatestVersion()).not.toBe("nightly");
    expect(resolveChecksum("nightly", "android")).toBe("");
    expect(resolveChecksum("nightly", "ios")).toBe("");
    expect(resolveRunnerChecksum({ AUTOMOBILE_VERSION: "nightly" })).toBe("");
  });

  test("pinning AUTOMOBILE_VERSION=nightly is unknown and fails closed", function () {
    // No published nightly asset exists to download/verify, so the pin must not
    // be treated as a known, integrity-verifiable version.
    expect(isPinnedVersionKnown({ AUTOMOBILE_VERSION: "nightly" })).toBe(false);
  });
});
