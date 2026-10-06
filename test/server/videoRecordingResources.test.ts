import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  assertWithinArchiveRoot,
  buildVideoResourceContent,
  getLatestVideoRecording,
  getVideoArchiveItem,
  getVideoArchiveList,
  type VideoRecordingResourceStore,
} from "../../src/server/videoRecordingResources";
import {
  buildVideoArchiveItemUri,
  VIDEO_RESOURCE_URIS,
} from "../../src/server/videoRecordingResourceUris";
import type { VideoRecordingMetadata } from "../../src/models";

const ARCHIVE_ROOT = "/tmp/video-archive";

function metadata(overrides: Partial<VideoRecordingMetadata> = {}): VideoRecordingMetadata {
  return {
    recordingId: "rec-1",
    fileName: "rec-1.mp4",
    filePath: `${ARCHIVE_ROOT}/rec-1/rec-1.mp4`,
    format: "mp4",
    sizeBytes: 1024,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T00:00:00.000Z",
    config: {} as VideoRecordingMetadata["config"],
    ...overrides,
  };
}

function store(overrides: Partial<VideoRecordingResourceStore> = {}): VideoRecordingResourceStore {
  return {
    lookupLatest: async () => ({ recording: null }),
    getById: async () => null,
    list: async () => [],
    readFile: async () => Buffer.from("video-bytes"),
    archiveRoot: ARCHIVE_ROOT,
    ...overrides,
  };
}

function parse(text: string | undefined): Record<string, unknown> {
  return JSON.parse(text ?? "{}");
}

describe("default archive root", () => {
  for (const envKey of ["AUTOMOBILE_DATA_DIR", "AUTO_MOBILE_DATA_DIR"]) {
    test(`confines default resource reads to the current ${envKey} and preserves overrides`, async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-resource-root-"));
      const originalDataDir = process.env.AUTOMOBILE_DATA_DIR;
      const originalLegacyDataDir = process.env.AUTO_MOBILE_DATA_DIR;
      try {
        delete process.env.AUTOMOBILE_DATA_DIR;
        delete process.env.AUTO_MOBILE_DATA_DIR;
        process.env[envKey] = dataDir;
        const archiveRoot = path.join(dataDir, "video-archive");
        const filePath = path.join(archiveRoot, "recording.mp4");
        await fs.mkdir(archiveRoot);
        await fs.writeFile(filePath, "isolated-video");

        const content = await buildVideoResourceContent(
          metadata({ filePath }),
          VIDEO_RESOURCE_URIS.LATEST,
        );
        expect(content.blob).toBe(Buffer.from("isolated-video").toString("base64"));

        process.env[envKey] = path.join(dataDir, "another-root");
        const rejected = await buildVideoResourceContent(
          metadata({ filePath }),
          VIDEO_RESOURCE_URIS.LATEST,
        );
        expect(rejected.blob).toBeUndefined();
        expect(parse(rejected.text).error).toContain("outside the archive root");

        const explicit = await buildVideoResourceContent(
          metadata({ filePath }),
          VIDEO_RESOURCE_URIS.LATEST,
          store({ archiveRoot }),
        );
        expect(explicit.blob).toBe(Buffer.from("video-bytes").toString("base64"));
      } finally {
        if (originalDataDir === undefined) {
          delete process.env.AUTOMOBILE_DATA_DIR;
        } else {
          process.env.AUTOMOBILE_DATA_DIR = originalDataDir;
        }
        if (originalLegacyDataDir === undefined) {
          delete process.env.AUTO_MOBILE_DATA_DIR;
        } else {
          process.env.AUTO_MOBILE_DATA_DIR = originalLegacyDataDir;
        }
        await fs.rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

describe("getLatestVideoRecording", () => {
  test("reports that no recordings are available when the store is empty", async () => {
    const content = await getLatestVideoRecording(
      store({ lookupLatest: async () => ({ recording: null }) }),
    );
    expect(content.uri).toBe(VIDEO_RESOURCE_URIS.LATEST);
    expect(parse(content.text).error).toContain("No video recordings available");
  });

  test.each([
    ["interrupted", "was interrupted and has no file"],
    ["completed", "has no file on disk any more"],
  ] as const)(
    "says why nothing is playable when the newest recording is %s without a file (#10187)",
    async (status, why) => {
      let readCalled = false;
      const content = await getLatestVideoRecording(
        store({
          lookupLatest: async () => ({
            recording: null,
            newestWithoutFile: { recordingId: "rec-new", status },
          }),
          readFile: async () => {
            readCalled = true;
            return Buffer.from("never read");
          },
        }),
      );
      expect(readCalled).toBe(false);
      expect(content.blob).toBeUndefined();
      expect(parse(content.text)).toEqual({
        error: `No playable video recording is available: the newest recording rec-new ${why}.`,
        newestRecording: { recordingId: "rec-new", status },
      });
    },
  );

  test("returns the metadata and base64 video for the latest recording", async () => {
    const latest = metadata({ recordingId: "latest-1" });
    const content = await getLatestVideoRecording(
      store({
        lookupLatest: async () => ({ recording: latest }),
        getById: async () => latest,
        readFile: async () => Buffer.from("abc"),
      }),
    );
    expect(content.mimeType).toBe("video/mp4");
    expect(content.blob).toBe(Buffer.from("abc").toString("base64"));
    expect((parse(content.text).metadata as VideoRecordingMetadata).recordingId).toBe("latest-1");
  });
});

describe("getVideoArchiveList", () => {
  test("returns an empty archive with a zero count when there are no recordings", async () => {
    const content = await getVideoArchiveList(store({ list: async () => [] }));
    const body = parse(content.text);
    expect(content.uri).toBe(VIDEO_RESOURCE_URIS.ARCHIVE);
    expect(body.count).toBe(0);
    expect(body.recordings).toEqual([]);
  });

  test("reports the count of archived recordings", async () => {
    const content = await getVideoArchiveList(
      store({ list: async () => [metadata({ recordingId: "a" }), metadata({ recordingId: "b" })] }),
    );
    expect(parse(content.text).count).toBe(2);
  });
});

describe("getVideoArchiveItem", () => {
  test("requires a recording ID", async () => {
    const content = await getVideoArchiveItem({}, store());
    expect(parse(content.text).error).toBe("Recording ID is required.");
  });

  test("reports a not-found error for an unknown recording ID", async () => {
    const content = await getVideoArchiveItem(
      { recordingId: "ghost" },
      store({ getById: async () => null }),
    );
    expect(content.uri).toBe(buildVideoArchiveItemUri("ghost"));
    expect(parse(content.text).error).toBe("Recording not found: ghost");
  });

  test("returns content for a known recording ID", async () => {
    const content = await getVideoArchiveItem(
      { recordingId: "rec-1" },
      store({ getById: async () => metadata(), readFile: async () => Buffer.from("xy") }),
    );
    expect(content.blob).toBe(Buffer.from("xy").toString("base64"));
  });
});

describe("assertWithinArchiveRoot", () => {
  const root = "/home/user/.auto-mobile/video-archive";

  test("returns the resolved path for a file inside the archive root", () => {
    // Assert via node:path so the expectation matches on Windows (backslashes /
    // drive letter) as well as POSIX — mirrors assertWithinArchiveRoot's own path.resolve.
    const input = path.join(root, "rec-1", "rec-1.mp4");
    expect(assertWithinArchiveRoot(input, root)).toBe(path.resolve(root, input));
  });

  test("resolves a relative path against the archive root", () => {
    const input = path.join("rec-1", "rec-1.mp4");
    expect(assertWithinArchiveRoot(input, root)).toBe(path.resolve(root, input));
  });

  test("throws for an absolute path outside the archive root", () => {
    expect(() => assertWithinArchiveRoot("/etc/passwd", root)).toThrow(/outside the archive root/);
  });

  test("throws for a traversal escaping the archive root", () => {
    expect(() => assertWithinArchiveRoot("../../etc/passwd", root)).toThrow(
      /outside the archive root/,
    );
  });
});

describe("buildVideoResourceContent", () => {
  test("reports a missing-file error when the metadata has no file path", async () => {
    const content = await buildVideoResourceContent(
      metadata({ filePath: "", recordingId: "no-file" }),
      VIDEO_RESOURCE_URIS.LATEST,
      store(),
    );
    expect(content.mimeType).toBe("application/json");
    expect(parse(content.text).error).toBe("Missing file path for recording no-file");
    expect(content.blob).toBeUndefined();
  });

  test("refuses to read a poisoned file path outside the archive root, before touching disk", async () => {
    let readCalled = false;
    const content = await buildVideoResourceContent(
      metadata({ filePath: "/etc/passwd", recordingId: "poisoned" }),
      VIDEO_RESOURCE_URIS.LATEST,
      store({
        readFile: async () => {
          readCalled = true;
          return Buffer.from("secret");
        },
      }),
    );
    expect(readCalled).toBe(false);
    expect(content.blob).toBeUndefined();
    expect(content.mimeType).toBe("application/json");
    expect(parse(content.text).error).toContain("Failed to read video data");
  });

  test("refuses a relative traversal escaping the archive root", async () => {
    let readCalled = false;
    const content = await buildVideoResourceContent(
      metadata({ filePath: "../../etc/passwd", recordingId: "traversal" }),
      VIDEO_RESOURCE_URIS.LATEST,
      store({
        readFile: async () => {
          readCalled = true;
          return Buffer.from("secret");
        },
      }),
    );
    expect(readCalled).toBe(false);
    expect(content.blob).toBeUndefined();
  });

  test.each([
    [0, "it was interrupted before a file was saved"],
    [1024, "the file was deleted or moved"],
  ])(
    "an explicit read of a recording with no file on disk (size %d) says so (#10187)",
    async (sizeBytes, why) => {
      const content = await buildVideoResourceContent(
        metadata({ sizeBytes }),
        buildVideoArchiveItemUri("rec-1"),
        store({
          readFile: async () => {
            throw Object.assign(new Error("ENOENT: no such file or directory"), {
              code: "ENOENT",
            });
          },
        }),
      );
      expect(parse(content.text).error).toBe(
        `Failed to read video data: Recording rec-1 has no video file on disk (${why})`,
      );
      expect(content.blob).toBeUndefined();
    },
  );

  test("reports a read error when the video file cannot be read", async () => {
    const content = await buildVideoResourceContent(
      metadata(),
      VIDEO_RESOURCE_URIS.LATEST,
      store({
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(content.mimeType).toBe("application/json");
    expect(parse(content.text).error).toContain("Failed to read video data");
    expect(content.blob).toBeUndefined();
  });
});
