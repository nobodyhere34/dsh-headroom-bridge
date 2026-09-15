# Reference: in-tree headroom-bridge tests (archived 2026-09-04)

These specs were copied from the in-tree mirror at
`deepseek-harness/packages/compaction/headroom-bridge/tests/` **before that
directory was removed** from the harness workspace.

Why they are here and not runnable in this repo:

- That mirror was an early iteration named with the official `@deepseek-ai/`
  scope and is now retired. The standalone `@nobodyhere34/dsh-headroom-bridge`
  is the source of record (see the repo README).
- The specs were written against the 0.1.1-rc.2 session/settings/client APIs
  (`session.events`, `installSettingsSection`, `@deepseek-ai/dsh-client-runtime`)
  and will not compile against the current mainline as-is.

They are preserved as reference for the client card, loader-composition,
surface, and store coverage that the standalone's `tests/` (plain `.test.js`)
does not carry. Port the worthwhile cases into `tests/` before deleting this
directory.
