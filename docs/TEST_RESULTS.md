# v0.1.0 test report (2026-10-09)

Environment: Node.js 22.16.0, Linux sandbox, Node experimental `node:sqlite` adapter used to simulate Cloudflare D1 query semantics, in-memory R2 object store.

```
$ npm run check
8 tests passed, 0 failed
```

Covered:

1. Valid SKILL.md metadata and Hermes-specific YAML passthrough.
2. Reject path traversal, hidden secret paths and invalid base64.
3. Deterministic ZIP archive structural tests.
4. YAML folded description handling.
5. Private permissions, scoped client tokens, admin actions, public discovery, history and rollback.
6. Public slug uniqueness and upload safety validation.
7. Restrictive CSP on static dashboard HTML.
8. Local Claude Code, Codex, Hermes installs, update detection, local modifications, backup and sync heartbeat.

Independent Python `zipfile.ZipFile.testzip()` verified ZIP data and UTF-8 filenames.

Not validated here:

- Actual Cloudflare Workers / D1 / R2 production deployment (requires account access and Wrangler network installation).
- Native Windows / WSL clients beyond Node's cross-platform path logic and Linux mock filesystem.
- Live Hermes CLI `well-known` install and `npx skills` behavior against a deployed public domain.
- Multi-admin concurrent publishing load tests, actual WAF settings, durability and recovery of Cloudflare resources.
- Browser visual review in a real mobile/desktop browser.

Before claiming a production-ready stable release, run real end-to-end deployment and security verification on a private staging domain.
