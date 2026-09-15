// @vitest-environment jsdom
/**
 * The headroom card end-to-end: apply() registration, the controller's inject
 * face, and the rendered card (stats/health/ledger fetches, staged fields,
 * save/discard, read-only and unavailable states).
 */

import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { HeadroomCard } from '../src/client/HeadroomCard.tsx'
import type { HeadroomCardProps } from '../src/client/HeadroomCard.tsx'
import { HeadroomCardController } from '../src/client/headroom-card-controller.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const STATS = {
  ok: true, mode: 'live', enabled: true, baseUrl: 'http://127.0.0.1:8787',
  counters: { attempts: 5, failures: 1, adopted: 2, savedChars: 1234 },
  ledger: { entries: 3, hits: 1, misses: 0, writes: 2 },
}
const LEDGER = { ok: true, entries: [
  { hash: '0123456789abcdef01234567', toolName: 'bash', charsBefore: 1000, charsAfter: 100 },
] }

const t = (key: string, params?: Record<string, unknown>): string => {
  const value = zh[key as keyof typeof zh] ?? key
  return params === undefined ? value : value.replace('{message}', String(params.message))
}

function stubFetch(handlers: Record<string, () => unknown>) {
  const fetchMock = vi.fn(async (url: string) => {
    for (const [marker, make] of Object.entries(handlers)) {
      if (url.includes(marker)) return new Response(JSON.stringify(make()), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A scope whose writes land: set/unset mutate the served section and fire listeners. */
function fakeScope(init: Partial<SettingsScopeSnapshot<Record<string, unknown>>> = {}) {
  const listeners = new Set<() => void>()
  const state: SettingsScopeSnapshot<Record<string, unknown>> = {
    status: 'ready',
    value: {},
    base: {},
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
    ...init,
  }
  const scope = {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: vi.fn(async (field: string, value: unknown) => {
      const user = { ...(state.user as Record<string, unknown>), [field]: value }
      state.user = user
      state.value = { ...(state.base as Record<string, unknown> | undefined), ...user }
      state.revision = (state.revision ?? 0) + 1
      for (const listener of listeners) listener()
    }),
    unset: vi.fn(async (field: string) => {
      const user = Object.fromEntries(
        Object.entries(state.user as Record<string, unknown>).filter(([key]) => key !== field),
      )
      state.user = user
      state.value = { ...(state.base as Record<string, unknown> | undefined), ...user }
      state.revision = (state.revision ?? 0) + 1
      for (const listener of listeners) listener()
    }),
  }
  return { scope, state }
}

/** Binds the card to its snapshot store like the slot renderer does. */
function CardHarness(props: {
  store: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown }
  card: Omit<HeadroomCardProps, 'useHeadroomCard'>
}) {
  const snapshot = useSyncExternalStore(
    (onStoreChange: () => void) => props.store.subscribe(onStoreChange),
    () => props.store.getSnapshot(),
  )
  const useHeadroomCard = ((selector: (s: never) => unknown) =>
    selector(snapshot as never)) as unknown as HeadroomCardProps['useHeadroomCard']
  return <HeadroomCard {...props.card} useHeadroomCard={useHeadroomCard} />
}

function mountCard(scope: ReturnType<typeof fakeScope>['scope']) {
  const controller = new HeadroomCardController(scope)
  const face = controller.inject()
  const card = {
    t,
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
  } as unknown as Omit<HeadroomCardProps, 'useHeadroomCard'>
  render(<CardHarness store={face.hooks.headroomCard} card={card} />)
  return { controller, face, scope }
}

function openCard() {
  fireEvent.click(screen.getByRole('button', { name: '展开设置: Headroom 压缩' }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('headroom card apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('registers the keyed card with its locale and inject face', () => {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const localeRegister = vi.fn()
    const bind = vi.fn(() => ({ getSnapshot: () => ({}), subscribe: () => () => {}, set: async () => {}, unset: async () => {} }))
    const ctx = {
      effect: (fn: () => unknown) => { fn() },
      locale: { register: localeRegister },
      settingsScope: { bind },
      slots: {
        inject: (_name: string, factory: () => unknown) => { factory() },
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    apply(ctx as never)
    expect(localeRegister).toHaveBeenCalledWith('settings.plugins.headroom', { zh, en })
    expect(bind).toHaveBeenCalledWith({ namespace: 'headroom' })
    expect(registrations).toHaveLength(1)
    const [registration] = registrations
    expect(registration!.options.name).toBe('settings.plugin.item')
    expect(registration!.options.key).toBe('headroom')
    expect(registration!.options.locale).toBe('settings.plugins.headroom')
    expect(registration!.component).toBe(HeadroomCard)
    const face = (registration!.options.inject as () => {
      hooks: { headroomCard: { getSnapshot: () => unknown } }
      edit: () => void
    })()
    expect(Object.keys(face.hooks)).toEqual(['headroomCard'])
    expect(typeof face.edit).toBe('function')
  })
})

describe('headroom card controller', () => {
  it('projects every field and republishes when the scope changes', async () => {
    const { scope } = fakeScope({
      value: { mode: 'audit', enabled: true, baseUrl: 'http://x', timeoutMs: 30000, minChars: 500, minSavingsRatio: 0.15, protectErrorOutputs: true },
      user: {},
    })
    const controller = new HeadroomCardController(scope)
    const face = controller.inject()
    const snapshot = face.hooks.headroomCard.getSnapshot()
    expect(snapshot.available).toBe(true)
    expect(snapshot.mode.text).toBe('audit')
    expect(snapshot.enabled.text).toBe('true')
    expect(snapshot.baseUrl.text).toBe('http://x')
    expect(snapshot.timeoutMs.text).toBe('30000')
    expect(snapshot.minChars.text).toBe('500')
    expect(snapshot.minSavingsRatio.text).toBe('0.15')
    expect(snapshot.protectErrorOutputs.text).toBe('true')
    await scope.set('mode', 'live')
    await vi.waitFor(() => { expect(face.hooks.headroomCard.getSnapshot().mode.text).toBe('live') })
  })
})

describe('headroom card', () => {
  it('renders stats, health, ledger and the staged fields', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({
      value: { mode: 'live', enabled: true, baseUrl: 'http://x', timeoutMs: 30000, minChars: 500, minSavingsRatio: 0.15, protectErrorOutputs: true },
      user: { baseUrl: 'http://x' },
    })
    mountCard(scope)
    openCard()
    await waitFor(() => { expect(screen.getByText('运行模式')).toBeDefined() })
    expect(screen.getByText('5 / 1')).toBeDefined()
    expect(screen.getByText('1234')).toBeDefined()
    expect(screen.getAllByText('true').length).toBeGreaterThan(0)
    await waitFor(() => { expect(screen.getByText('0123456789')).toBeDefined() })
    expect(screen.getByText('bash')).toBeDefined()
    expect(screen.getByText('1000->100 (-90%)')).toBeDefined()
    expect(screen.getByLabelText('模式')).toHaveProperty('value', 'live')
    expect(screen.getByRole('switch', { name: '启用压缩' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText('Proxy 地址')).toHaveProperty('value', 'http://x')
    // The user-layer entry marks the field overridden.
    expect(screen.getByText('已覆盖')).toBeDefined()
  })

  it('stages edits and writes them all on save', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({
      value: { mode: 'audit', enabled: true, baseUrl: 'http://x', protectErrorOutputs: true },
      user: {},
    })
    mountCard(scope)
    openCard()
    const mode = screen.getByLabelText('模式') as HTMLSelectElement
    fireEvent.change(mode, { target: { value: 'live' } })
    fireEvent.change(screen.getByLabelText('Proxy 地址'), { target: { value: 'http://new' } })
    fireEvent.click(screen.getByRole('switch', { name: '保护错误输出' }))
    await waitFor(() => { expect(screen.getByText('未保存')).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(scope.set).toHaveBeenCalledWith('mode', 'live') })
    expect(scope.set).toHaveBeenCalledWith('baseUrl', 'http://new')
    expect(scope.set).toHaveBeenCalledWith('protectErrorOutputs', false)
    await waitFor(() => { expect(screen.queryByText('未保存')).toBeNull() })
  })

  it('discards staged edits', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    mountCard(scope)
    openCard()
    fireEvent.change(screen.getByLabelText('Proxy 地址'), { target: { value: 'http://new' } })
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    await waitFor(() => { expect(screen.getByLabelText('Proxy 地址')).toHaveProperty('value', 'http://x') })
  })

  it('edits every field through its control', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({
      value: { mode: 'audit', enabled: true, baseUrl: 'http://x', timeoutMs: 30000, minChars: 500, minSavingsRatio: 0.15, protectErrorOutputs: false },
      user: {},
    })
    mountCard(scope)
    openCard()
    fireEvent.change(screen.getByLabelText('模式'), { target: { value: 'live' } })
    // The enabled switch is on; two clicks stage both literals (the second
    // returns to the served value, which a save would skip).
    const enabled = screen.getByRole('switch', { name: '启用压缩' })
    fireEvent.click(enabled)
    expect(enabled.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(enabled)
    expect(enabled.getAttribute('aria-checked')).toBe('true')
    fireEvent.change(screen.getByLabelText('Proxy 地址'), { target: { value: 'http://new' } })
    fireEvent.change(screen.getByLabelText('请求超时（毫秒）'), { target: { value: '60000' } })
    fireEvent.change(screen.getByLabelText('最小字符数'), { target: { value: '800' } })
    fireEvent.change(screen.getByLabelText('最低节省比例'), { target: { value: '0.2' } })
    // The protect switch is off; one click stages the on literal.
    fireEvent.click(screen.getByRole('switch', { name: '保护错误输出' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(scope.set).toHaveBeenCalledWith('mode', 'live') })
    expect(scope.set).toHaveBeenCalledWith('baseUrl', 'http://new')
    expect(scope.set).toHaveBeenCalledWith('timeoutMs', 60000)
    expect(scope.set).toHaveBeenCalledWith('minChars', 800)
    expect(scope.set).toHaveBeenCalledWith('minSavingsRatio', 0.2)
    expect(scope.set).toHaveBeenCalledWith('protectErrorOutputs', true)
  })

  it('resets every overridden field through its reset control', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({
      value: { mode: 'audit', enabled: true, baseUrl: 'http://x', timeoutMs: 30000, minChars: 500, minSavingsRatio: 0.15, protectErrorOutputs: true },
      user: { mode: 'audit', enabled: true, baseUrl: 'http://x', timeoutMs: 30000, minChars: 500, minSavingsRatio: 0.15, protectErrorOutputs: true },
    })
    mountCard(scope)
    openCard()
    for (const label of ['模式', '启用压缩', 'Proxy 地址', '请求超时（毫秒）', '最小字符数', '最低节省比例', '保护错误输出']) {
      // getByLabelText resolves to the labelled control; its field container
      // is the closest wrapping div, whose first button is the reset.
      const field = (screen.getByLabelText(label)).closest('div') as HTMLElement
      const reset = field.querySelector('button') as HTMLButtonElement
      fireEvent.click(reset)
    }
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(scope.unset).toHaveBeenCalledTimes(7) })
    expect(scope.unset).toHaveBeenCalledWith('mode')
    expect(scope.unset).toHaveBeenCalledWith('enabled')
    expect(scope.unset).toHaveBeenCalledWith('baseUrl')
    expect(scope.unset).toHaveBeenCalledWith('timeoutMs')
    expect(scope.unset).toHaveBeenCalledWith('minChars')
    expect(scope.unset).toHaveBeenCalledWith('minSavingsRatio')
    expect(scope.unset).toHaveBeenCalledWith('protectErrorOutputs')
  })

  it('disables the controls while the document is read-only', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope({ value: { mode: 'audit', enabled: true, baseUrl: 'http://x' }, writable: false })
    mountCard(scope)
    openCard()
    expect(screen.getByText('本部署的设置为只读。')).toBeDefined()
    expect(screen.getByLabelText('模式')).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch', { name: '启用压缩' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText('Proxy 地址')).toHaveProperty('disabled', true)
  })

  it('renders nothing while the namespace is unavailable', () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => LEDGER })
    fakeScope({ status: 'unavailable', writable: false, mode: 'memory' })
    render(<HeadroomCard {...{
      t,
      useHeadroomCard: () => ({
        available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false,
        mode: { text: '', overridden: false, invalid: false },
        enabled: { text: '', overridden: false, invalid: false },
        baseUrl: { text: '', overridden: false, invalid: false },
        timeoutMs: { text: '', overridden: false, invalid: false },
        minChars: { text: '', overridden: false, invalid: false },
        minSavingsRatio: { text: '', overridden: false, invalid: false },
        protectErrorOutputs: { text: '', overridden: false, invalid: false },
      }),
      edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {},
    } as unknown as HeadroomCardProps} />)
    expect(document.body.innerHTML.indexOf('Headroom 压缩')).toBe(-1)
  })

  it('surfaces error payloads and fetch failures in the status block', async () => {
    stubFetch({ '/stats': () => ({ ok: false, error: 'boom' }), '/health': () => ({ ok: true }), '/ledger/recent': () => LEDGER })
    const { scope } = fakeScope()
    mountCard(scope)
    openCard()
    await waitFor(() => { expect(screen.getByText('状态不可用：boom')).toBeDefined() })
    cleanup()
    stubFetch({
      '/stats': () => { throw new Error('down') },
      '/health': () => { throw new Error('down') },
      '/ledger/recent': () => { throw new Error('down') },
    })
    const { scope: scope2 } = fakeScope()
    mountCard(scope2)
    openCard()
    await waitFor(() => { expect(screen.getByText('状态 API 不可达。')).toBeDefined() })
    // The failed ledger fetch leaves the block title without rows.
    expect(screen.getByText('最近压缩')).toBeDefined()
  })

  it('shows the loading line while the stats fetch is pending', () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/stats')) return new Promise(() => {})
      if (url.includes('/health')) return Promise.resolve(new Response(JSON.stringify({ ok: true, healthy: true }), { status: 200 }))
      return Promise.resolve(new Response(JSON.stringify(LEDGER), { status: 200 }))
    }))
    const { scope } = fakeScope()
    mountCard(scope)
    openCard()
    expect(screen.getByText('加载中…')).toBeDefined()
  })

  it('renders sparse stats with defaults and an unknown health', async () => {
    stubFetch({ '/stats': () => ({ ok: true }), '/health': () => ({ ok: true }), '/ledger/recent': () => ({ ok: true, entries: [] }) })
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' } })
    mountCard(scope)
    openCard()
    await waitFor(() => { expect(screen.getByText('n/a')).toBeDefined() })
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
    await waitFor(() => { expect(screen.getByText('（暂无记录）')).toBeDefined() })
  })

  it('renders a zero-savings ledger entry', async () => {
    stubFetch({ '/stats': () => STATS, '/health': () => ({ ok: true, healthy: true }), '/ledger/recent': () => ({ ok: true, entries: [{ hash: 'h', toolName: 'x', charsBefore: 0, charsAfter: 0 }] }) })
    const { scope } = fakeScope()
    mountCard(scope)
    openCard()
    await waitFor(() => { expect(screen.getByText('h')).toBeDefined() })
    expect(screen.getByText('x')).toBeDefined()
    expect(screen.getByText('0->0 (-0%)')).toBeDefined()
  })

  it('drops settlements that resolve after unmount', async () => {
    let settleStats: ((value: unknown) => void) | undefined
    let settleLedger: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/stats')) return new Promise((resolve) => { settleStats = resolve })
      if (url.includes('/ledger/recent')) return new Promise((resolve) => { settleLedger = resolve })
      return Promise.resolve(new Response(JSON.stringify({ ok: true, healthy: false }), { status: 200 }))
    }))
    const { scope } = fakeScope()
    mountCard(scope)
    openCard()
    cleanup()
    settleStats?.(new Response(JSON.stringify({ ok: true, mode: 'live' }), { status: 200 }))
    settleLedger?.(new Response(JSON.stringify({ ok: true, entries: LEDGER.entries }), { status: 200 }))
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('drops a stats rejection that lands after unmount', async () => {
    let rejectStats: ((reason: unknown) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/stats')) return new Promise((_resolve, reject) => { rejectStats = reject })
      return Promise.resolve(new Response(JSON.stringify({ ok: true, healthy: true }), { status: 200 }))
    }))
    const { scope } = fakeScope()
    mountCard(scope)
    openCard()
    cleanup()
    rejectStats?.(new Error('late'))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
