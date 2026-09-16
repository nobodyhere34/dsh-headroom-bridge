/**
 * Pre-release client smoke: drives the built bundle through a faithful stub
 * of the browser loader and cordis context, proving apply() mounts all four
 * effects without throwing and registers the expected shapes (the settings
 * card plus the turn-tail chip at priority 100 with a function selector).
 * Run: node scripts/client-smoke.mjs   (after a build)
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const bundle = resolve(import.meta.dirname, '..', 'lib', 'client.js')
const captured = {}
globalThis.window = { __ModuleLoader__: { load: (m) => { captured.id = m.id; captured.factory = m.factory } } }

const noopEffect = (fn) => { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } }
const react = { useState: (v) => [v, () => {}], useEffect: noopEffect, createElement: () => null, memo: (c) => c, Fragment: 'F', useCallback: (f) => f, useRef: () => ({ current: null }) }
react.default = react
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'F' }
const softStub = (name) => new Proxy(function () { return null }, {
  get: (_t, k) => {
    if (k === 'default') return softStub(name + '.default')
    if (k === Symbol.toPrimitive || k === 'toString') return () => name
    return softStub(name + '.' + String(k))
  },
  apply: () => null,
  construct: () => ({}),
})
const moduleTable = new Map([['react', react], ['react/jsx-runtime', jsxRuntime]])
const req = (id) => moduleTable.get(id) ?? softStub(id)

const recorded = { calls: [], registrations: [] }
const scopeStub = {
  subscribe: () => () => {},
  getSnapshot: () => ({ value: {}, served: true, writable: true }),
  set: async () => {},
  unset: async () => {},
}
const fakeCtx = {
  effect: (fn, name) => { recorded.calls.push(name); return fn() },
  on: () => () => {},
  get: (n) => (n === 'uiWorkspace' ? { openSession: () => {} } : undefined),
  slots: {
    inject: (name, fn) => { recorded.calls.push('inject ' + name); fn() },
    register: (cfg) => { recorded.registrations.push(cfg); return () => {} },
  },
  locale: { register: (ns, packs) => recorded.calls.push('locale ' + ns + ':' + Object.keys(packs).join(',')), bind: () => (key) => key },
  sessions: { list: { getSnapshot: () => ({}), subscribe: () => () => {} } },
  settingsScope: { bind: () => scopeStub },
  uiConversation: { events: { register: (def) => { recorded.calls.push('events.register ' + def.kind); return () => {} } } },
}

await import(pathToFileURL(bundle).href)
const mod = captured.factory(req)
mod.apply(fakeCtx)

const fail = (msg) => { console.error('SMOKE FAIL: ' + msg); process.exit(1) }
if (captured.id !== '@nobodyhere34/dsh-headroom-bridge') fail('unexpected module id ' + captured.id)
for (const need of ['slots', 'locale', 'settingsScope', 'uiConversation', 'sessions']) {
  if (!mod.inject.includes(need)) fail('inject missing ' + need)
}
if (!recorded.calls.some((c) => c.includes('events.register headroom'))) fail('turn projection not registered')
if (!recorded.calls.some((c) => c === 'locale settings.plugins.headroom:zh,en')) fail('card dictionaries not registered')
const card = recorded.registrations.find((r) => r.name === 'settings.plugin.item')
const chip = recorded.registrations.find((r) => r.name === 'conversation.chat.turnTail')
if (!card) fail('settings card not registered')
if (!chip) fail('turn-tail chip not registered')
if (typeof chip.select !== 'function') fail('chip selector missing')
if (chip.priority !== 100) fail('chip priority must rank behind deliverables, got ' + chip.priority)
console.log('SMOKE OK: id, inject, ' + recorded.calls.length + ' effects, card + chip(prio 100, select fn) registered')
