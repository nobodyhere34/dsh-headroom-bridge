/**
 * Trajectory compression chip: a turn-tail chain entry elected by the
 * headroom turn-data projection (headroom-turn.ts). It shows what the bridge
 * compressed inside one closed turn - per-result compression type (the
 * proxy's transforms chain, fetched lazily), before→after accounting, and an
 * expandable view of the exact original text from the ledger (the compressed
 * form is the tool row above in the transcript). Demoted originals render an
 * expired note instead: retrieval demand lives inside the context window,
 * the metadata stays honest about the rest.
 */

import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeadroomTurnData, HeadroomHit } from '../turn-projection.ts'
import css from './CompressChip.module.css'

/** Copy accessor bound to the card's dictionary namespace. */
type T = PropsLocale<'settings.plugins.headroom'>['t']

const API = '/headroom-bridge/api'

interface EntryPayload {
  ok: boolean
  error?: string
  meta?: { strategy?: string; charsBefore?: number }
  originalText?: string
}

function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

/** One expandable result row: type, accounting, and the original compare. */
function ChipRow({ hit, t }: { hit: HeadroomHit; t: T }) {
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<EntryPayload | null | 'loading'>('loading')
  useEffect(() => {
    if (!open) return
    let alive = true
    fetch(`${API}/ledger/entry?hash=${encodeURIComponent(hit.hash)}`)
      .then(res => res.json().then((d: EntryPayload) => ({ status: res.status, d })))
      .then(({ d }) => { if (alive) setPayload(d) })
      .catch(() => { if (alive) setPayload({ ok: false }) })
    return () => { alive = false }
  }, [open, hit.hash])
  const pct = hit.charsBefore > 0 ? Math.round((1 - hit.charsAfter / hit.charsBefore) * 100) : 0
  const typeChain = (payload?.meta?.strategy ?? '')
    .split('>').filter(s => s.length > 0).map(s => s.split(':').slice(0, 2).join(':')).join(' › ')
  return (
    <div className={css.row}>
      <button type="button" className={css.rowHead} onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className={css.rowTool}>{hit.toolName || hit.callId.slice(0, 8)}</span>
        <span className={css.rowType}>{typeChain || '—'}</span>
        <span className={css.rowSize}>{`${fmt(hit.charsBefore)} → ${fmt(hit.charsAfter)} (-${String(pct)}%)`}</span>
        <span className={css.rowCaret} aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className={css.rowBody}>
          {payload === 'loading' && <p className={css.note}>…</p>}
          {payload !== null && payload !== 'loading' && !payload.ok && (
            <p className={css.note}>{payload.error === 'original expired' ? t('chipExpired') : t('chipUnavailable')}</p>
          )}
          {payload !== null && payload !== 'loading' && payload.ok && (
            <>
              <p className={css.note}>{t('chipOriginal', { count: payload.meta?.charsBefore ?? hit.charsBefore })}</p>
              <pre className={css.pre}>{payload.originalText}</pre>
            </>
          )}
          <p className={css.meta}>{`hash ${hit.hash.slice(0, 12)} · seq ${String(hit.seq)}`}</p>
        </div>
      )}
    </div>
  )
}

/** Props the chain renderer receives: the elected match plus session-seat copy. */
export interface CompressChipProps extends PropsLocale<'settings.plugins.headroom'> {
  matched: HeadroomTurnData
}

/**
 * Render the compression chip for one closed turn.
 * @param props - the elected headroom match and bound copy.
 * @returns the chip element.
 */
export function CompressChip({ matched, t }: CompressChipProps) {
  const [expanded, setExpanded] = useState(false)
  const rows = matched.hits
  const before = rows.reduce((s, r) => s + r.charsBefore, 0)
  const after = rows.reduce((s, r) => s + r.charsAfter, 0)
  const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0
  return (
    <div className={css.root}>
      <button type="button" className={css.head} onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
        <span className={css.badge}>headroom</span>
        <span>{t('chipCount', { count: rows.length, before: fmt(before), after: fmt(after), pct })}</span>
        <span className={css.caret} aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && rows.map(hit => <ChipRow key={hit.hash + String(hit.seq)} hit={hit} t={t} />)}
    </div>
  )
}
