import { describe, expect, test } from "bun:test";
import {
  attributeRowByDumpsys,
  intersectDumpsysRecordsForRow,
  parseActiveNotificationKeysForApp,
  parseDumpsysNotificationRecords,
} from "../../../src/server/system-tray/notificationDumpsys";

const dump = (...lines: string[]): string => lines.join("\n");

const wellbeingRecord = dump(
  "    NotificationRecord(0x1a2b3c: pkg=com.google.android.apps.wellbeing user=UserHandle{0} id=0 tag=Discovery key=0|com.google.android.apps.wellbeing|0|Discovery|10164)",
  "      uid=10164 userId=0",
  "      extras={",
  "        android.title=String (Need better sleep?)",
  "        android.subText=null",
  "        android.showChronometer=Boolean (false)",
  "        android.text=String (Use Bedtime mode to silence your phone and keep the screen dark at bedtime)",
  "        android.template=String (android.app.Notification$BigTextStyle)",
  "      }",
);

describe("dumpsys notification records", () => {
  test("reads the posting package with its title and body from extras", () => {
    expect(parseDumpsysNotificationRecords(wellbeingRecord)).toEqual([
      {
        pkg: "com.google.android.apps.wellbeing",
        titles: ["Need better sleep?"],
        bodies: ["Use Bedtime mode to silence your phone and keep the screen dark at bedtime"],
        hasCustomLayout: false,
      },
    ]);
  });

  test("keeps records separate per posting package", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        wellbeingRecord,
        "    NotificationRecord(0xff00: pkg=com.google.android.apps.messaging user=UserHandle{0} id=1 tag=null key=0|com.google.android.apps.messaging|1|null|10155)",
        "      extras={",
        "        android.title=String ((555) 123-4567)",
        "        android.text=String (Got it, thanks!)",
        "      }",
      ),
    );
    expect(records.map((record) => record.pkg)).toEqual([
      "com.google.android.apps.wellbeing",
      "com.google.android.apps.messaging",
    ]);
    expect(records[1].titles).toEqual(["(555) 123-4567"]);
  });

  test("returns stable active keys while excluding synthetic group summaries", () => {
    expect(
      parseActiveNotificationKeysForApp(
        dump(
          "Current Notification Manager state:",
          "  Notification List:",
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=1 tag=child key=0|com.example.app|1|child|10100: Notification(channel=messages flags=0))",
          "      flags=0",
          "    NotificationRecord(0x2: pkg=com.example.app user=UserHandle{0} id=2 tag=summary key=0|com.example.app|2|summary|10100: Notification(channel=messages flags=LOCAL_ONLY|GROUP_SUMMARY|AUTOGROUP_SUMMARY))",
          "      flags=LOCAL_ONLY|GROUP_SUMMARY|AUTOGROUP_SUMMARY",
          "  Snoozed notifications:",
          "    NotificationRecord(0x3: pkg=com.example.app user=UserHandle{0} id=3 tag=snoozed key=0|com.example.app|3|snoozed|10100: Notification(channel=messages flags=0))",
        ),
        "com.example.app",
      ),
    ).toEqual(["0|com.example.app|1|child|10100"]);
  });

  test("rejects unrecognized output as unavailable accounting evidence", () => {
    expect(
      parseActiveNotificationKeysForApp("unrecognized but successful output", "com.example.app"),
    ).toBeUndefined();
  });

  test("accepts a recognized empty active section", () => {
    expect(
      parseActiveNotificationKeysForApp(
        dump("Current Notification Manager state:", "  Notification List:", "  Snoozed:"),
        "com.example.app",
      ),
    ).toEqual([]);
  });

  test("accepts an API 36 empty dump that omits the notification list", () => {
    expect(
      parseActiveNotificationKeysForApp(
        dump(
          "Current Notification Manager state:",
          "  Notification attention state:",
          "      mSoundNotificationKey=null",
          "  mArchive=Archive (0 notifications)",
          "  Snoozed notifications:",
          " Pending snoozed notifications",
          "  Ranking Config:",
        ),
        "com.example.app",
      ),
    ).toEqual([]);
  });

  test("accepts an empty active set with snoozed and archived records", () => {
    expect(
      parseActiveNotificationKeysForApp(
        dump(
          "Current Notification Manager state:",
          "  Notification attention state:",
          "  mArchive=Archive (1 notification)",
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=1 tag=archived key=0|com.example.app|1|archived|10100: Notification(channel=messages))",
          "  Snoozed notifications:",
          "    NotificationRecord(0x2: pkg=com.example.app user=UserHandle{0} id=2 tag=snoozed key=0|com.example.app|2|snoozed|10100: Notification(channel=messages))",
          "  Ranking Config:",
        ),
        "com.example.app",
      ),
    ).toEqual([]);
  });

  test("does not treat a manager-state header truncated before trailing state as empty", () => {
    expect(
      parseActiveNotificationKeysForApp("Current Notification Manager state:", "com.example.app"),
    ).toBeUndefined();
  });

  test("does not trust a manager-state dump with records but no active-list heading", () => {
    expect(
      parseActiveNotificationKeysForApp(
        dump(
          "Current Notification Manager state:",
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=1 tag=null key=0|com.example.app|1|null|10100: Notification(channel=messages))",
        ),
        "com.example.app",
      ),
    ).toBeUndefined();
  });

  test("yields no correlation evidence from a redacted dump", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1a2b3c: pkg=com.google.android.apps.wellbeing user=UserHandle{0} id=0 tag=Discovery key=0|com.google.android.apps.wellbeing|0|Discovery|10164)",
          "      extras={",
          "        android.title=String [19 chars]",
          "        android.text=String [74 chars]",
          "      }",
        ),
      ),
    ).toEqual([
      { pkg: "com.google.android.apps.wellbeing", titles: [], bodies: [], hasCustomLayout: false },
    ]);
  });

  test("detects a custom RemoteViews layout without a decorated style", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1a2b3c: pkg=com.example.custom user=UserHandle{0} id=0 tag=null key=0|com.example.custom|0|null|10100)",
          "      uid=10100 userId=0",
          "      contentView=null",
          "      bigContentView=android.widget.RemoteViews@a1b2c3d",
          "      headsUpContentView=null",
          "      extras={",
          "        android.title=String (Custom notification)",
          "        android.template=String (android.app.Notification$BigTextStyle)",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.example.custom",
        titles: ["Custom notification"],
        bodies: [],
        hasCustomLayout: true,
      },
    ]);
  });

  test("does not treat null custom layout fields as custom", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1a2b3c: pkg=com.example.default user=UserHandle{0} id=0 tag=null key=0|com.example.default|0|null|10100)",
          "      uid=10100 userId=0",
          "      contentView=null",
          "      bigContentView=null",
          "      headsUpContentView=null",
          "      extras={",
          "        android.title=String (Default notification)",
          "        android.template=String (android.app.Notification$BigTextStyle)",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.example.default",
        titles: ["Default notification"],
        bodies: [],
        hasCustomLayout: false,
      },
    ]);
  });

  test("parses a content-less Clock custom layout record", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "  Notification List:",
          "    NotificationRecord(0x06b3f5ad: pkg=com.google.android.deskclock user=UserHandle{0} id=2147483641 tag=null importance=3 key=0|com.google.android.deskclock|2147483641|null|10163: Notification(channel=Timers contentView=com.google.android.deskclock/0x7f0e0042))",
          "      contentView=com.google.android.deskclock/0x7f0e0042 (0 bytes): android.widget.RemoteViews@224e730",
          "      extras={",
          "        android.title=null",
          "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
          "        android.text=null",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.google.android.deskclock",
        titles: [],
        bodies: [],
        hasCustomLayout: true,
      },
    ]);
  });

  test("ignores content-shaped lines outside a record's extras block", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "  Notification listeners:",
          "    android.title=String (Not a posted notification)",
          "  Notification List:",
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      android.text=String (Outside extras)",
          "      extras={",
          "        android.title=String (Inside extras)",
          "      }",
          "      android.text=String (After extras)",
        ),
      ),
    ).toEqual([
      { pkg: "com.example.app", titles: ["Inside extras"], bodies: [], hasCustomLayout: false },
    ]);
  });

  test("attributes a row whose rendered text matches exactly one package", () => {
    expect(
      attributeRowByDumpsys(
        parseDumpsysNotificationRecords(wellbeingRecord),
        new Set([
          "Need better sleep?",
          "Use Bedtime mode to silence your phone and keep the screen dark at bedtime",
        ]),
      ),
    ).toBe("com.google.android.apps.wellbeing");
  });

  test("keeps a row ambiguous when a competing before-snapshot record was dismissed", () => {
    const rowTexts = new Set(["Need better sleep?", "Keep the screen dark"]);
    const before = [
      {
        pkg: "com.example.requested",
        titles: ["Need better sleep?"],
        bodies: ["Keep the screen dark"],
        hasCustomLayout: false,
      },
      {
        pkg: "com.example.dismissed",
        titles: ["Need better sleep?"],
        bodies: ["Keep the screen dark"],
        hasCustomLayout: false,
      },
    ];
    const after = [before[0]!];

    const intersected = intersectDumpsysRecordsForRow(before, after, rowTexts);
    expect(intersected).toEqual([]);
    expect(attributeRowByDumpsys(intersected, rowTexts)).toBeNull();
  });

  test("excludes a package that only appears in the after snapshot", () => {
    const rowTexts = new Set(["Need better sleep?", "Keep the screen dark"]);
    const requested = {
      pkg: "com.example.requested",
      titles: ["Need better sleep?"],
      bodies: ["Keep the screen dark"],
      hasCustomLayout: false,
    };
    const afterOnly = { ...requested, pkg: "com.example.after-only" };

    expect(
      intersectDumpsysRecordsForRow([requested], [requested, afterOnly], rowTexts).map(
        (record) => record.pkg,
      ),
    ).toEqual(["com.example.requested"]);
  });

  test("falls back to the after snapshot when no before snapshot was captured", () => {
    const after = parseDumpsysNotificationRecords(wellbeingRecord);
    expect(
      intersectDumpsysRecordsForRow(
        undefined,
        after,
        new Set([
          "Need better sleep?",
          "Use Bedtime mode to silence your phone and keep the screen dark at bedtime",
        ]),
      ),
    ).toEqual(after);
  });

  test("requires every populated extras category to be rendered by the row", () => {
    const records = parseDumpsysNotificationRecords(wellbeingRecord);
    expect(attributeRowByDumpsys(records, new Set(["Need better sleep?"]))).toBeNull();
    expect(attributeRowByDumpsys(records, new Set(["Some other notification"]))).toBeNull();
  });

  test("refuses to name an owner when two packages posted identical content", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.one user=UserHandle{0} id=0 tag=null key=0|com.example.one|0|null|10100)",
        "      extras={",
        "        android.title=String (Same title)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.example.two user=UserHandle{0} id=0 tag=null key=0|com.example.two|0|null|10101)",
        "      extras={",
        "        android.title=String (Same title)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Same title"]))).toBeNull();
  });

  test("keeps a row ambiguous when another package's record explains the same text", () => {
    // A collapsed or custom row can render a title without the body its record
    // populated, so the thinner record is not the better candidate: naming it
    // would attribute the other app's row to the requested package (#6875).
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.requested user=UserHandle{0} id=0 tag=null key=0|com.example.requested|0|null|10100)",
        "      extras={",
        "        android.title=String (Download complete)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
        "      extras={",
        "        android.title=String (Download complete)",
        "        android.text=String (file.zip)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Download complete"]))).toBeNull();
  });

  test("still attributes a row when no other package shares its rendered text", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        wellbeingRecord,
        "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
        "      extras={",
        "        android.title=String (Unrelated)",
        "        android.text=String (Unrelated body)",
        "      }",
      ),
    );
    expect(
      attributeRowByDumpsys(
        records,
        new Set([
          "Need better sleep?",
          "Use Bedtime mode to silence your phone and keep the screen dark at bedtime",
        ]),
      ),
    ).toBe("com.google.android.apps.wellbeing");
  });

  test("drops empty extras values so a title-only row stays matchable", () => {
    // `android.text=String ()` is an empty body; hierarchy extraction never
    // emits empty strings, so keeping it would make the record unmatchable.
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
        "      extras={",
        "        android.title=String (Sync finished)",
        "        android.text=String ()",
        "        android.subText=String (   )",
        "      }",
      ),
    );
    expect(records).toEqual([
      { pkg: "com.example.app", titles: ["Sync finished"], bodies: [], hasCustomLayout: false },
    ]);
    expect(attributeRowByDumpsys(records, new Set(["Sync finished"]))).toBe("com.example.app");
  });

  test("does not attribute a row to a record that carries no readable content", () => {
    expect(
      attributeRowByDumpsys(
        [{ pkg: "com.example.app", titles: [], bodies: [], hasCustomLayout: false }],
        new Set(["anything"]),
      ),
    ).toBeNull();
  });

  test("reads a CharSequence extra that spans physical lines", () => {
    // `NotificationRecord.dump` prints an embedded newline verbatim, so the
    // closing delimiter lands on a later physical line (#6875).
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.title=String (Backup)",
          "        android.bigText=String (Line one",
          "Line two)",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.example.app",
        titles: ["Backup"],
        bodies: ["Line one\nLine two"],
        hasCustomLayout: false,
      },
    ]);
  });

  test("does not run a multiline value past the end of its record", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.text=String (unterminated",
          "      }",
          "    NotificationRecord(0x2: pkg=com.example.other user=UserHandle{0} id=0 tag=null key=0|com.example.other|0|null|10101)",
          "      extras={",
          "        android.title=String (Other)",
          "      }",
        ),
      ),
    ).toEqual([
      { pkg: "com.example.app", titles: [], bodies: [], hasCustomLayout: false },
      { pkg: "com.example.other", titles: ["Other"], bodies: [], hasCustomLayout: false },
    ]);
  });

  test("keeps a row ambiguous when a record carrying no extras could own it", () => {
    // A header-less custom `RemoteViews` row renders text none of the supported
    // extras carry, so its own record is opaque. Attributing the row to the one
    // package whose extras happen to equal that text names the wrong app.
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.actual.custom user=UserHandle{0} id=0 tag=null key=0|com.actual.custom|0|null|10100)",
        "      extras={",
        "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.requested user=UserHandle{0} id=0 tag=null key=0|com.requested|0|null|10101)",
        "      extras={",
        "        android.title=String (Syncing)",
        "      }",
      ),
    );
    expect(attributeRowByDumpsys(records, new Set(["Syncing"]))).toBeNull();
  });

  test("keeps a row ambiguous when a custom-layout record has unrelated extras", () => {
    // A custom layout can render text unrelated to its supported extras, even
    // when it also carries a default title (#6927).
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.actual.custom user=UserHandle{0} id=0 tag=null key=0|com.actual.custom|0|null|10100)",
        "      extras={",
        "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
        "        android.title=String (Hidden default)",
        "      }",
        "    NotificationRecord(0x2: pkg=com.requested user=UserHandle{0} id=0 tag=null key=0|com.requested|0|null|10101)",
        "      extras={",
        "        android.title=String (Syncing)",
        "      }",
      ),
    );
    expect(records[0]).toEqual({
      pkg: "com.actual.custom",
      titles: ["Hidden default"],
      bodies: [],
      hasCustomLayout: true,
    });
    expect(attributeRowByDumpsys(records, new Set(["Syncing"]))).toBeNull();
  });

  test("preserves a key-shaped continuation line in a multiline extra", () => {
    const records = parseDumpsysNotificationRecords(
      dump(
        "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
        "      extras={",
        "        android.bigText=String (Line one",
        "Status=offline",
        "Line three)",
        "      }",
      ),
    );
    expect(records[0]?.bodies).toEqual(["Line one\nStatus=offline\nLine three"]);
  });

  test("recognizes an indented extras key after an unterminated multiline value", () => {
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.bigText=String (unterminated",
          "        android.title=String (Recovered title)",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.example.app",
        titles: ["Recovered title"],
        bodies: [],
        hasCustomLayout: false,
      },
    ]);
  });

  test("reads a multiline value whose inner line ends in a parenthesis", () => {
    // The dump prints the value verbatim, so a `)` that belongs to the text is
    // not the wrapper's closing delimiter: only the last physical line of the
    // entry ends the value (#6875).
    expect(
      parseDumpsysNotificationRecords(
        dump(
          "    NotificationRecord(0x1: pkg=com.example.app user=UserHandle{0} id=0 tag=null key=0|com.example.app|0|null|10100)",
          "      extras={",
          "        android.bigText=String (Line one",
          "step (done)",
          "Line three)",
          "      }",
        ),
      ),
    ).toEqual([
      {
        pkg: "com.example.app",
        titles: [],
        bodies: ["Line one\nstep (done)\nLine three"],
        hasCustomLayout: false,
      },
    ]);
  });

  test("ignores records outside the active notification list", () => {
    // Snoozed and enqueued records are printed in their own sections and are
    // not rendered in the shade, so they are not correlation evidence; an
    // opaque one would otherwise make every header-less row ambiguous (#6875).
    const records = parseDumpsysNotificationRecords(
      dump(
        "  Notification List:",
        "    NotificationRecord(0x1: pkg=com.requested user=UserHandle{0} id=0 tag=null key=0|com.requested|0|null|10100)",
        "      extras={",
        "        android.title=String (Syncing)",
        "      }",
        "  Snoozed notifications:",
        "    NotificationRecord(0x2: pkg=com.snoozed user=UserHandle{0} id=0 tag=null key=0|com.snoozed|0|null|10101)",
        "      extras={",
        "        android.template=String (android.app.Notification$DecoratedCustomViewStyle)",
        "      }",
      ),
    );
    expect(records).toEqual([
      { pkg: "com.requested", titles: ["Syncing"], bodies: [], hasCustomLayout: false },
    ]);
    expect(attributeRowByDumpsys(records, new Set(["Syncing"]))).toBe("com.requested");
  });
});
