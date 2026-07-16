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

That covers the pure modules in `core/`, the security linter in `lint.js`, and a structural check on `manifest.json`. It does not cover the rendered panel — that needs a real Chrome window (`chrome.devtools.*` can't run in Node). Load the extension unpacked and open `examples/demo.html` to check panel behavior by hand.

## Adding to the linter

New lint rules live in `lint.js` and land with a test in `tests/lint.test.js`:

- A rule that should fire needs a tool that triggers it.
- A rule change should keep a benign tool clean. A linter that cries wolf on safe tools trains people to ignore it, which is worse than missing an edge case.

Keep every string that comes from a page treated as hostile. Findings must render as text, never as markup (see the render helper in `panel.js`).

## Security surface

Everything a page provides (tool names, descriptions, schemas, annotations) is untrusted. If you touch rendering, confirm it still goes through the text-only helper and never `innerHTML`.

## License

By opening a PR you agree your contribution is offered under the project's MIT license.
