# Security

webmcp-devtools is a browser extension that inspects the WebMCP tools a page
exposes and lints them. By design it reads data from arbitrary, potentially
hostile pages - tool names, descriptions, schemas, call arguments - and
renders that data in a DevTools panel. Everything is plain JavaScript with no
build step and no runtime dependencies; the panel makes no network requests of
its own.

The trust boundary is page → panel. Page-controlled strings must render inert:
a tool description that gets a script executed in the panel's (privileged)
extension context is the vulnerability that matters most here.

The second boundary is the world bridge. `page-bridge.js` runs in the MAIN
world to read `document.modelContext` where a page-installed one actually
lives; it holds no `chrome.*` access. `content.js` runs in the isolated world,
alone holds the `chrome.runtime` Port, and only relays well-formed,
nonce-carrying, allowlisted message types. A page that can use the bridge to
reach the extension's APIs, or to see anything it couldn't already see, is a
serious report. Note what is NOT a boundary: the handshake nonce is readable
by the page once messages flow, and forged bridge messages can only
misrepresent the page's own tools, which the page could do anyway by
registering them.

Lint bypasses - a malicious tool definition the linter explicitly claims to
catch but grades clean - are security reports too. So is any fail-open you
find: a broken diagnostic path that renders as a clean verdict instead of
saying it did not run.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private
reporting instead:

https://github.com/munzzyy/webmcp-devtools/security/advisories/new

Include what you found, how to reproduce it, and the impact you'd expect.

## Supported versions

Fixes land on main and the latest tag is the supported version (v0.2.0 as of
August 2026). There is no backport policy.
