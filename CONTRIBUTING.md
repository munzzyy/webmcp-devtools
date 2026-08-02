# Contributing

Thanks for looking at this. It's a small, single-purpose tool and contributions are welcome.

## Setup

```
git clone https://github.com/munzzyy/webmcp-devtools
cd webmcp-devtools
```

Nothing to install. It's plain JavaScript with no dependencies, and the tests use Node's built-in runner.

## Running the tests

```
node --test
```

That covers the pure modules in `core/`, the security linter in `lint.js`, structural checks on `manifest.json`, and the real `panel.js`, `content.js`, and `page-bridge.js` driven against fakes (`tests/panelHarness.js` and `tests/worldHarness.js` fake exactly the DOM and `chrome.*` surface those files touch). `WEBMCP_E2E=1 node --test tests/bridge.e2e.test.js` additionally drives the real extension in headless Chromium. For anything touching the panel's rendering or the background relay, also load the extension unpacked and open `examples/demo.html` to check it by hand.

## Adding to the linter

New lint rules live in `lint.js` and land with a test in `tests/lint.test.js`:

- A rule that should fire needs a tool that triggers it.
- A rule change should keep a benign tool clean. A linter that cries wolf on safe tools trains people to ignore it, which is worse than missing an edge case.

Keep every string that comes from a page treated as hostile. Findings must render as text, never as markup (see the render helper in `panel.js`).

## Security surface

Everything a page provides (tool names, descriptions, schemas, annotations) is untrusted. If you touch rendering, confirm it still goes through the text-only helper and never `innerHTML`.

## License

By opening a PR you agree your contribution is offered under the project's MIT license.
