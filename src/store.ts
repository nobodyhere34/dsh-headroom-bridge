/**
 * Local CCR store: the bridge-side original-text ledger.
 *
 * Content-addressed (SHA-256 of the exact original, truncated) so repeated
 * identifications share one entry and hashes stay stable across sessions.
 * Persistence is best-effort durability beside the session log - deliberately
 * not a replacement for it (out-of-tree events cannot join the log vocabulary;
 * see RESEARCH-REPORT.md section 11.4 revision decision 1a).
 * @module
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { LOG_TAG } from './config.js'

/** One stored original plus its compression accounting. */
export interface CcrEntry {
  readonly hash: string
  readonly toolName: string
  readonly callId: string
  readonly sessionId: string
  readonly strategy: string
  readonly charsBefore: number
  readonly charsAfter: number
  readonly originalText: string
  readonly storedAt: number
  readonly expiresAt: number
}

/** Store statistics snapshot. */
export interface CcrStats {
  entries: number
  hits: number
  misses: number
  writes: number
}

interface StoreFileShape {
  version: number
  entries: CcrEntry[]
}

const STORE_VERSION = 1
const STORE_FILE_NAME = 'dsh-headroom-bridge-ccr.json'

/** Minimal logger surface the store needs. */
export interface StoreLogger {
  warn(msg: string): void
}

/** Whether a deserialized record still looks usable. */
function isUsable(value: unknown, now: number): value is CcrEntry {
  if (value === null || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return typeof e.hash === 'string' && e.hash.length > 0 &&
    typeof e.originalText === 'string' &&
    typeof e.toolName === 'string' &&
    typeof e.callId === 'string' &&
    typeof e.storedAt === 'number' && Number.isFinite(e.storedAt) &&
    typeof e.expiresAt === 'number' && Number.isFinite(e.expiresAt) &&
    e.expiresAt > now
}

/** Resolve the on-disk store path. */
export function defaultStorePath(explicitPath: string): string {
  if (explicitPath.length > 0 && isAbsolute(explicitPath)) return explicitPath
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', STORE_FILE_NAME)
}

/** Content-addressed original-text store with debounced atomic persistence. */
export class CcrStore {
  private readonly map = new Map<string, CcrEntry>()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private disposed = false
  private hitsCount = 0
  private missesCount = 0
  private writesCount = 0

  constructor(private readonly options: {
    enabled: boolean
    ttlMs: number
    maxEntries: number
    path: string
    logger: StoreLogger
  }) {}

  /** Load persisted entries; corrupt files start empty rather than failing. */
  init(): void {
    const now = Date.now()
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath(), 'utf8'))
    } catch {
      return // first run, missing file, or unreadable - start empty
    }
    if (parsed === null || typeof parsed !== 'object') return
    const shape = parsed as Record<string, unknown>
    if (shape.version !== STORE_VERSION || !Array.isArray(shape.entries)) return
    for (const raw of shape.entries.slice(-this.options.maxEntries)) {
      if (!isUsable(raw, now)) continue
      this.map.set(raw.hash, raw)
    }
  }

  private filePath(): string {
    return defaultStorePath(this.options.path)
  }

  /**
   * Persist one original before its replacement ships (store-before-adopt).
   * @returns the content hash keying the entry.
   */
  put(entry: Omit<CcrEntry, 'storedAt' | 'expiresAt'>): string {
    if (!this.options.enabled || this.disposed) return entry.hash
    this.map.delete(entry.hash) // refresh recency position deterministically
    this.map.set(entry.hash, { ...entry, storedAt: Date.now(), expiresAt: Date.now() + this.options.ttlMs })
    this.evictOverflow()
    this.writesCount++
    this.scheduleSave()
    return entry.hash
  }

  private evictOverflow(): void {
    while (this.map.size > this.options.maxEntries) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, entry] of this.map) {
        if (entry.storedAt < oldestAt) { oldestAt = entry.storedAt; oldestKey = key }
      }
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }

  /** Fetch one live entry by hash; expired entries disappear on read. */
  get(hash: string): CcrEntry | undefined {
    const entry = this.map.get(hash)
    if (entry === undefined) {
      this.missesCount++
      return undefined
    }
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(hash)
      this.missesCount++
      return undefined
    }
    this.hitsCount++
    return entry
  }

  /**
   * Most recent live entries by storedAt, newest first (browsing face).
   * @param limit - maximum entries to return.
   * @returns live entries in recency order.
   */
  recent(limit: number): CcrEntry[] {
    const sorted = [...this.map.values()]
      .filter((e) => Date.now() < e.expiresAt)
      .sort((a, b) => b.storedAt - a.storedAt)
    return sorted.slice(0, Math.max(0, limit))
  }

  /** Current counters and live entry count. */
  stats(): CcrStats {
    return { entries: this.map.size, hits: this.hitsCount, misses: this.missesCount, writes: this.writesCount }
  }

  private scheduleSave(): void {
    if (!this.dirty) {
      this.dirty = true
      this.saveTimer = setTimeout(() => { this.flush() }, 1_000)
      this.saveTimer.unref?.()
    }
  }

  /** Atomic write-through; failures degrade to an in-memory-only store. */
  flush(): void {
    this.dirty = false
    if (this.disposed) return
    try {
      const target = this.filePath()
      mkdirSync(dirname(target), { recursive: true })
      const payload: StoreFileShape = { version: STORE_VERSION, entries: [...this.map.values()] }
      const tmp = join(tmpdir(), STORE_FILE_NAME + '.' + process.pid + '.tmp')
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, target)
    } catch (error: unknown) {
      this.options.logger.warn(LOG_TAG + ': ccr persist failed, keeping memory-only: ' + String(error))
    }
  }

  /** Stop persistence timers and flush immediately (plugin unload). */
  dispose(): void {
    this.disposed = true
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    if (!this.dirty) return
    this.dirty = false
    try {
      const target = this.filePath()
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({ version: STORE_VERSION, entries: [...this.map.values()] }), 'utf8')
    } catch (error: unknown) {
      this.options.logger.warn(LOG_TAG + ': ccr dispose flush failed: ' + String(error))
    }
  }
}
