/**
 * The vendored staged-form model: field conversions and the form's staging,
 * save, reset, and discard contract.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  boolField, CardForm, numberField, selectField, textField,
} from '../src/client/card-form.ts'

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

describe('field conversions', () => {
  it('numberField formats numbers and parses finite drafts, blanks, and junk', () => {
    const field = numberField('n')
    expect(field.format(30000)).toBe('30000')
    expect(field.format('x')).toBe('')
    expect(field.parse('')).toEqual({ kind: 'clear' })
    expect(field.parse(' 42 ')).toEqual({ kind: 'set', value: 42 })
    expect(field.parse('abc')).toBeUndefined()
    expect(field.parse('NaN')).toBeUndefined()
  })

  it('textField formats strings and parses blanks as clears', () => {
    const field = textField('s')
    expect(field.format('http://x')).toBe('http://x')
    expect(field.format(7)).toBe('')
    expect(field.parse('')).toEqual({ kind: 'clear' })
    expect(field.parse('  v  ')).toEqual({ kind: 'set', value: 'v' })
  })

  it('selectField accepts only the offered options', () => {
    const field = selectField('m', ['audit', 'live'])
    expect(field.format('live')).toBe('live')
    expect(field.format(1)).toBe('')
    expect(field.parse('')).toEqual({ kind: 'clear' })
    expect(field.parse('live')).toEqual({ kind: 'set', value: 'live' })
    expect(field.parse('other')).toBeUndefined()
  })

  it('boolField formats booleans and parses the two literals', () => {
    const field = boolField('b')
    expect(field.format(true)).toBe('true')
    expect(field.format(false)).toBe('false')
    expect(field.format(undefined)).toBe('')
    expect(field.parse('')).toEqual({ kind: 'clear' })
    expect(field.parse('true')).toEqual({ kind: 'set', value: true })
    expect(field.parse('false')).toEqual({ kind: 'set', value: false })
    expect(field.parse('yes')).toBeUndefined()
  })
})

describe('CardForm', () => {
  it('reports the shell: availability, writability, and a clean form', () => {
    const { scope } = fakeScope()
    const form = new CardForm(scope, [textField('baseUrl')])
    const shell = form.shell()
    expect(shell.available).toBe(true)
    expect(shell.writable).toBe(true)
    expect(shell.dirty).toBe(false)
    expect(shell.invalid).toBe(false)
    expect(shell.saving).toBe(false)
    expect(shell.failed).toBe(false)
  })

  it('renders unstaged fields from the served section and the user layer', () => {
    const { scope } = fakeScope({
      value: { baseUrl: 'http://x' },
      base: { baseUrl: 'http://base' },
      user: { baseUrl: 'http://x' },
    })
    const form = new CardForm(scope, [textField('baseUrl')])
    expect(form.field('baseUrl')).toEqual({ text: 'http://x', overridden: true, invalid: false })
  })

  it('renders a field absent from the user layer as un-overridden', () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    const form = new CardForm(scope, [textField('baseUrl')])
    expect(form.field('baseUrl')).toEqual({ text: 'http://x', overridden: false, invalid: false })
  })

  it('is unavailable while the namespace is not served', () => {
    const { scope } = fakeScope({ status: 'loading' })
    const form = new CardForm(scope, [textField('baseUrl')])
    expect(form.shell().available).toBe(false)
  })

  it('is read-only when the Host document refuses writes', () => {
    const { scope } = fakeScope({ writable: false })
    const form = new CardForm(scope, [textField('baseUrl')])
    expect(form.shell().writable).toBe(false)
  })

  it('stages edits: dirty, previewed override, and an invalid draft blocks saving', () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', 'http://new')
    expect(form.shell().dirty).toBe(true)
    expect(form.field('baseUrl')).toEqual({ text: 'http://new', overridden: true, invalid: false })
    actions.edit('baseUrl', '')
    expect(form.field('baseUrl')).toEqual({ text: '', overridden: false, invalid: false })
  })

  it('stages an invalid number draft that blocks the save', () => {
    const { scope } = fakeScope()
    const form = new CardForm(scope, [numberField('timeoutMs')])
    const actions = form.actions()
    actions.edit('timeoutMs', 'abc')
    expect(form.field('timeoutMs').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
    expect(form.shell().dirty).toBe(true)
    actions.save()
    expect(scope.set).not.toHaveBeenCalled()
    expect(form.shell().failed).toBe(false)
  })

  it('saves every staged edit and clears the drafts the Host accepted', async () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', 'http://new')
    actions.save()
    await vi.waitFor(() => { expect(scope.set).toHaveBeenCalledWith('baseUrl', 'http://new') })
    await vi.waitFor(() => { expect(form.shell().dirty).toBe(false) })
    expect(form.field('baseUrl')).toEqual({ text: 'http://new', overridden: true, invalid: false })
  })

  it('writes a staged clear through unset and re-inherits the base', async () => {
    const { scope } = fakeScope({
      value: { baseUrl: 'http://x' },
      base: { baseUrl: 'http://base' },
      user: { baseUrl: 'http://x' },
    })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.resetField('baseUrl')
    expect(form.field('baseUrl')).toEqual({ text: 'http://base', overridden: false, invalid: false })
    actions.save()
    await vi.waitFor(() => { expect(scope.unset).toHaveBeenCalledWith('baseUrl') })
    await vi.waitFor(() => { expect(form.shell().dirty).toBe(false) })
    expect(form.field('baseUrl').text).toBe('http://base')
  })

  it('skips a clear of a field the user layer does not carry', () => {
    const { scope } = fakeScope({ value: { mode: 'audit' }, user: {} })
    const form = new CardForm(scope, [selectField('mode', ['audit', 'live'])])
    const actions = form.actions()
    actions.resetField('mode')
    expect(form.shell().dirty).toBe(false)
  })

  it('writes an emptied draft as a clear', async () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, base: {}, user: { baseUrl: 'http://x' } })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', '')
    expect(form.shell().dirty).toBe(true)
    actions.save()
    await vi.waitFor(() => { expect(scope.unset).toHaveBeenCalledWith('baseUrl') })
    await vi.waitFor(() => { expect(form.shell().dirty).toBe(false) })
  })

  it('skips a draft identical to the served value', () => {
    const { scope } = fakeScope({ value: { mode: 'audit' }, user: {} })
    const form = new CardForm(scope, [selectField('mode', ['audit', 'live'])])
    const actions = form.actions()
    actions.edit('mode', 'audit')
    expect(form.shell().dirty).toBe(false)
  })

  it('keeps drafts and flags the card when a save does not land', async () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    // A write that resolves but never mutates the served section reads back false.
    scope.set = vi.fn(async () => {})
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', 'http://new')
    actions.save()
    await vi.waitFor(() => { expect(form.shell().failed).toBe(true) })
    expect(form.shell().dirty).toBe(true)
    expect(form.field('baseUrl').text).toBe('http://new')
  })

  it('ignores a save while one is crossing the wire', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { scope, state } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    scope.set = vi.fn(async (field: string, value: unknown) => {
      await gate
      state.value = { ...state.value, [field]: value }
      state.user = { ...(state.user as Record<string, unknown>), [field]: value }
    })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', 'http://new')
    actions.save()
    actions.save()
    expect(scope.set).toHaveBeenCalledTimes(1)
    release?.()
    await vi.waitFor(() => { expect(form.shell().saving).toBe(false) })
    await vi.waitFor(() => { expect(form.shell().dirty).toBe(false) })
  })

  it('discards staged edits and clears the failed flag', () => {
    const { scope } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    const form = new CardForm(scope, [textField('baseUrl')])
    const actions = form.actions()
    actions.edit('baseUrl', 'http://new')
    actions.discard()
    expect(form.shell().dirty).toBe(false)
    expect(form.field('baseUrl').text).toBe('http://x')
    // A clean form discards as a no-op.
    actions.discard()
    expect(form.field('baseUrl').text).toBe('http://x')
  })

  it('re-publishes the bound projection when the scope changes', async () => {
    const { scope, state } = fakeScope({ value: { baseUrl: 'http://x' }, user: {} })
    const form = new CardForm(scope, [textField('baseUrl')])
    const store = form.bind(() => ({ value: form.field('baseUrl').text }))
    expect(store.getSnapshot()).toEqual({ value: 'http://x' })
    state.value = { baseUrl: 'http://changed' }
    await scope.set('baseUrl', 'http://changed')
    await vi.waitFor(() => { expect(store.getSnapshot()).toEqual({ value: 'http://changed' }) })
  })

  it('throws for a field the card never declared', () => {
    const { scope } = fakeScope()
    const form = new CardForm(scope, [textField('baseUrl')])
    expect(() => { form.field('nope') }).toThrow(/no field/)
    expect(() => { form.actions().resetField('nope') }).toThrow(/no field/)
  })
})
