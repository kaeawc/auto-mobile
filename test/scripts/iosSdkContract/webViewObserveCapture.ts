/** Trimmed verbatim nodes from scratch/observe-raw-artifact.json (iOS 26.5).
 * Omitted native controls and rawViewHierarchy; retained WKWebView ancestry and all DOM nodes.
 */
export const webViewObserveCapture = {
  backend: "sdk",
  viewHierarchy: {
    hierarchy: {
      node: {
        $: {
          text: "Playground",
          class: "XCUIApplication",
          bounds: [0, 0, 402, 874],
          "view-id": "s2-7d46d77b0892ea97",
        },
        extras: {
          "sdk.gestureRecognizers":
            "_UISystemGestureGateGestureRecognizer(enabled),_UISystemGestureGateGestureRecognizer(enabled),_UIHomeAffordanceGateGestureRecognizer(enabled),UITapGestureRecognizer(enabled)",
          "sdk.hasTapTarget": "true",
        },
        node: [
          {
            $: {
              class: "WKWebView",
              bounds: [0, 0, 402, 874],
              scrollable: "true",
              "view-id": "s2-5058bbc337e55b1b",
            },
            extras: {
              "automobile:iosWindowLayer": "1",
            },
            node: [
              {
                $: {
                  class: "WKWebView",
                  bounds: [0, 0, 402, 874],
                  scrollable: "true",
                  "view-id": "s2-761202bac9b2d23c",
                },
                node: [
                  {
                    $: {
                      class: "WKWebView",
                      bounds: [0, 0, 402, 874],
                      scrollable: "true",
                      "view-id": "s2-8126d1dbaca744ae",
                    },
                    node: [],
                  },
                ],
              },
              {
                $: {
                  class: "button",
                  role: "button",
                  enabled: "true",
                  "content-desc": "Contract web increment",
                  clickable: "true",
                  bounds: [24, 104, 304, 148],
                  "web-view-id": "contract-web-view",
                  "web-snapshot-id": "1794880791261-0.6865114880455381",
                  "web-document-id": "1794880791147-0.6434951571206305",
                  "web-element-id": "contract-web-button",
                  "web-role": "button",
                  "web-origin": "http://127.0.0.1:64677",
                },
                extras: {
                  "sdk.source": "sdkWebBridge",
                },
              },
              {
                $: {
                  class: "status",
                  role: "status",
                  enabled: "true",
                  "content-desc": "Clicks: 0",
                  clickable: "true",
                  bounds: [24, 166, 378, 188],
                  "web-view-id": "contract-web-view",
                  "web-snapshot-id": "1794880791261-0.6865114880455381",
                  "web-document-id": "1794880791147-0.6434951571206305",
                  "web-element-id": "e0",
                  "web-role": "status",
                  "web-origin": "http://127.0.0.1:64677",
                },
                extras: {
                  "sdk.source": "sdkWebBridge",
                },
              },
              {
                $: {
                  class: "input",
                  role: "textfield",
                  focusable: "true",
                  "input-type": "text",
                  enabled: "true",
                  "content-desc": "Contract web input",
                  text: "initial",
                  clickable: "true",
                  bounds: [24, 206, 304, 250],
                  "web-view-id": "contract-web-view",
                  "web-snapshot-id": "1794880791261-0.6865114880455381",
                  "web-document-id": "1794880791147-0.6434951571206305",
                  "web-element-id": "contract-web-input",
                  "web-role": "input",
                  "web-origin": "http://127.0.0.1:64677",
                },
                extras: {
                  "sdk.source": "sdkWebBridge",
                },
              },
            ],
          },
        ],
      },
    },
  },
};
