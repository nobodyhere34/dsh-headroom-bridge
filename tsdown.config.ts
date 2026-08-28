import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@dsh-external/dsh-headroom-bridge'

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

// The CSS Modules pipeline of the dsh client preset (lightningcss + injected
// style tags). Resolved from the dsh checkout because this plugin is built
// against a checkout, not a standalone install.
function checkoutRoot(): string {
  const fromEnv = process.env.DSH_CHECKOUT ?? ''
  if (fromEnv !== '' && existsSync(resolvePath(fromEnv, 'packages'))) return fromEnv
  for (const candidate of [
    resolvePath(process.env.HOME ?? '/', 'dsh-harness'),
    resolvePath(process.env.HOME ?? '/', 'dsh'),
    resolvePath(process.env.HOME ?? '/', '.dsh/dsh-harness'),
  ]) {
    if (existsSync(resolvePath(candidate, 'packages'))) return candidate
  }
  throw new Error('build: cannot locate the dsh checkout (set DSH_CHECKOUT)')
}

const CHECKOUT = checkoutRoot()
const require = createRequire(import.meta.url)
const { transform } = require(resolvePath(CHECKOUT, 'node_modules/.pnpm/lightningcss@1.32.0/node_modules/lightningcss')) as typeof import('lightningcss')

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit one plugin-owned style injector and a CSS Modules export. */
function styleInjectionModule(id: string, fileId: string, css: string, classMap: Record<string, string>): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${fileId.split('/').pop()}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(`export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(importer.split('?', 1)[0]!, '..', source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const { readFile } = await import('node:fs/promises')
      const source = await readFile(fileId)
      const result = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(result.exports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = (exp as { name: string }).name
      return styleInjectionModule(PLUGIN_ID, fileId, result.code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
