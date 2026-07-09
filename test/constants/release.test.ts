import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  APK_SHA256_CHECKSUM,
  APK_URL,
  DAEMON_PACKAGE_NAME,
  DEFAULT_ASSET_BASE_URL,
  IOS_CTRL_PROXY_IPA_URL,
  IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM,
  IOS_CTRL_PROXY_SHA256_CHECKSUM,
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
  type ReleaseChecksumEntry,
} from "../../src/constants/release";

describe("resolveChecksum", function() {
  test("latest resolves to registry[0] (newest entry)", function() {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("latest", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum("latest", "ios")).toBe(newest.ipaSha256);
  });

  test("latest is case-insensitive and trims whitespace", function() {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveChecksum("LATEST", "android")).toBe(newest.apkSha256);
    expect(resolveChecksum(" latest ", "ios")).toBe(newest.ipaSha256);
  });

  test("pinned 0.0.18 resolves to its specific checksums", function() {
    expect(resolveChecksum("0.0.18", "android")).toBe("fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834");
    expect(resolveChecksum("0.0.18", "ios")).toBe("2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39");
  });

  test("pinned 0.0.17 resolves to its specific checksums, not latest", function() {
    expect(resolveChecksum("0.0.17", "android")).toBe("916033440931666644474f227c8e39d13d9c80c3515e4292cc5581fd5bd4cc2f");
    expect(resolveChecksum("0.0.17", "ios")).toBe("e4dcf064d024f2371b8fd79281000e2d49751ef95b8817d1494d685aeda746ac");
  });

  test("latest and pinned 0.0.17 return different checksums", function() {
    expect(resolveChecksum("latest", "android")).not.toBe(resolveChecksum("0.0.17", "android"));
    expect(resolveChecksum("latest", "ios")).not.toBe(resolveChecksum("0.0.17", "ios"));
  });

  test("pinned version not in registry returns empty string", function() {
    expect(resolveChecksum("99.99.99", "android")).toBe("");
    expect(resolveChecksum("99.99.99", "ios")).toBe("");
  });

  test("empty version returns empty string", function() {
    expect(resolveChecksum("", "android")).toBe("");
  });

  test("empty registry returns empty string", function() {
    const empty: ReleaseChecksumEntry[] = [];
    expect(resolveChecksum("latest", "android", empty)).toBe("");
    expect(resolveChecksum("0.0.18", "ios", empty)).toBe("");
  });

  test("multi-entry registry resolves each version independently", function() {
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

describe("resolveLatestVersion", function() {
  test("returns first registry entry version", function() {
    expect(resolveLatestVersion()).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("resolveAssetVersion", function() {
  test("passes through concrete versions unchanged", function() {
    expect(resolveAssetVersion("0.0.18")).toBe("0.0.18");
  });

  test("resolves the 'latest' placeholder to the newest registry entry", function() {
    expect(resolveAssetVersion("latest")).toBe(RELEASE_CHECKSUM_REGISTRY[0].version);
  });
});

describe("module-level URL and checksum exports", function() {
  // Guards against the pre-existing drift between APK_URL (was keyed off
  // resolveLatestVersion()) and APK_SHA256_CHECKSUM (was keyed off the
  // "latest" literal). Both must resolve via the same RELEASE_VERSION path.
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("APK_URL and IPA_URL reference the newest registered version", function() {
    expect(APK_URL).toContain(`/releases/download/${newest.version}/control-proxy-debug.apk`);
    expect(IOS_CTRL_PROXY_IPA_URL).toContain(`/releases/download/${newest.version}/control-proxy.ipa`);
  });

  test("APK and IPA checksums match the newest registered entry", function() {
    expect(APK_SHA256_CHECKSUM).toBe(newest.apkSha256);
    expect(IOS_CTRL_PROXY_SHA256_CHECKSUM).toBe(newest.ipaSha256);
  });

  test("iOS runner checksum matches the newest registered entry", function() {
    expect(IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM).toBe(newest.runnerSha256);
  });
});

// --- Issue #2746: hermetic single-version pinning knobs ---

describe("resolvePinnedVersion (AUTOMOBILE_VERSION single knob)", function() {
  test("returns 'latest' when AUTOMOBILE_VERSION is unset", function() {
    expect(resolvePinnedVersion({})).toBe("latest");
  });

  test("returns 'latest' when AUTOMOBILE_VERSION is blank", function() {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "   " })).toBe("latest");
  });

  test("returns the pinned version trimmed", function() {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: " 0.0.18 " })).toBe("0.0.18");
  });
});

describe("resolveAssetBaseUrl (AUTOMOBILE_ASSET_BASE_URL mirror knob)", function() {
  test("defaults to the GitHub releases base when unset", function() {
    expect(resolveAssetBaseUrl({})).toBe(DEFAULT_ASSET_BASE_URL);
    expect(DEFAULT_ASSET_BASE_URL).toContain("github.com/kaeawc/auto-mobile/releases/download");
  });

  test("uses the mirror base when set, stripping trailing slashes", function() {
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/" }))
      .toBe("https://mirror.test/am");
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am///" }))
      .toBe("https://mirror.test/am");
  });

  test("ignores a blank mirror base", function() {
    expect(resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "  " })).toBe(DEFAULT_ASSET_BASE_URL);
  });

  test("rejects mirror bases with query strings", function() {
    expect(() => resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am?token=abc" }))
      .toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
  });

  test("rejects mirror bases with fragments", function() {
    expect(() => resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am#release" }))
      .toThrow("AUTOMOBILE_ASSET_BASE_URL must not include a query string or fragment");
  });

  test("rejects non-absolute mirror bases", function() {
    expect(() => resolveAssetBaseUrl({ AUTOMOBILE_ASSET_BASE_URL: "/mirror/am" }))
      .toThrow("AUTOMOBILE_ASSET_BASE_URL must be an absolute URL");
  });
});

describe("resolveApkUrl / resolveIpaUrl (EC1, EC2, EC3)", function() {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("EC8: unset env resolves to the concrete latest version on the default host", function() {
    expect(resolveApkUrl({})).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy-debug.apk`
    );
    expect(resolveIpaUrl({})).toBe(
      `${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy.ipa`
    );
  });

  test("EC1: AUTOMOBILE_VERSION pins the URL version", function() {
    expect(resolveApkUrl({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.18/control-proxy-debug.apk`
    );
    expect(resolveIpaUrl({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      `${DEFAULT_ASSET_BASE_URL}/0.0.18/control-proxy.ipa`
    );
  });

  test("EC2: AUTOMOBILE_ASSET_BASE_URL mirrors the download host", function() {
    expect(resolveApkUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" })).toBe(
      `https://mirror.test/am/${newest.version}/control-proxy-debug.apk`
    );
  });

  test("EC3: both knobs compose", function() {
    expect(resolveApkUrl({
      AUTOMOBILE_VERSION: "0.0.18",
      AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/",
    })).toBe("https://mirror.test/am/0.0.18/control-proxy-debug.apk");
    expect(resolveIpaUrl({
      AUTOMOBILE_VERSION: "0.0.18",
      AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am/",
    })).toBe("https://mirror.test/am/0.0.18/control-proxy.ipa");
  });
});

describe("resolveApkChecksum / resolveIpaChecksum (EC1, EC4)", function() {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("EC8: unset env resolves to the latest entry checksums", function() {
    expect(resolveApkChecksum({})).toBe(newest.apkSha256);
    expect(resolveIpaChecksum({})).toBe(newest.ipaSha256);
  });

  test("EC1: AUTOMOBILE_VERSION selects that version's checksums coherently", function() {
    expect(resolveApkChecksum({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      "fd3c8d9f0b8542eaad56c78b18cf8e5666367b04ae8c4af74d8aa6dd1c8d1834"
    );
    expect(resolveIpaChecksum({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(
      "2a5eec63bce2f9dfc227c0732fcce67378305e945604d5eedd0e3df48e37fd39"
    );
  });

  test("EC4: an unknown pinned version yields an empty checksum", function() {
    expect(resolveApkChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
    expect(resolveIpaChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
  });
});

describe("resolveRunnerChecksum", function() {
  test("unset env resolves to the latest entry runner checksum", function() {
    const newest = RELEASE_CHECKSUM_REGISTRY[0];
    expect(resolveRunnerChecksum({})).toBe(newest.runnerSha256);
  });

  test("AUTOMOBILE_VERSION selects that version's runner checksum", function() {
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

  test("unknown pinned version yields an empty checksum", function() {
    expect(resolveRunnerChecksum({ AUTOMOBILE_VERSION: "99.99.99" })).toBe("");
  });
});

describe("resolveDaemonInstallSpecifier (EC5)", function() {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("yields a concrete specifier, never @latest, when unset", function() {
    const spec = resolveDaemonInstallSpecifier({});
    expect(spec).toBe(`${DAEMON_PACKAGE_NAME}@${newest.version}`);
    expect(spec).not.toContain("@latest");
  });

  test("honors AUTOMOBILE_VERSION", function() {
    expect(resolveDaemonInstallSpecifier({ AUTOMOBILE_VERSION: "0.0.18" }))
      .toBe(`${DAEMON_PACKAGE_NAME}@0.0.18`);
  });
});

// --- Review feedback: mixed-case `latest` normalization (Priya) ---

describe("resolvePinnedVersion normalizes the 'latest' sentinel", function() {
  const newest = RELEASE_CHECKSUM_REGISTRY[0];

  test("upper/mixed-case latest collapses to the canonical 'latest'", function() {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "LATEST" })).toBe("latest");
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: " Latest " })).toBe("latest");
  });

  test("mixed-case latest yields a coherent url + checksum + specifier (no /LATEST/ 404)", function() {
    const env = { AUTOMOBILE_VERSION: "LATEST" };
    expect(resolveApkUrl(env)).toBe(`${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy-debug.apk`);
    expect(resolveIpaUrl(env)).toBe(`${DEFAULT_ASSET_BASE_URL}/${newest.version}/control-proxy.ipa`);
    expect(resolveApkChecksum(env)).toBe(newest.apkSha256);
    expect(resolveDaemonInstallSpecifier(env)).toBe(`${DAEMON_PACKAGE_NAME}@${newest.version}`);
    // The bug: an un-normalized "LATEST" produced a real SHA but a .../LATEST/... URL.
    expect(resolveApkUrl(env)).not.toContain("/LATEST/");
  });

  test("a concrete version keeps its exact casing (registry keys are exact)", function() {
    expect(resolvePinnedVersion({ AUTOMOBILE_VERSION: "0.0.18" })).toBe("0.0.18");
  });
});

// --- Review feedback: fail-closed predicates (Sofia) ---

describe("isExplicitPin", function() {
  test("false when unset or the latest sentinel (any case)", function() {
    expect(isExplicitPin({})).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "  " })).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "latest" })).toBe(false);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "LATEST" })).toBe(false);
  });

  test("true for a concrete pin, known or unknown", function() {
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(true);
    expect(isExplicitPin({ AUTOMOBILE_VERSION: "99.99.99" })).toBe(true);
  });
});

describe("isPinnedVersionKnown", function() {
  test("latest/unset is known iff the registry is non-empty", function() {
    expect(isPinnedVersionKnown({})).toBe(true);
    expect(isPinnedVersionKnown({}, [])).toBe(false);
  });

  test("a concrete pin is known iff it is in the registry", function() {
    expect(isPinnedVersionKnown({ AUTOMOBILE_VERSION: "0.0.18" })).toBe(true);
    expect(isPinnedVersionKnown({ AUTOMOBILE_VERSION: "99.99.99" })).toBe(false);
  });
});

// --- Review feedback: degenerate empty-registry URL branch is now testable (Priya) ---

describe("resolveApkUrl / resolveIpaUrl with an injected registry", function() {
  const registry: ReleaseChecksumEntry[] = [
    { version: "0.0.20", apkSha256: "apk20", ipaSha256: "ipa20", runnerSha256: "runner20" },
  ];

  test("uses the injected registry's newest version", function() {
    expect(resolveApkUrl({}, registry)).toBe(`${DEFAULT_ASSET_BASE_URL}/0.0.20/control-proxy-debug.apk`);
  });

  test("empty registry + default host falls back to GitHub's /latest/download redirect", function() {
    expect(resolveApkUrl({}, [])).toBe(
      "https://github.com/kaeawc/auto-mobile/releases/latest/download/control-proxy-debug.apk"
    );
  });

  test("empty registry + mirror falls back to a conventional /latest/ path", function() {
    expect(resolveIpaUrl({ AUTOMOBILE_ASSET_BASE_URL: "https://mirror.test/am" }, [])).toBe(
      "https://mirror.test/am/latest/control-proxy.ipa"
    );
  });
});

describe("package.json as canonical version source", function() {
  // The npm version (package.json) is the canonical release version. The
  // checksum registry's newest entry must name that same version, or "latest"
  // resolves assets for a version that npm never published. The release gate
  // (scripts/ci/verify-release-integrity.sh) enforces this across every
  // manifest at release time; this test enforces it in the checked-in source.
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "../../package.json"), "utf8")
  ) as { version: string };

  test("resolveLatestVersion() equals package.json version", function() {
    expect(resolveLatestVersion()).toBe(pkg.version);
  });
});

describe("iOS runner-binary checksum", function() {
  test("registry entries carry empty or well-formed 64-char runner sha256 values", function() {
    for (const entry of RELEASE_CHECKSUM_REGISTRY) {
      expect(entry.runnerSha256 === "" || /^[a-f0-9]{64}$/.test(entry.runnerSha256)).toBe(true);
    }
  });

  test("module-level runner checksum export resolves from registry[0]", function() {
    expect(IOS_CTRL_PROXY_RUNNER_SHA256_CHECKSUM).toBe(RELEASE_CHECKSUM_REGISTRY[0].runnerSha256);
  });
});
