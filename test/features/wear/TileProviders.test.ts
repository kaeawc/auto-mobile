import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AdbTileProviderLister,
  TILE_PROVIDER_ACTION,
  TileProviderNotFoundError,
  normalizeTileComponent,
  parseTileProviderComponents,
  requireTileProvider,
  type TileProviderAdb,
} from "../../../src/features/wear/TileProviders";
import { ActionableError, type ExecResult } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

// Captured verbatim from a Wear OS 7.0 / API 37 emulator (#16824, #17496).
const CAPTURED = readFileSync(
  join(import.meta.dir, "../../fixtures/wear-tiles/query-services-components-api37.txt"),
  "utf8",
);
const FAVORITES =
  "com.google.android.contacts/com.google.android.wearable.contacts.tiles.FavoriteContactsTileService";
const SINGLE =
  "com.google.android.contacts/com.google.android.wearable.contacts.tiles.singlecontact.SingleContactTileService";

class FakeTileProviderAdb implements TileProviderAdb {
  readonly calls: string[][] = [];
  constructor(
    private readonly stdout = CAPTURED,
    private readonly error?: Error,
  ) {}

  async execute(args: string[]): Promise<ExecResult> {
    this.calls.push(args);
    if (this.error) {
      throw this.error;
    }
    return createExecResult(this.stdout, "");
  }
}

describe("parseTileProviderComponents", () => {
  test("parses the captured --components transcript", () => {
    expect(parseTileProviderComponents(CAPTURED)).toEqual([
      {
        component: FAVORITES,
        packageName: "com.google.android.contacts",
        className: "com.google.android.wearable.contacts.tiles.FavoriteContactsTileService",
      },
      {
        component: SINGLE,
        packageName: "com.google.android.contacts",
        className:
          "com.google.android.wearable.contacts.tiles.singlecontact.SingleContactTileService",
      },
    ]);
  });

  test("ignores a services-found header, blank lines and CRLF", () => {
    const parsed = parseTileProviderComponents(
      `2 services found:\r\n${CAPTURED.replace(/\n/g, "\r\n")}\r\n\r\n`,
    );
    expect(parsed.map((p) => p.component)).toEqual([FAVORITES, SINGLE]);
  });

  test.each(["", "\n", "0 services found:\n", "No services found\n"])(
    "%j is an empty list, not an error",
    (stdout) => {
      expect(parseTileProviderComponents(stdout)).toEqual([]);
    },
  );

  test("expands short class names and drops duplicates", () => {
    const parsed = parseTileProviderComponents("com.ex/.Tile\ncom.ex/com.ex.Tile\n");
    expect(parsed).toEqual([
      { component: "com.ex/com.ex.Tile", packageName: "com.ex", className: "com.ex.Tile" },
    ]);
  });

  test("normalizeTileComponent expands short form and trims", () => {
    expect(normalizeTileComponent(" com.ex/.Tile ")).toBe("com.ex/com.ex.Tile");
    expect(normalizeTileComponent("not a component")).toBe("not a component");
  });
});

describe("AdbTileProviderLister", () => {
  test("queries the tile provider action in --components form", async () => {
    const adb = new FakeTileProviderAdb();
    const providers = await new AdbTileProviderLister(adb).list();
    expect(adb.calls).toEqual([
      ["shell", "cmd", "package", "query-services", "--components", "-a", TILE_PROVIDER_ACTION],
    ]);
    expect(providers.map((p) => p.component)).toEqual([FAVORITES, SINGLE]);
  });

  test("adb failure becomes ActionableError", async () => {
    const adb = new FakeTileProviderAdb("", new Error("device offline"));
    const error = await new AdbTileProviderLister(adb).list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toBe("Failed to list Wear tile providers: device offline");
  });

  test("aborted signal never reaches adb", async () => {
    const adb = new FakeTileProviderAdb();
    const controller = new AbortController();
    controller.abort();
    await expect(new AdbTileProviderLister(adb).list(controller.signal)).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(adb.calls).toEqual([]);
  });
});

describe("requireTileProvider", () => {
  test("returns the matching provider", async () => {
    const lister = new AdbTileProviderLister(new FakeTileProviderAdb());
    const provider = await requireTileProvider(lister, SINGLE);
    expect(provider.component).toBe(SINGLE);
  });

  test("accepts a short-form component", async () => {
    const lister = new AdbTileProviderLister(new FakeTileProviderAdb("com.ex/com.ex.Tile\n"));
    expect((await requireTileProvider(lister, "com.ex/.Tile")).component).toBe(
      "com.ex/com.ex.Tile",
    );
  });

  test("unknown component throws a typed error listing valid providers", async () => {
    const lister = new AdbTileProviderLister(new FakeTileProviderAdb());
    const error = await requireTileProvider(lister, "com.ex/com.ex.Missing").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TileProviderNotFoundError);
    expect(error).toBeInstanceOf(ActionableError);
    const typed = error as TileProviderNotFoundError;
    expect(typed.reason).toBe("providerNotFound");
    expect(typed.component).toBe("com.ex/com.ex.Missing");
    expect(typed.available).toEqual([FAVORITES, SINGLE]);
    expect(typed.message).toContain(`Use one of: ${FAVORITES}, ${SINGLE}.`);
  });

  test("no installed providers says so", async () => {
    const lister = new AdbTileProviderLister(new FakeTileProviderAdb("0 services found:\n"));
    const error = await requireTileProvider(lister, FAVORITES).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TileProviderNotFoundError);
    expect((error as Error).message).toContain("No tile providers are installed");
  });
});
