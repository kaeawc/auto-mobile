import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observeResultFromJsonText } from "../../helpers/observeFixture";

// Verbatim observe --project full envelopes; parse the observation in content[0].text.
function loadObservation(name: string) {
  const capture: { content: [{ text: string }] } = JSON.parse(
    readFileSync(join(import.meta.dir, "../../fixtures/systemTray/ios-26.5", name), "utf8"),
  );
  return observeResultFromJsonText(capture.content[0].text, name);
}

export const ios26TrayOpenSettings = loadObservation("full-tray-open-settings.json");
export const ios26SettingsClosed = loadObservation("full-settings-closed.json");
export const ios26TrayOpenHome = loadObservation("full-tray-open-home.json");
export const iosMessagesGroupedTray = loadObservation("full-tray-open-messages-grouped.json");
