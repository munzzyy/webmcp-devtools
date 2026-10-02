# Changelog

## Unreleased

Changes on main since [v0.2.0](https://github.com/munzzyy/webmcp-devtools/compare/v0.2.0...main).

- The license is now GPL-3.0-or-later. Releases up to v0.2.0 stay under MIT.
- A "Copy findings as JSON" button copies the whole audit to the clipboard. It lists every frame with its bridge health and read errors, and every tool with its full definition and findings. A frame the panel could not inspect never reads as clean.
- Two lint rules from the webmcp-lint CLI: a tool that handles outside content without `untrustedContentHint`, and Chrome's size budgets for names and descriptions.
- A page that freezes its tool descriptors, or makes `execute` read-only, no longer gets an error from `registerTool` just because the extension is installed. Calls to those tools still show in the timeline.
- The panel works against Chrome's native WebMCP. Tools keep their ids across listings, and Execute sends the arguments as the JSON string native expects and shows the decoded result.
- A page that swaps in a new definition under a tool name it already used gets the high "changed after registration" finding instead of a quiet added and removed pair, and Execute waits until the tool is selected again. On native WebMCP the swap is an abort and a new `registerTool` in the same task. A polyfill with `getTools()` that replaces the tool when the name is registered again counts too.
- A tool registered in one frame and listed by every frame shows up once, under the frame that registered it. A tool from a frame the extension can't reach, like a `srcdoc` iframe, is listed once and marked as coming from another frame.
- A tool with a BigInt or a circular reference in it no longer hides the rest of its frame's tool list. It shows up with a finding that says it could not be relayed intact.
- The linter scans every string and key in the input schema and the tool's title. It used to read only descriptions and a few other keys.
- Closed several ways to hide text from the linter with Unicode, such as look-alike letters and invisible characters it did not know about.
- Detects OpenAI project and service-account keys and GitHub fine-grained tokens.
- Risky free-form parameters are found at any depth in the schema. A `$ref` parameter is judged by what it points to.
- `node tools/serve-demo.js` serves the demo page on 127.0.0.1. The demo also works with Chrome's WebMCP flag on now. It used to fail there before registering anything.
- A page that floods the panel with calls no longer freezes it.
- Keyboard focus stays in the tool table across updates. The selected row is marked with `aria-current`. Screen readers no longer hear an unchanged status bar again and again.
- The security policy names the supported tag.
- CI tests on Node 22, 24 and 26. Node 20 reached end of life.
- CI also runs the end-to-end test in Chrome for Testing, and a skip there fails the job.
- Two more end-to-end tests run against Chrome's native WebMCP. One covers a page and its iframe, the other a page that aborts a tool and registers it again.

## v0.2.0 (2026-08-02)

First tagged release, under MIT.

- A WebMCP panel in DevTools with a live tool table, per-tool security diagnostics and a call-history timeline.
- The linter flags prompt injection and hidden Unicode in a tool's metadata. It also flags code execution, data-collection endpoints, hardcoded secrets, over-broad text parameters and read-only mismatches.
- A MAIN-world bridge reads `document.modelContext` in the page's own world. So a polyfill the page installs itself is visible too.
- Mid-session change detection. Added, removed and re-framed tools land in the timeline. A changed definition gets a high finding, and Execute refuses a tool that changed since you selected it.
- Tool calls the page makes itself show up in the timeline.
- The status bar says when the bridge is dead, the page uses the old `navigator.modelContext`, `getTools()` is missing, a read failed or the connection dropped. None of these show up as an empty page.
- `node tools/demo-lint.js` runs the linter on the demo tools without Chrome.
