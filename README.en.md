# dsh-headroom-bridge

中文 | [English](README.en.md)

A bridge plugin that plugs the [Headroom](https://github.com/headroomlabs-ai/headroom) content-aware compression engine into DeepSeek Harness (dsh): **compress tool results, keep every original retrievable**. It does not modify any dsh core code and mounts through the official plugin channels; every failure path fails open (uncompressed = untouched), and in `audit` mode model-visible content is never changed.

> This is the standalone deployment form of the official mainline package `@deepseek-ai/dsh-headroom-bridge` (`packages/compaction/headroom-bridge`), byte-identical to its source; dual-channel deployment (official dsh-base package + standalone plugin) is covered in Install and the "Official mainline channel" note below.

---

## Who this document is for

- **You already use Headroom** (`headroom proxy` / headroom-ai SDK / MCP server) — jump to the [Headroom veteran overview](#headroom-veteran-overview): how it relates to headroom, the capability mapping, and whether you can point it at your existing proxy.
- **You are a dsh user new to headroom** — read [dsh newcomer guide](#dsh-newcomer-guide): dsh concepts, configuration layers, what it mounts, data flow, and the FAQ.

---

## Headroom veteran overview

### How it relates to headroom

The bridge does **not** bundle headroom — it calls three endpoints of your existing local headroom proxy:

| Endpoint | Purpose |
|---|---|
| `POST /v1/compress` | Compression request: `{ messages: [{role:'tool', tool_call_id, content}], model, config: { mode: 'ccr' } }` — **a single tool message + ccr mode** |
| `POST /v1/retrieve` | Fetch an original from the proxy CCR store by hash (`{ hash } → { original_content }`) |
| `GET /health` | Health check (the card's "Proxy health") |

In other words: **compressors, content routing, and the CCR sqlite all live on the proxy side**; the bridge only decides *when to compress, what to compress, and how to account for it*. Verified against the official `ghcr.io/headroomlabs-ai/headroom:0.36.5-code` image (0.36.x line, that three-endpoint contract).

### Capability mapping: headroom native ↔ bridge

| Headroom native | dsh-headroom-bridge |
|---|---|
| Proxy mode (`headroom wrap claude/codex`, whole-conversation compression) | dsh pipeline hooks: **tool results only** — new results = Arm A (`tools/post-execute`), old oversized results = Arm B (`agent/pre-step` shadow-price reclaim) |
| MCP `headroom_compress` | Not needed: the hooks compress automatically; no compress tool is exposed |
| MCP `headroom_retrieve` | dsh model tool `headroom_retrieve` (local ledger first → proxy `/v1/retrieve` fallback) |
| MCP `headroom_stats` | dsh tool `headroom_stats` + the card's live stats |
| CCR storage (proxy-side sqlite; TTL/capacity per proxy config) | The bridge **additionally** keeps a local content-addressed ledger (`sha256[:24]`, atomic writes, `ccr.ttlMs`/`ccr.maxEntries` configurable, path `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`) — originals stay redeemable even after proxy rows expire/evict |
| Native compression markers (`Retrieve more: hash=…`, `<<ccr:(hash)>>`) | Bridge marker: `[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]` |
| `bypass_header` / `mode=passthrough` | `audit` mode + protection gates (tool exclusion / path globs / error-output protection) |
| Compressor/technique routing (proxy-side config) | The bridge does not intervene: requests carry only `config:{mode:'ccr'}`; compressor choice is entirely the proxy's |

### Can I point it at my existing proxy?

**Yes.** Set `baseUrl` to your proxy (default `http://127.0.0.1:8787`). Two notes:

1. **The bridge sends no bypass/mode request headers** — it posts a standard OpenAI-style message plus `config.mode=ccr`. Proxy configs that rely on request headers for bypass will not trigger; the bridge-side "do not compress" duty is covered by the protection gates (`excludeTools` / `protectPathGlobs` / `protectErrorOutputs` / `audit`).
2. **Native markers are redeemable too**: `headroom_retrieve` takes 8–64-char hex hashes; a native marker's hash resolves through the proxy `/v1/retrieve` fallback when the row is still in the proxy CCR store (otherwise `found:false` with a detail).

### Customizing compression strategy

Configure the **proxy**: compressor selection, content routing, and CCR policy are the proxy's job (official `ProxyConfig` / content router). On the bridge side you control *when and what*: `minChars`, `minSavingsRatio`, the protection gates, and the concurrency gate `maxInflight`.

---

## dsh newcomer guide

### Four concepts first

- **profile**: one dsh instance (e.g. `web`); `dsh plugin --profile web add …` installs the plugin into it; **restart `dsh web`** after.
- **plugin**: an npm-package-shaped artifact (this package + the official mainline package), loaded through the profile's plugin/bundle channels — a host half (node services) and a client half (browser bundle).
- **entry config**: the config given when a plugin is mounted (bundle patch / plugin-manager UI), which is the settings **base layer**.
- **settings layers**: schema defaults → entry config (base) → user layer (`settings.yaml` / writes from the settings card); the card shows "Overridden" when the user layer carries an entry, and "Reset to default" clears it back to base.

### What it mounts (what you get after install)

| Where | What |
|---|---|
| Hooks | `tools/post-execute` (Arm A, compress new results), `agent/pre-step` (Arm B, reclaim old oversized nodes) |
| Model tools | `headroom_retrieve`, `headroom_stats` |
| Settings | `headroom` namespace → Settings → Plugins → Plugin configuration → "Headroom compression" card (hidden while the plugin is disabled) |
| HTTP | `/headroom-bridge/api` (stats / health / ledger/recent; consumed by the card; local web only) |
| Persistence | `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json` (content-addressed original ledger, atomic writes; `ccr.*` restart semantics) |

### Where to change config (three layers)

1. **Entry/plugin layer**: the `dsh plugin --profile web add` config, or a profile patch (official mainline channel) — the base layer;
2. **User layer**: the `headroom` section of `~/.dsh/settings.yaml`, or directly via the settings card — highest priority, hot-applies (`mode`/`enabled`/`baseUrl`/`timeoutMs`/`minChars`/`minSavingsRatio`/`protectErrorOutputs`/`maxInflight` and the arm-B gates);
3. **Restart semantics**: `ccr.*` (ledger path/TTL/capacity) is fixed per fiber — restart to change.

### Data flow and privacy (what happens on one compression)

Tool finishes → protection gates (tool name / path arguments / error output) → minimum-length gate → **the result text is POSTed to your local headroom proxy** (`mode=ccr`) → savings gate (`minSavingsRatio` + strict-shrink) → `live`: the original goes to the local ledger and the model sees compressed text + retrieval marker; `audit`: metering only, content untouched. **No extra model call**; the proxy must be present (default localhost:8787) and content does not leave your machine (unless you point `baseUrl` at a remote host — your call).

### Relation to other dsh compaction mechanisms

- `compaction-basic` / `command-compact`: **history summarization** (when a session gets long) — no overlap with this plugin;
- `compaction-tool-result-pruner`: tool-result **pruning** (drop details, keep essentials) — this plugin does content-aware **compression** (redeemable, lossless-on-demand);
- This plugin's slot: **tool-return cleaner** — compress new results before materialization + shadow-price reclaim of old oversized nodes, originals locally redeemable.

---

## Features

- **Arm A — new-result compression**: a `tools/post-execute` waterfall listener compressing oversized plain-text tool results BEFORE they materialize — `audit` logs potential savings only; `live` stores the original in the ledger and hands the model compressed text + retrieval marker
- **Arm B — old-result reclaim**: an `agent/pre-step` backstop scanning old oversized `tool/result` surface nodes (missed by Arm A: proxy down, transient skip, mode flip) under the **shadow-price protocol** — the log keeps the original (`sourceEventSeqs`), with a `compaction/prune` metering event and a `tool/result` surface replace citing the shadowed node
- **Model tools**: `headroom_retrieve` (local ledger first, proxy `/v1/retrieve` fallback; misses are first-class results, never throws) and `headroom_stats`
- **Web settings card**: live status + recent ledger + hot-editable core fields (staged drafts, one "Save")
- **Local CCR ledger**: content-addressed (`sha256[:24]`) + atomic persistence + TTL/capacity eviction
- **Protection gates**: failed results / strong error-hint prose, source-config path arguments, read-only tools, `headroom_retrieve` itself — never compressed
- **Bilingual UI** (follows the page language)

## Prerequisite: the headroom proxy

The bridge delegates compression entirely to a local headroom proxy (`/v1/compress`, `mode=ccr`). Official image (the proxy serves loopback only; host networking or an equivalent loopback route required):

```bash
docker run -d --name headroom --network host ghcr.io/headroomlabs-ai/headroom:0.36.5-code
```

Any implementation of the same three-endpoint contract works (`baseUrl`). When the proxy is unreachable the bridge fails open: results go in untouched and the card reports the proxy unhealthy.

## Install

### From a local directory

```sh
dsh plugin --profile web add /absolute/path/to/dsh-headroom-bridge
```

### From GitHub (once released)

```sh
dsh plugin --profile web add 'github:<owner>/dsh-headroom-bridge#v0.1.0'
```

### From a tarball

```sh
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-headroom-bridge-0.1.0.tgz
```

**Restart** `dsh web` after installing.

> **Official mainline channel**: the official `@deepseek-ai/dsh-headroom-bridge` ships with `dsh-base` (disabled by default); enable it via a profile patch — see the mainline package README's Usage section.

## Quick start

1. Start the headroom proxy (above)
2. Install and restart `dsh web`
3. **Settings → Plugins → Plugin configuration → Headroom compression**
4. `mode=audit` by default: watch "Attempts / failures" and "Chars saved" to confirm the proxy is healthy and savings are real
5. Switch "Mode" to `live` and **Save** — new results start compressing; old results are reclaimed by Arm B at step boundaries
6. Ask the model to call `headroom_retrieve` when exact originals are needed

## Usage

### The "Headroom compression" card

- **Status block**: running mode, enabled, proxy address, attempts/failures, adopted, chars saved, ledger entries, proxy health (live)
- **Fields**: mode, compression enabled, proxy endpoint, request timeout (ms), minimum length (chars), minimum savings ratio, protect error outputs — "Overridden" badge + reset; staged, committed on Save; read-only deployments show the notice
- **Recent compressions**: ledger entries (hash / tool / character delta / savings %)

### What the model sees (Arm A)

In `live` mode an adopted result is replaced by the proxy's compressed text plus one marker line:

```
[headroom-bridge: 38403->6175 chars offloaded. Retrieve the exact original with headroom_retrieve hash=<hash>]
```

The canonical value is untouched; only the rendered content is replaced, so follow-up calls that need exact bytes can restore them with `headroom_retrieve`.

### Tools

- **headroom_retrieve `{hash}`**: redeem the exact original (local ledger → proxy `/v1/retrieve`), returns `{id, found, content?, toolName?, charsBefore?, charsAfter?, source?, detail?}`
- **headroom_stats `{}`**: `mode/attempts/failures/adopted/savedChars/ledgerEntries`

## How it works

| Layer | Implementation |
|---|---|
| Host | `src/index.ts`: Arm A (`tools/post-execute`), Arm B (`agent/pre-step`), the two tools, the `headroom` settings namespace, `/headroom-bridge/api`, CCR ledger |
| Client | `src/client/index.ts`: card via the official `settings.plugin.item` slot (keyed `headroom`); `CardForm` staging/single save/host read-back |
| Proxy client | `proxy-client.ts`: `POST /v1/compress` (`mode=ccr`), `POST /v1/retrieve`, `GET /health`; timeout / non-2xx / parse failure all fail open |
| Protection gates | tool-name exclusion → path-argument protection → error-output protection → minimum-length gate → savings gate (+ strict-shrink check) |
| Shadow price | Arm B replacing an old node: `compaction/prune` metering first, then a `tool/result` surface replace citing the shadowed seq; the original stays in the log (`sourceEventSeqs`), so replay/fork reconstruct both views |

Compression happens before materialization with no extra model call. **KV cache**: `live` replacing rendered content invalidates cache reuse from the first changed token (the inherent cost of any tool-result rewrite); `audit` matches the baseline exactly.

## FAQ

**Q: The card says the proxy is unhealthy / many failures?**
A: First verify with `curl http://127.0.0.1:8787/health` and `curl -X POST http://127.0.0.1:8787/v1/compress -H 'content-type: application/json' -d '{"messages":[{"role":"tool","tool_call_id":"t1","content":"your long text"}],"model":"test","config":{"mode":"ccr"}}'`; check `baseUrl` and `timeoutMs` (default 30s; raise it for a slow proxy). An unreachable proxy fails open — sessions are unaffected.

**Q: Nothing compresses / no markers?**
A: Walk the gates — `enabled` (master switch), `mode` (audit = metering only), `minChars` (default 500+ chars), `minSavingsRatio` (0.15; below that, not adopted), tool exclusion list (read-only tools excluded by default), `protectPathGlobs` (source/config paths untouched), `maxInflight` (concurrency gate). The card's "Attempts/failures/adopted" and `headroom_stats` show where each candidate stops.

**Q: Completely disable?**
A: Turn off "Compression enabled" in the card and Save (`enabled=false` also unregisters the tools), or set `enabled: false` at the config layer, or uninstall (below). Existing markers stay redeemable with `headroom_retrieve`.

**Q: Uninstall / upgrade?**
A: `dsh plugin --profile web remove dsh-headroom-bridge` (use the actual plugin id) and restart; upgrade = `add` the new version and restart. **The ledger file is not deleted automatically** — clean `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json` manually if you are sure no markers need redeeming.

**Q: `headroom_retrieve` returns `found:false`?**
A: The hash is neither in the local ledger (evicted by `ccr.maxEntries` / expired by `ccr.ttlMs`) nor in the proxy CCR store (row evicted, proxy down, or the hash is not from this proxy's output). The return value carries `detail` (e.g. `proxy returned no content`, `invalid hash format`); hashes are 8–64-char hex (native marker hashes included).

**Q: Does it break session logs / replay / forks?**
A: No — the session event vocabulary never changes; Arm A replaces only the rendered content (the canonical value is untouched); Arm B keeps the original in the log under the shadow-price protocol, citing the shadowed seq.

**Q: KV cache / token billing impact?**
A: No extra model call, no extra tokens (the proxy is a separate process). `live`-mode replacements invalidate the KV cache from the first changed token (the inherent cost of any tool-result rewrite); `audit` is identical to baseline.

**Q: Where is the ledger, how big?**
A: `<DSH_HOME>/storages/dsh-headroom-bridge-ccr.json`, bounded by `ccr.maxEntries` (default 2000) and `ccr.ttlMs` (default 24h), oldest first; `ccr.path` relocates it (restart semantics).

**Q: Do native headroom markers work here?**
A: `headroom_retrieve` resolves by hash (local → proxy fallback) and is marker-format-agnostic — a native marker's hash resolves if the row is still in the proxy CCR store; but the bridge does not parse/translate native markers (the model should use the bridge's own markers with `headroom_retrieve`).

## Limitations

- **The proxy is an external dependency**: unreachable = fail-open; `/v1/compress` serves loopback only; compressor/routing belong to the proxy
- `ccr.*` restart semantics; the other core fields hot-apply
- `audit` is the default — switch to `live` for real token savings
- Read-only tools and source/config path arguments are protected by default; byte-sensitive scenarios stay untouched
- Arm B reclaims *old high-level `tool/result` surface nodes*; the session event vocabulary never changes

## Compatibility

Current version targets DSH `0.1.1-rc.2` (relies on the `tools/post-execute` and `agent/pre-step` hooks, the `settings.plugin.item` slot, and the `ctx.settings` / `ctx.webServer` / `ctx.tools` services); the headroom proxy is verified against the official `0.36.5-code` image (`/v1/compress` + `/v1/retrieve` + `/health`). API changes on either side need a matching adaptation.

## Development

```sh
# Build (DSH_CHECKOUT auto-probed or explicit)
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh   # src → lib (host half)
pnpm run build:client                                            # src/client → lib/client.js
pnpm run typecheck
pnpm run check                                                   # all of the above
```

`lib/` is committed build output; rebuild and commit after any source change, then restart `dsh web` (or validate with whatever hot-mount workflow you use locally).