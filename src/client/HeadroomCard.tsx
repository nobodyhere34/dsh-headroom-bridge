/**
 * The headroom bridge's settings card: the configurable-plugins card under
 * the 'headroom' namespace. It stages the hot bridge fields (mode, enabled,
 * proxy endpoint, budgets, and failed-result protection) through the same
 * PluginCard + staged-form machinery the shipped Shell / Agent loop / Web
 * search cards use, and shows live bridge stats and the recent compression
 * ledger fetched from the Host's /headroom-bridge/api routes.
 */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeadroomCardFace } from './headroom-card-controller.ts'
// Type-only: pulls the section package's 'settings.plugin.item' slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { SelectField, SwitchField, ValueField } from './fields.tsx'
import type { HeadroomCardLocaleKey } from './locales.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './HeadroomCard.module.css'

/** Props the renderer binds for the headroom card. */
export type HeadroomCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins.headroom'>
  & InjectFace<HeadroomCardFace>

/** Stats payload served by the Host /stats route. */
interface StatsPayload {
  ok: boolean
  mode?: string
  enabled?: boolean
  baseUrl?: string
  counters?: { attempts: number; failures: number; adopted: number; savedChars: number }
  ledger?: { entries: number; hits: number; misses: number; writes: number }
  error?: string
}

/** One merged activity row as served by /ledger/activity. */
interface ActivityRow {
  kind: 'ledger' | 'audit'
  ts: number
  toolName: string
  callId: string
  sessionId: string
  state: string
  reason: string
  charsBefore: number
  charsAfter: number
  strategy: string
  hash: string
  originalAvailable: boolean
  seq: number | null
}

/** One expanded entry payload as served by /ledger/entry. */
interface EntryPayload {
  ok: boolean
  error?: string
  meta?: { strategy?: string; charsBefore?: number }
  originalText?: string
}

const API = '/headroom-bridge/api'

/** Expandable original-text body for one activity row. */
function OriginalBody({ hash }: { hash: string }) {
  const [payload, setPayload] = useState<EntryPayload | null | 'loading'>('loading')
  useEffect(() => {
    let alive = true
    fetch(API + '/ledger/entry?hash=' + encodeURIComponent(hash))
      .then(res => res.json())
      .then((d: EntryPayload) => { if (alive) setPayload(d) })
      .catch(() => { if (alive) setPayload({ ok: false }) })
    return () => { alive = false }
  }, [hash])
  if (payload === 'loading') return <p className={css.statNote}>{/* spinner */}…</p>
  if (payload === null || !payload.ok) {
    return <p className={css.statNote}>{payload?.error === 'original expired' ? '（原文已出窗降级，仅保留元数据）' : '（原文不可用）'}</p>
  }
  return <pre className={css.pre}>{payload.originalText}</pre>
}

/** Live bridge stats + proxy health block. */
function StatsSection({ t }: { t: (key: HeadroomCardLocaleKey, params?: Record<string, unknown>) => string }) {
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [healthy, setHealthy] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(API + '/stats')
      .then(res => res.json())
      .then((d: StatsPayload) => {
        if (!alive) return
        setStats(d)
        setError(d.ok ? null : String(d.error))
      })
      .catch(() => { if (alive) setUnreachable(true) })
    fetch(API + '/health')
      .then(res => res.json())
      .then((d: { ok: boolean; healthy?: boolean }) => { if (alive && d.ok) setHealthy(d.healthy ?? null) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const rows = stats === null ? [] : [
    { label: t('statsMode'), value: stats.mode ?? '' },
    { label: t('statsEnabled'), value: String(stats.enabled ?? '') },
    { label: t('statsProxy'), value: stats.baseUrl ?? '' },
    { label: t('statsAttemptsFailures'), value: String(stats.counters?.attempts ?? 0) + ' / ' + String(stats.counters?.failures ?? 0) },
    { label: t('statsAdopted'), value: String(stats.counters?.adopted ?? 0) },
    { label: t('statsSavedChars'), value: String(stats.counters?.savedChars ?? 0) },
    { label: t('statsLedgerEntries'), value: String(stats.ledger?.entries ?? 0) },
    { label: t('statsHealth'), value: healthy === null ? t('healthUnknown') : String(healthy) },
  ]
  return (
    <section className={css.block} aria-label={t('statusTitle')}>
      <h4 className={css.blockTitle}>{t('statusTitle')}</h4>
      {unreachable ? <p className={css.statError} role="status">{t('statsUnreachable')}</p>
        : error !== null ? <p className={css.statError} role="status">{t('statsFailed', { message: error })}</p>
          : stats === null ? <p className={css.statNote}>{t('statsLoading')}</p>
            : (
              <div>
                {rows.map(row => (
                  <div key={row.label} className={css.statRow}>
                    <span className={css.statLabel}>{row.label}</span>
                    <span className={css.statValue}>{row.value}</span>
                  </div>
                ))}
              </div>
            )}
    </section>
  )
}

/** Recent operations: merged ledger + audit stream with expandable originals. */
function LedgerSection({ t, openSession }: { t: (key: HeadroomCardLocaleKey) => string; openSession?: (id: string, callId?: string) => void }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [openHash, setOpenHash] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    fetch(API + '/ledger/activity?limit=20')
      .then(res => res.json())
      .then((d: { ok: boolean; rows?: ActivityRow[] }) => {
        if (alive && d.ok && Array.isArray(d.rows)) setRows(d.rows)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  return (
    <section className={`${css.block} ${css.ledger}`} aria-label={t('ledgerActivity')}>
      <h4 className={css.blockTitle}>{t('ledgerActivity')}</h4>
      {rows === null ? null
        : rows.length === 0 ? <p className={css.statNote}>{t('ledgerEmpty')}</p>
          : (
            <div>
              {rows.map((row, i) => {
                const saved = row.charsBefore - row.charsAfter
                const pct = row.charsBefore > 0 ? Math.round(saved / row.charsBefore * 100) : 0
                const key = row.hash !== '' ? row.hash : row.kind + String(row.ts) + String(i)
                const clickable = row.kind === 'ledger' && row.originalAvailable
                return (
                  <div key={key} className={css.ledgerRow}>
                    <button
                      type="button"
                      className={css.ledgerHead}
                      disabled={!clickable}
                      onClick={() => setOpenHash(openHash === key ? null : key)}
                      aria-expanded={openHash === key}
                    >
                      <span className={css.ledgerHash}>{row.kind === 'ledger' ? row.hash.slice(0, 10) : row.state}</span>
                      <span>{row.toolName}</span>
                      {row.strategy !== '' && <span title={row.strategy}>{row.strategy.split('>').map(s => s.split(':')[0] ?? s).join('›')}</span>}
                      {row.kind === 'ledger'
                        ? <span>{`${String(row.charsBefore)}->${String(row.charsAfter)} (-${String(pct)}%)`}</span>
                        : <span title={row.reason}>{row.state === 'not-adopted' ? `-${String(pct)}% ${row.reason}` : row.state}</span>}
                      {openSession !== undefined && row.sessionId !== '' && (
                        <span
                          role="link"
                          tabIndex={0}
                          className={css.sessionLink}
                          title={row.sessionId}
                          onClick={(e) => { e.stopPropagation(); openSession(row.sessionId, row.callId) }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); openSession(row.sessionId, row.callId) } }}
                        >↗</span>
                      )}
                    </button>
                    {openHash === key && <OriginalBody hash={row.hash} />}
                  </div>
                )
              })}
            </div>
          )}
    </section>
  )
}

/**
 * Render the headroom card: the standard disclosure card, with its controls
 * under the header and a save/discard footer, exactly like the shipped cards.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function HeadroomCard(props: HeadroomCardProps) {
  const { t } = props
  const state = props.useHeadroomCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="headroomTitle"
      descriptionKey="headroomDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <StatsSection t={t} />
      <SelectField
        id="plugin-config-headroom-mode"
        label={t('mode')}
        hint={t('modeHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidValue')}
        options={['audit', 'live']}
        disabled={disabled}
        {...state.mode}
        onEdit={(text) => { props.edit('mode', text) }}
        onReset={() => { props.resetField('mode') }}
      />
      <SwitchField
        id="plugin-config-headroom-enabled"
        label={t('enabled')}
        hint={t('enabledHint')}
        overridden={state.enabled.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        on={state.enabled.text === 'true'}
        onEdit={(on) => { props.edit('enabled', on ? 'true' : 'false') }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="plugin-config-headroom-base-url"
        label={t('baseUrl')}
        hint={t('baseUrlHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseUrl}
        onEdit={(text) => { props.edit('baseUrl', text) }}
        onReset={() => { props.resetField('baseUrl') }}
      />
      <ValueField
        id="plugin-config-headroom-timeout"
        label={t('timeoutMs')}
        hint={t('timeoutMsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <ValueField
        id="plugin-config-headroom-min-chars"
        label={t('minChars')}
        hint={t('minCharsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.minChars}
        onEdit={(text) => { props.edit('minChars', text) }}
        onReset={() => { props.resetField('minChars') }}
      />
      <ValueField
        id="plugin-config-headroom-ratio"
        label={t('minSavingsRatio')}
        hint={t('minSavingsRatioHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={disabled}
        {...state.minSavingsRatio}
        onEdit={(text) => { props.edit('minSavingsRatio', text) }}
        onReset={() => { props.resetField('minSavingsRatio') }}
      />
      <SwitchField
        id="plugin-config-headroom-protect-errors"
        label={t('protectErrorOutputs')}
        hint={t('protectErrorOutputsHint')}
        overridden={state.protectErrorOutputs.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        on={state.protectErrorOutputs.text === 'true'}
        onEdit={(on) => { props.edit('protectErrorOutputs', on ? 'true' : 'false') }}
        onReset={() => { props.resetField('protectErrorOutputs') }}
      />
      <LedgerSection t={t} openSession={props.openSession} />
    </PluginCard>
  )
}
