import swiftSource from "../../ios/FilesFixture/FilesFixture.swift" with { type: "text" };
import infoPlistTemplate from "../../ios/FilesFixture/Info.plist" with { type: "text" };

/** The Files fixture app sources, embedded so the daemon can build it without a checkout. */
export const IOS_FILES_FIXTURE_SOURCES = {
  swift: swiftSource,
  infoPlistTemplate,
} as const;
