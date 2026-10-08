#!/usr/bin/env bun
/**
 * Assemble GitHub release notes, reserving space for asset checksums and links.
 *
 *   VERSION=0.0.82 TAG=0.0.82 GITHUB_REPOSITORY=kaeawc/auto-mobile \
 *     APK_CHECKSUM=... IPA_CHECKSUM=... VIDEO_JAR_CHECKSUM=... \
 *     SCREEN_CAPTURE_HELPER_CHECKSUM=... OVERLAY_AGENT_CHECKSUM=... bun scripts/release/build-release-notes.ts
 *
 * CHANGELOG_PATH defaults to CHANGELOG.md; RELEASE_NOTES_PATH defaults to
 * release_notes.txt. A missing changelog is allowed. Only whole changelog lines
 * are dropped when the body exceeds the budget (UTF-16 code units).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const RELEASE_NOTES_BUDGET = 120_000;

interface ReleaseNotesInput {
  version: string;
  tag: string;
  repository: string;
  changelog: string | null;
  checksums: {
    apk: string;
    ipa: string;
    videoJar: string;
    screenCaptureHelper: string;
    overlayAgent: string;
  };
}

function extractSection(changelog: string | null, version: string) {
  const lines = changelog?.split("\n") ?? [];
  const normalizedVersion = version.replace(/^v/, "");
  const start = lines.findIndex(
    (line) =>
      line.startsWith(`## [${normalizedVersion}]`) || line.startsWith(`## [v${normalizedVersion}]`),
  );
  if (start < 0) {
    return { heading: "", lines: [], previousTag: undefined };
  }
  const nextOffset = lines.slice(start + 1).findIndex((line) => line.startsWith("## ["));
  const end = nextOffset < 0 ? lines.length : start + 1 + nextOffset;
  return {
    heading: lines[start].slice(3),
    lines: lines.slice(start + 1, end).filter((line) => line !== ""),
    previousTag: lines[end]?.match(/^## \[v?([^\]]+)\]/)?.[1],
  };
}

export function buildReleaseNotes(input: ReleaseNotesInput): string {
  const { version, tag, repository, changelog, checksums } = input;
  const section = extractSection(changelog, version);
  const changelogPart = section.lines.join("\n") || `Release v${version.replace(/^v/, "")}`;
  const tail =
    `\n\n## CtrlProxy APK\n\n**SHA256 Checksum:** \`${checksums.apk}\`\n\nDownload the APK from the release assets below.` +
    `\n\n## CtrlProxy iOS IPA\n\n**SHA256 Checksum:** \`${checksums.ipa}\`\n\nDownload the IPA from the release assets below.` +
    `\n\n## video-server jar\n\n**SHA256 Checksum:** \`${checksums.videoJar}\`\n\nDownload automobile-video.jar from the release assets below.` +
    `\n\n## macOS screen-capture-helper\n\n**SHA256 Checksum:** \`${checksums.screenCaptureHelper}\`\n\nDownload screen-capture-helper-macos-universal.zip from the release assets below.` +
    `\n\n## iOS simulator overlay agent\n\n**SHA256 Checksum:** \`${checksums.overlayAgent}\`\n\nDownload AutoMobileOverlayAgent.dylib (universal arm64 + x86_64, ad-hoc signed) from the release assets below.` +
    "\n\n## Desktop App\n\nNative installers are attached below: macOS `.dmg` (signed & notarized), Windows `.msi`, and Linux `.deb`.";
  if (changelogPart.length + tail.length <= RELEASE_NOTES_BUDGET) {
    return changelogPart + tail;
  }

  const anchor = section.heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
  const notice =
    `… (truncated; see the full changelog: https://github.com/${repository}/blob/${tag}/CHANGELOG.md#${anchor})` +
    (section.previousTag
      ? `\nCompare: https://github.com/${repository}/compare/${section.previousTag}...${tag}`
      : "");
  const available = RELEASE_NOTES_BUDGET - tail.length - notice.length - 2;
  const kept: string[] = [];
  let length = 0;
  for (const line of section.lines) {
    const nextLength = length + (kept.length > 0 ? 1 : 0) + line.length;
    if (nextLength > available) {
      break;
    }
    kept.push(line);
    length = nextLength;
  }
  return (kept.length > 0 ? `${kept.join("\n")}\n\n` : "") + notice + tail;
}

/** Preserve the newline formerly written by echo "$NOTES". */
export function releaseNotesFileContent(body: string): string {
  return `${body}\n`;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

if (import.meta.main) {
  const version = requiredEnv("VERSION");
  const tag = requiredEnv("TAG");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const checksums = {
    apk: requiredEnv("APK_CHECKSUM"),
    ipa: requiredEnv("IPA_CHECKSUM"),
    videoJar: requiredEnv("VIDEO_JAR_CHECKSUM"),
    screenCaptureHelper: requiredEnv("SCREEN_CAPTURE_HELPER_CHECKSUM"),
    overlayAgent: requiredEnv("OVERLAY_AGENT_CHECKSUM"),
  };
  const changelogPath = process.env.CHANGELOG_PATH || "CHANGELOG.md";
  const body = buildReleaseNotes({
    version,
    tag,
    repository,
    checksums,
    changelog: existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : null,
  });
  writeFileSync(
    process.env.RELEASE_NOTES_PATH || "release_notes.txt",
    releaseNotesFileContent(body),
  );
}
