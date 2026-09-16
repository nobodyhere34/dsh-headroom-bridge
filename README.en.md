# dsh-headroom-bridge

Chinese | [English](README.en.md)

A dsh plugin: it sends **tool-result** text to a local [Headroom](https://github.com/headroomlabs-ai/headroom) compression proxy, shows the model the compressed version, and keeps the original in a local ledger where it can be redeemed by hash. No dsh core changes, no bundled headroom. Every failure keeps the original untouched (fail-open). The default mode is `audit`: counters only, zero content changes.

## What it does

| Piece | What it is |
|---|---|
| Hook A (`tools/post-execute`) | After a tool runs and before its result enters the session log: plain-text results long enough are sent to the proxy; if the savings are good enough and mode is `live`, the model-visible content is replaced |
| Hook B (`agent/pre-step`) | At each step boundary, reclaims old oversized results that A missed (proxy down, inflight skip, mode flip). Uses dsh's built-in "replace old content" mechanism: a prune metering event, then a surface replace; the original stays in the log and replay/fork can restore both views |
| `headroom_retrieve {hash}` | Redeem an original by hash: local ledger first, then the proxy |
| `headroom_stats {}` | Show this plugin's compression counters and ledger size |
| Settings card | Settings → Plugins → "Headroom compression": live status, a recent-operations stream (ledger + attempt audit, expandable original-text compare, jump to the source session), 7 editable fields |
| Trajectory chip | A headroom chip at the end of any turn that compressed: N compressions this turn, before→after bytes, per-item expand to see the original and the compression type (the compressed form is the tool row just above) |
| Local ledger | `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.db` (SQLite, zero external deps); originals stored by content hash (sha256, first 24 hex chars) with session/callId lineage and compression type; default fresh window 24h, 64 MiB original budget — over it originals demote to metadata (lineage kept) |

`audit` vs `live`: audit really calls the proxy to measure compression, but changes nothing (use it to check whether it's worth enabling); live is the mode that actually replaces content.

## Prerequisite

Run a headroom compression proxy locally (default `http://127.0.0.1:8787`; verified with the official 0.36.5-code and 0.37.0-code images):

```bash
# Recommended for 0.37: --no-ccr disables proxy-side CCR (the bridge keeps its own ledger); HF_HOME as a volume to warm the kompress models
docker run -d --name headroom --network host -e HF_HOME=/root/.headroom/hf-cache \
  -v ~/.dsh/headroom-proxy/headroom-dotdir:/root/.headroom \
  ghcr.io/headroomlabs-ai/headroom:0.37.0-code \
  --host 0.0.0.0 --port 8787 --no-ccr
```

The bridge uses exactly three endpoints: `POST /v1/compress` (one tool message, `mode: 'ccr'`), `POST /v1/retrieve`, `GET /health`. Any implementation of that contract works (point `baseUrl` at it). Compressor and content-routing policy are configured on the proxy. The proxy serves loopback only, so the container needs host networking or an equivalent loopback route.

## Install

```sh
dsh plugin --profile web add /path/to/dsh-headroom-bridge                 # local directory
dsh plugin --profile web add 'github:nobodyhere34/dsh-headroom-bridge#v0.2.0'  # GitHub tag
pnpm pack && dsh plugin --profile web add ./dsh-headroom-bridge-0.1.3.tgz # tarball
```

Then **restart `dsh web`**.

> The dsh mainline once planned a functionally aligned official package (`packages/compaction/headroom-bridge`), but as of dsh 0.1.5-rc.2 it was **never merged into any release** and no such package exists in the current mainline tree. This repo is the only install channel.

## Quick start

1. Start the proxy (above)
2. Install the plugin, restart dsh web
3. Open Settings → Plugins → Headroom compression: check "Proxy health" ✓, run a few long tool results and watch the counters
4. Switch mode to `live`, save — new results start compressing; old oversized results are reclaimed gradually by hook B
5. When you need an original: have the model call `headroom_retrieve` with the hash from the marker, or expand the compare in the card's "Recent operations" / the trajectory chip

After a live adoption, the model sees the compressed text plus one marker line:

```
[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]
```

## Configuration

Three layers: schema defaults → entry config (the `config:` block in `cordis.patch.yml`; in-package default is `mode: audit` + default proxy URL) → user layer (the settings card, or the `headroom` section of `~/.dsh/settings.yaml`). The user layer wins.

The 7 fields the card edits (effective immediately after saving):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `audit` | audit / live |
| `enabled` | `true` | master switch, **read once at plugin load** (changing it at runtime takes effect on the next plugin load) |
| `baseUrl` | `http://127.0.0.1:8787` | proxy address |
| `timeoutMs` | 30000 | per-request timeout |
| `minChars` | 500 | skip results shorter than this (Unicode code points) |
| `minSavingsRatio` | 0.15 | don't adopt when savings are below this fraction |
| `protectErrorOutputs` | `true` | don't compress error output |

Fields the card does not expose: `excludeTools` (default excludes 12 tools such as read/grep/glob/edit), `protectPathGlobs` (default skips results whose tool arguments hit source/config paths), `maxInflight` (concurrency cap, default 2), `armB.*`, `ccr.*` — change them in the entry config or `settings.yaml`. **Full field list, defaults, hot-vs-reload semantics, and the complete gate rules: [docs/CONFIG.md](docs/CONFIG.md).**

## Will a result be compressed (hook A, checked in order)

1. The tool is `headroom_retrieve` itself → no
2. The tool is in `excludeTools` → no
3. The result is an error output (isError, or a strong error marker within 8000 chars) and `protectErrorOutputs` is on → no
4. The content has any non-text block (an image, etc.) → the whole result is skipped
5. Length < `minChars` → no
6. It already carries a compression marker (including headroom native markers) → no (prevents double compression)
7. Tool arguments hit `protectPathGlobs` → no
8. This call was already attempted → not retried
9. Proxy requests in flight reached `maxInflight` → skipped (counted as a failure)

Only then is the proxy called; if the returned savings are ≥ `minSavingsRatio`, strictly shorter than the original, and mode is `live` → **the original is written to the ledger first**, then the model gets "compressed text + marker". The canonical value dsh records is untouched; only the model-visible content changes.

## Subagents

- In-process `subagent` / `subagent_fork` children run in the same plugin instance as the parent: their tool results are compressed the same way, and their originals go into the same ledger
- A child's final report returns to the parent as a `subagent` tool result; the default exclusion list does **not** include `subagent`, so the report itself can be compressed too (policy pending — docs/PLAN.md D2)
- External claude-code/codex/ACP processes: only the final report is visible

## Storage and cleanup

- Ledger: `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.db` (`DSH_HOME` defaults to `~/.dsh`), SQLite (WAL), shared across sessions, deduped by content. A legacy `.json` is auto-imported once and renamed `.imported`
- Bounded retention: `ccr.maxBytes` (default 64 MiB) / `ccr.maxEntries` (default 2000) / `ccr.ttlMs` (default 24h fresh window). Over budget or past the window, **originals demote to metadata** (`degraded`) — lineage, compression type and before/after counts stay; only the full text stops being retrievable. Least-recently-seen first
- Lifecycle coupling: compaction triggers an immediate retention pass; `ccr.gcIntervalMs` runs periodic GC; **session-deletion cascade** (works with dsh-session-manager — trashing a session clears its ledger rows)
- Uninstalling does **not** delete the ledger. To clean up fully, delete the file by hand (make sure no marker still needs redeeming)

## Related plugins

Two other open-source dsh plugins do the same "compress tool results + CCR retrieval" with different architecture choices:

| Plugin | Where compression runs | Main difference vs this project |
|---|---|---|
| [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor) | in-plugin (native Rust crushers) | no external proxy dependency; pitched on leaving the sent prefix untouched (KV-cache friendly); no settings card / audit mode |
| [giter00/dsh-headroom](https://github.com/giter00/dsh-headroom) | in-plugin (JS + ONNX scorer) | content-routed specialized compressors (JSON/table/log each); this project delegates compression strategy to the proxy |

This project's trade: compressors, content routing, and CCR storage all live on the proxy side (swappable/upgradeable without touching the plugin); the plugin only decides *when to compress, what to compress, and how to account for it*. The cost: the proxy is a hard dependency.

## Known limitations

- The proxy is a hard dependency: if it's down, everything is fail-open and results pass through (sessions unaffected; the card shows unhealthy)
- Default is `audit`; you must switch to `live` to save tokens
- `enabled` is a load-time switch: false at load → the plugin mounts nothing (no hooks, no tools, no card); turning it off on the card does not stop the currently running instance
- Changes to `ccr.*` require a plugin reload; `excludeTools` / `protectPathGlobs` hot-edit takes effect immediately (both arms resync per candidate). **An empty array `[]` always falls back to the built-in default list** (the protection gate can never be emptied; neutralize an entry with an unused placeholder instead) — malformed entries still fail loud
- `live` + `ccr.enabled: false` = zero adoption (adoption asserts the original is in the ledger first; with the ledger off it always fails) — don't configure it that way
- Read-family tools and source/config-path results are not compressed by default (byte-sensitive scenes stay verbatim)
- KV cache: a `live` replacement invalidates the cache from the first changed token (a cost shared by any tool-result rewrite); `audit` has no impact
- The proxy request carries the full result text: pointing `baseUrl` at a remote sends content off your machine, at your own risk
- There is no CI; tests are 9 unit suites / 52 cases (mocked proxy/session, temp SQLite ledger, fake-ctx lifecycle, real event-stream projection replay) plus `pnpm run smoke` (bundle mount smoke); cascade/reconcile/endpoints carry separate live verification (see CHANGELOG)

## Compatibility

- **Node**: the ledger uses `node:sqlite` (built into Node **≥ 22.5**, zero external deps; 22.x emits an ExperimentalWarning, harmless). On lower versions the plugin fails to load (module missing) — don't install there
- DSH: the current code is adapted to and verified against mainline **dsh-v0.1.5-rc.2** (typecheck + 52 unit tests green). The adaptation uses rc.2-only interface shapes (`SessionSeq`/`snapshotEvents()`/`eventAt()`, `surfaceOp: {op:'replace', startSeq, endSeq}`, `ctx.settings.installSection`, the `@deepseek-ai/cordis` package name) and **no longer supports 0.1.2-rc.1 or earlier** — those call sites fail outright on older hosts
- headroom proxy: official `0.36.5-code` and `0.37.0-code` **both verified**. On 0.37 note: ① the bridge's `/v1/compress` request shape (single tool message) is unchanged and #3286 subagent-output garbling is fixed (Chinese/code fences/JSON keys all preserved in tests); ② the standalone endpoint no longer mints proxy-side CCR (`ccr_hashes` stays empty — the bridge's local ledger was always the authoritative redemption path, unaffected); ③ a new router reversibility gate skips lossy compression that cannot attach a proxy marker — **run the proxy with `--no-ccr`** (the bridge carries its own ledger and markers). Also 0.37 routes prose through the kompress neural model (needs HuggingFace reachability to warm `chopratejas/kompress-v2-base` + `answerdotai/ModernBERT-base`; without them prose/log content passes through unchanged)
- This repo is at 0.2.0 (GitHub tag `v0.2.0`); 0.1.0 was the untagged initial form — don't read compatibility off its peer declarations

## FAQ

**Q: I expected compression but see no marker?**
A: Walk the 9 steps in "Will a result be compressed"; the card's "attempts/failures/adopted" and `headroom_stats` show where it stopped. Also: `audit` mode never produces markers; results containing non-text blocks are never compressed; hook B's length gate is `armB.thresholdChars` (default 16384), far above A's.

**Q: `headroom_retrieve` returns found:false?**
A: The result carries a `detail` naming the case, and the three are told apart: **original demoted** past the fresh window or over budget (the detail quotes the retained lineage — tool name, before/after chars, compression type: the row is still in the ledger, only the full text is gone); **session deleted and cascaded** (the lineage is gone too); **hash never in the ledger** (falls back to the proxy: proxy-side row evicted / proxy down / the hash isn't the proxy's). The hash must be 8–64 hex chars.

**Q: How do I turn it off completely?**
A: Uninstall, or set `enabled: false` in the load config (turning it off on the card works too, but it takes effect on the next load). Markers produced earlier remain redeemable while the ledger still holds their entries.

**Q: Does it break logs / replay / fork?**
A: No. A changes only model-visible content; the recorded value is unchanged. B keeps the original in the log and references it, so replay/fork can restore both views.

## Development

Build, test, hot-assembly, and release workflow: [docs/DEV.md](docs/DEV.md). Quick reference:

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src → lib (host half)
pnpm run build:client                                           # src/client → lib/client.js
pnpm run typecheck
node --test tests/*.test.js                                     # unit test suites (or npm test)
```

`lib/` is a **committed build artifact**: after changing sources, rebuild and commit lib along with them.

## License

[MIT](LICENSE)

This project's compression approach references [Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0), but copies and ports none of its source code — compression is executed entirely by an external Headroom-compatible proxy over HTTP; the plugin only decides when to compress, what to compress, and how to account for it. Attribution: [NOTICE](NOTICE).

## Acknowledgements

The design and compression strategy reference [Headroom](https://github.com/headroomlabs-ai/headroom) (Apache-2.0).
