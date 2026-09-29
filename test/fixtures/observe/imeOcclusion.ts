import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

/** An app button behind Gboard, a partly exposed button, and an exposed button. */
export function imeOcclusionHierarchy(withIme = true): ViewHierarchyResult {
  const node = (text: string, top: number, bottom: number) => ({
    $: {
      text,
      clickable: true,
      "resource-id": `com.app:id/${text.replaceAll(" ", "_").toLowerCase()}`,
      bounds: { left: 100, top, right: 300, bottom },
    },
  });
  return {
    hierarchy: {
      node: {
        $: {},
        node: [
          node("Continue as Guest", 160, 190),
          node("Partly Covered", 130, 170),
          node("Above Keyboard", 20, 50),
        ],
      },
    },
    windows: withIme
      ? [
          {
            hierarchy: {
              node: {
                $: { extras: { "automobile:imePackage": "com.google.android.inputmethod.latin" } },
                node: [
                  {
                    $: {
                      text: "Q",
                      clickable: true,
                      "resource-id": "com.google.android.inputmethod.latin:id/key_pos_q",
                      bounds: { left: 0, top: 150, right: 400, bottom: 230 },
                    },
                  },
                ],
              },
            },
          },
        ]
      : [],
  };
}

/** Equal-bounds app text and anonymous clickable IME key from separate windows. */
export function sharedBoundsImeHierarchy(): ViewHierarchyResult {
  const bounds = { left: 100, top: 160, right: 300, bottom: 190 };
  return {
    hierarchy: {
      node: {
        $: {},
        node: [{ $: { text: "Continue as Guest", bounds } }],
      },
    },
    windows: [
      {
        hierarchy: {
          node: {
            $: { extras: { "automobile:imePackage": "com.example.keyboard" } },
            node: [{ $: { text: "Q", clickable: true, bounds } }],
          },
        },
      },
    ],
  };
}
