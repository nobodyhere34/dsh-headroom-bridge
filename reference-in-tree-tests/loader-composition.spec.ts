/**
 * REAL-composition boot test: the bridge mounted through the Loader over a
 * test-only cordis.yml, with the real tools/webserver/system-prompt services
 * and a mock headroom proxy (the one external service). Asserts model-visible
 * output (the compression marker on the accepted decision), durable output
 * (the CCR ledger file under DSH_HOME), and HMR safety (dispose removes the
 * registered tools).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as HeadroomBridge from '@deepseek-ai/dsh-headroom-bridge'

/** Mock headroom proxy: /health + /v1/compress with a fixed small response. */
async function mockProxy(): Promise<{ server: Server; baseUrl: string; hits: { compress: number } }> {
  const hits = { compress: 0 }
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'POST' && url === '/v1/compress') {
      hits.compress++
      let body = ''
      req.on('data', (c: string) => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          messages: [{ role: 'tool', content: 'compressed output' }],
          tokens_before: 1000,
          tokens_after: 100,
          transforms_applied: ['router:smart_crusher:0.1'],
          ccr_hashes: [],
        }))
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, hits })
    })
  })
}

describe('dsh-headroom-bridge real Loader composition', () => {
  let root: string | undefined
  let context: Context | undefined
  let proxy: { server: Server; baseUrl: string; hits: { compress: number } } | undefined

  afterEach(async () => {
    await context?.fiber.dispose()
    context = undefined
    proxy?.server.close()
    proxy = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
    delete process.env.DSH_HOME
  })

  async function boot(mode: 'audit' | 'live') {
    root = await mkdtemp(join(tmpdir(), 'dsh-headroom-bridge-loader-'))
    proxy = await mockProxy()
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      "- name: '@deepseek-ai/dsh-headroom-bridge'",
      '  config:',
      '    mode: ' + mode,
      '    baseUrl: ' + proxy.baseUrl,
      '    minChars: 100',
      '    minSavingsRatio: 0.1',
      '    excludeTools: []',
      '',
    ].join('\n'))
    process.env.DSH_HOME = root
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-system-prompt') return SystemPrompt
        if (specifier === '@deepseek-ai/dsh-tools') return Tools
        if (specifier === '@deepseek-ai/dsh-host-webserver') return WebServer
        if (specifier === '@deepseek-ai/dsh-headroom-bridge') return HeadroomBridge
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
  }

  const bigResult = { isError: false, content: [{ type: 'text', text: 'x'.repeat(4000) }] }
  const exec = { callId: 'call_boot_1', name: 'bash', arguments: {}, agent: undefined }

  it('live mode compresses through the real waterfall and persists the CCR ledger', async () => {
    await boot('live')
    expect(context?.get('webServer')).toBeTruthy()
    expect(context?.tools.get('headroom_retrieve')).toBeTruthy()
    const decision = await context!.waterfall(
      context! as never, 'tools/post-execute', exec as never, bigResult as never,
      (() => Promise.resolve({ kind: 'accept' })) as never,
    ) as unknown as { kind: string; content?: Array<{ type: string; text: string }> }
    expect(decision.kind).toBe('accept')
    const text = decision.content?.[0]?.text ?? ''
    expect(text).toMatch(/\[headroom-bridge:/)
    expect(proxy?.hits.compress).toBe(1)
    // durable: the debounced CCR write lands beside the harness home
    await new Promise(resolve => setTimeout(resolve, 1300))
    const storeFile = join(root!, 'storages', 'dsh-headroom-bridge-ccr.json')
    const payload = JSON.parse(await readFile(storeFile, 'utf8')) as { entries: Array<{ originalText: string }> }
    expect(payload.entries.length).toBe(1)
    expect(payload.entries[0]!.originalText).toBe('x'.repeat(4000))
  })

  it('audit mode leaves model-visible content untouched', async () => {
    await boot('audit')
    const decision = await context!.waterfall(
      context! as never, 'tools/post-execute', exec as never, bigResult as never,
      (() => Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: bigResult.content[0]!.text }] })) as never,
    ) as unknown as { kind: string; content?: Array<{ type: string; text: string }> }
    expect(decision.kind).toBe('accept')
    expect(decision.content?.[0]?.text).toBe('x'.repeat(4000))
    expect(proxy?.hits.compress).toBe(1)
  })

  it('disposing the fiber removes the registered tools (HMR safety)', async () => {
    await boot('live')
    const tools = context!.tools
    expect(tools.get('headroom_retrieve')).toBeTruthy()
    await context!.fiber.dispose()
    expect(tools.get('headroom_retrieve')).toBeUndefined()
    context = undefined
  })
})
