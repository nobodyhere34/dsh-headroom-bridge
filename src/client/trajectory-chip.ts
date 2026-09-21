/**
 * Trajectory-view bubbles. ui-trajectory exposes no plugin extension point,
 * so this follows the ecosystem's direct-DOM precedent (dsh-session-manager's
 * nav-icon swap): watch the trajectory table and attach one headroom bubble
 * per compressed tool-result row.
 *
 * Rows are matched by identity, never by text: each row carries
 * `data-trajectory-row-key` = encodeURIComponent(recordId), and tool rows are
 * `kind\0call\0<callId>` - the same callId the ledger stamps at
 * write-before-compress time. The summary column may truncate the marker, so
 * text scanning would miss rows; callIds cannot.
 *
 * Bubble data is the host ledger itself (GET /ledger/activity?session=...),
 * so demoted entries keep showing (with the expired-original note) and the
 * chip always tells the ledger's truth. Must stay a fiber-paired effect:
 * top-level document access makes dsh-startup-guard flag the bundle broken.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import css from './CompressChip.module.css'

const API = '/headroom-bridge/api'
/** Marks rows that already carry a bubble (and powers disposal cleanup). */
const CHIP_ATTR = 'data-hb-chip'

interface ChipRow {
  readonly hash: string
  readonly toolName: string
  readonly charsBefore: number
  readonly charsAfter: number
  readonly strategy: string
  readonly originalAvailable: boolean
}

interface ActivityResponse {
  readonly ok?: boolean
  readonly rows?: Array<{
    kind: string
    callId: string
    hash: string
    toolName: string
    charsBefore: number
    charsAfter: number
    strategy: string
    originalAvailable: boolean
  }>
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className !== '') node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** `router:smart_crusher:0.19>router:text:0.67` -> `router:smart_crusher › router:text`. */
function strategyChain(strategy: string): string {
  if (strategy === '') return ''
  return strategy.split('>').map((step) => step.split(':').slice(0, 2).join(':')).join(' › ')
}

function bubble(hits: readonly ChipRow[], t: Translate): HTMLElement {
  const box = el('div', css.root)
  box.setAttribute(CHIP_ATTR, '1')
  let open = false
  let body: HTMLElement | undefined
  const before = hits.reduce((sum, h) => sum + h.charsBefore, 0)
  const after = hits.reduce((sum, h) => sum + h.charsAfter, 0)
  const pct = before > 0 ? Math.round(100 * (1 - after / before)) : 0
  const head = el('div', css.head)
  head.appendChild(el('span', css.badge, 'headroom'))
  head.appendChild(el('span', '', t('chipCount', { count: hits.length, before, after, pct })))
  const caret = el('span', css.caret, '▸')
  head.appendChild(caret)
  box.appendChild(head)
  head.addEventListener('click', (event) => {
    event.stopPropagation()
    open = !open
    caret.textContent = open ? '▾' : '▸'
    if (!open) {
      body?.remove()
      body = undefined
      return
    }
    body = el('div', '')
    for (const hit of hits) body.appendChild(row(hit, t))
    box.appendChild(body)
  })
  return box
}

function row(hit: ChipRow, t: Translate): HTMLElement {
  const rowBox = el('div', css.row)
  const head = el('div', css.rowHead)
  head.appendChild(el('span', css.rowTool, hit.toolName === '' ? hit.hash.slice(0, 8) : hit.toolName))
  const chain = strategyChain(hit.strategy)
  if (chain !== '') head.appendChild(el('span', css.rowType, chain))
  head.appendChild(el('span', css.rowSize, `${hit.charsBefore} → ${hit.charsAfter}`))
  head.appendChild(el('span', css.rowCaret, '▸'))
  rowBox.appendChild(head)
  let open = false
  let loaded = false
  let detail: HTMLElement | undefined
  head.addEventListener('click', (event) => {
    event.stopPropagation()
    open = !open
    if (!open) {
      detail?.remove()
      detail = undefined
      return
    }
    detail = el('div', css.rowBody)
    const note = el('p', css.note, t('ledgerShowOriginal'))
    detail.appendChild(note)
    rowBox.appendChild(detail)
    if (loaded || !hit.originalAvailable) {
      if (!hit.originalAvailable) note.textContent = t('chipExpired')
      loaded = true
      return
    }
    loaded = true
    void fetch(`${API}/ledger/entry?hash=${encodeURIComponent(hit.hash)}`)
      .then((res) => res.json().then((d: { meta?: { originalText?: string }; originalText?: string }) => ({ res, d })))
      .then(({ res, d }) => {
        if (detail === undefined) return
        note.remove()
        if (!res.ok) {
          detail.appendChild(el('p', css.note, t('chipUnavailable')))
          return
        }
        const text = d.originalText ?? d.meta?.originalText ?? ''
        const pre = el('pre', css.pre, text)
        detail.appendChild(pre)
        detail.appendChild(el('p', css.meta, `hash=${hit.hash}`))
      })
      .catch(() => {
        if (detail === undefined) return
        note.textContent = t('chipUnavailable')
      })
  })
  return rowBox
}

/**
 * Install the trajectory observer for one fiber.
 * @param ctx - plugin context (uses the injected `sessions` feed).
 * @param t - translator bound to this plugin's namespace.
 * @returns a disposer, or `undefined` outside a browser.
 */
export function installTrajectoryChip(ctx: Context, t: Translate): (() => void) | undefined {  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || document.body === null) {
    return undefined
  }
  let current: string | undefined
  let rows = new Map<string, ChipRow[]>()
  let disposed = false
  let scanQueued = false

  const scan = (): void => {
    scanQueued = false
    if (disposed || current === undefined || rows.size === 0) return
    const table = document.querySelector('[data-trajectory-scroll]')
    if (table === null) return
    for (const tr of table.querySelectorAll('tr[data-trajectory-row-key]')) {
      if (tr.getAttribute(CHIP_ATTR) !== null) continue
      const raw = tr.getAttribute('data-trajectory-row-key') ?? ''
      let key: string
      try {
        key = decodeURIComponent(raw)
      } catch {
        continue
      }
      const parts = key.split('\u0000')
      if (parts[1] !== 'call') continue
      const hits = rows.get(parts[2])
      if (hits === undefined || hits.length === 0) continue
      tr.setAttribute(CHIP_ATTR, '1')
      const cell = tr.querySelector('td:last-of-type')
      if (cell === null) continue
      cell.appendChild(bubble(hits, t))
    }
  }
  const scheduleScan = (): void => {
    if (scanQueued) return
    scanQueued = true
    requestAnimationFrame(scan)
  }

  const load = (sessionId: string): void => {
    void fetch(`${API}/ledger/activity?limit=200&session=${encodeURIComponent(sessionId)}`)
      .then((res) => res.json() as Promise<ActivityResponse>)
      .then((data) => {
        if (disposed || current !== sessionId) return
        const next = new Map<string, ChipRow[]>()
        for (const r of data.rows ?? []) {
          if (r.kind !== 'ledger' || r.callId === '' || r.hash === '') continue
          const list = next.get(r.callId) ?? []
          list.push({
            hash: r.hash,
            toolName: r.toolName,
            charsBefore: r.charsBefore,
            charsAfter: r.charsAfter,
            strategy: r.strategy,
            originalAvailable: r.originalAvailable,
          })
          next.set(r.callId, list)
        }
        rows = next
        scheduleScan()
      })
      .catch(() => { /* ledger unreachable: rows simply carry no bubbles */ })
  }

  const watch = (): void => {
    const next = ctx.sessions.list.getSnapshot().current
    if (next === current) return
    current = next
    rows = new Map()
    if (current !== undefined) load(current)
  }
  const offList = ctx.sessions.list.subscribe(watch)
  watch()
  const observer = new MutationObserver(scheduleScan)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    disposed = true
    offList()
    observer.disconnect()
    for (const node of document.querySelectorAll(`[${CHIP_ATTR}]`)) node.remove()
  }
}

/** Known labels of the trajectory view tab (ui-trajectory's `view.trajectory`, zh/en). */
const TRAJECTORY_TAB_LABELS = ['轨迹', 'Trajectory']

/**
 * Drive the mounted conversation view onto the trajectory, best-effort
 * focused on one tool call. Complements the cold-mount path (localStorage
 * pre-write, which the official store hydrates on first mount): a session
 * already mounted in this browser run keeps its cached store and ignores the
 * preference, so the warm path is direct DOM - click the trajectory tab
 * (role=tab/aria-selected, label-matched ONLY) and scroll the
 * `kind\0call\0<callId>` row into view with a brief green flash.
 *
 * Clicking is strictly limited to the label-matched trajectory tab, and the
 * retry stops once the row was found or the table demonstrably mounted
 * without it (a folded-out row never arrives by waiting, and a sub-agent
 * session's compression rows live in the CHILD's own trajectory - the parent
 * page can never host them). An earlier two-tab fallback clicked "the other
 * unselected tab", which made the retry loop alternate trajectory/chat every
 * tick whenever the row could not mount: the view visibly bounced.
 * @param callId - tool call to focus, when the source row knows one.
 * @returns nothing.
 */
export function driveTrajectoryView(callId?: string): void {
  if (typeof document === 'undefined' || typeof setTimeout === 'undefined') return
  const trajectoryTab = (selected: boolean): Element | undefined =>
    Array.from(document.querySelectorAll('[role="tab"]')).find(
      (tab) => (tab.getAttribute('aria-selected') === 'true') === selected
        && TRAJECTORY_TAB_LABELS.includes((tab.textContent ?? '').trim()),
    )
  const focusRow = (): boolean => {
    if (callId === undefined || callId === '') return true
    const table = document.querySelector('[data-trajectory-scroll]')
    if (table === null) return false
    const key = encodeURIComponent(`tool\u0000call\u0000${callId}`)
    const row = table.querySelector(`tr[data-trajectory-row-key="${key}"]`)
    if (row === null) return false
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const tr = row as HTMLElement
    tr.style.outline = '1px solid rgba(34, 197, 94, .65)'
    tr.style.outlineOffset = '-1px'
    setTimeout(() => {
      tr.style.outline = ''
      tr.style.outlineOffset = ''
    }, 1800)
    return true
  }
  let tries = 0
  let missed = 0
  const step = (): void => {
    tries++
    // Click only while the trajectory tab is not the selected one - and only
    // ever the trajectory tab itself. (The removed two-tab fallback clicked
    // the opposite tab and made unmountable rows bounce the view every tick.)
    if (trajectoryTab(true) === undefined) trajectoryTab(false)?.click()
    if (focusRow()) return
    // The table mounted but the row is absent: virtualization folded it out,
    // or this is a sub-agent session whose compression rows live in the
    // child's own trajectory. Waiting more will not materialize it.
    if (document.querySelector('[data-trajectory-scroll]') !== null && ++missed >= 8) return
    if (tries < 25) setTimeout(step, 120)
  }
  step()
}
