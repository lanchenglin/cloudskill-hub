# Changelog

## 0.2.1 — 2026-10-09

### Fixed
- Validate archive metadata, byte limits and file layout before starting binary downloads in CLI and browser. Reject missing, non-integer and out-of-policy bounds.
- Return the stored visibility of upload sessions; CLI and browser refuse a resumed session with conflicting requested visibility.
- Cancel the input and known-length stream when R2 throws before consuming the body, including backpressure failure paths.
- Restore deleted managed directories with `--force` even when the cloud digest has not changed.
- Skip unchanged ZIP transfers during sync/update after checking local ownership and fingerprints. Explicit install still validates remote bytes; dry-run never downloads archives.
- Refresh installed version metadata when a new version reuses identical verified content.

### Tests / upgrade
- Seven regression tests first reproduced the failures, then passed after the fixes; the complete local suite is 40/40 passing.
- No schema or credential changes. Upgrade Worker and CLI together; the upload protocol remains version 2.

## 0.2.0 — 2026-10-09

### Added
- Directory and bounded STORE/DEFLATE ZIP import in browser and CLI.
- Default 50 MiB total / 20 MiB file / 1000 files with shared configurable policy and server capabilities.
- Authenticated binary upload sessions; canonical ZIP streaming verification to private R2.
- Full archive and per-file SHA-256, CRC32, ZIP/path safety, version compare-and-swap and idempotent finalize.
- Progress, cancellation, completed-archive session recovery and bounded scheduled cleanup.
- Immutable version ZIP and individual-file reads for v2 packages; legacy v1 reading retained.
- Ubuntu/Windows tests, native local workerd/D1/R2 test, and Chromium browser integration.

### Fixed
- Local install-state failure now restores the prior directory or removes an untracked first installation.
- Backups stay outside Agent-readable skills folders and on the destination filesystem.
- Historical rollback retains format and description; public historical archives respect current private visibility.
- Long commands/filenames no longer force mobile upload grids wider than 320/390 px viewports.

### Upgrade notes
- Apply `migrations/0002_binary_uploads.sql` before deploying this code.
- Update each CLI: old clients receive HTTP 426 for v2 packages instead of a large base64 JSON response.
- Legacy JSON publishing limits are unchanged; use the v2 browser/CLI for larger uploads.
- No production Cloudflare deployment or byte-level multipart resumption is included in this release.

## 0.1.0 — 2026-10-09

Initial independent Cloudflare Worker/D1/R2 registry, Chinese dashboard, scoped tokens, versioned skills, public discovery and multi-agent global CLI installation.
