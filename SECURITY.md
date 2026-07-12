# Security

webmcp-devtools is a browser extension that inspects the WebMCP tools a page
exposes and lints them. By design it reads data from arbitrary, potentially
hostile pages - tool names, descriptions, schemas, call arguments - and
renders that data in a DevTools panel. Everything is plain JavaScript with no
build step and no runtime dependencies; the panel makes no network requests of
its own.

The trust boundary is page → panel. Page-controlled strings must render inert:
a tool description that gets a script executed in the panel's (privileged)
extension context is the vulnerability that matters most here. The content
script also injects a page-world probe to read `document.modelContext`; a page
that can use that probe to reach the extension's APIs, or to see anything it
couldn't already see, is a close second. Lint bypasses - a malicious tool
definition the linter explicitly claims to catch but grades clean - are
security reports too.

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's private
reporting instead:

https://github.com/munzzyy/webmcp-devtools/security/advisories/new

Include what you found, how to reproduce it, and the impact you'd expect.

## Supported versions

Fixes land on the latest tagged version; there's no backport policy.
