/**
 * The headroom card's staged form over the 'headroom' settings namespace.
 *
 * The namespace is spelled here rather than imported: a client package must
 * not depend on a Host package, and the Host side spells the same value.
 */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  boolField, CardForm, numberField, selectField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Settings namespace of the bridge, matching the Host's registration. */
export const HEADROOM_NS = 'headroom'

/** The bridge fields this card edits — the hot subset of the served schema. */
export interface HeadroomSettings {
  /** Compression behavior: audit records savings only; live replaces results. */
  mode?: 'audit' | 'live'
  /** Master switch for both compression arms. */
  enabled?: boolean
  /** Headroom proxy endpoint. */
  baseUrl?: string
  /** Per-request HTTP budget in milliseconds. */
  timeoutMs?: number
  /** Compress only text at least this many Unicode characters long. */
  minChars?: number
  /** Replace only when the response saves at least this fraction of tokens. */
  minSavingsRatio?: number
  /** Skip failed results regardless of other gates. */
  protectErrorOutputs?: boolean
}

/** What the headroom card renders. */
export interface HeadroomCardState extends CardShell {
  /** Compression mode. */
  mode: CardFieldState
  /** Master switch. */
  enabled: CardFieldState
  /** Proxy endpoint. */
  baseUrl: CardFieldState
  /** Request budget. */
  timeoutMs: CardFieldState
  /** Minimum length gate. */
  minChars: CardFieldState
  /** Minimum savings gate. */
  minSavingsRatio: CardFieldState
  /** Failed-result protection. */
  protectErrorOutputs: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface HeadroomCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useHeadroomCard. */
    headroomCard: SnapshotStore<HeadroomCardState>
  }
}

/** Bridges the 'headroom' scope onto the card's staged form. */
export class HeadroomCardController {
  private readonly form: CardForm<HeadroomSettings>
  private readonly store: SnapshotStore<HeadroomCardState>

  /** @param scope - the bound settings scope for the 'headroom' namespace. */
  constructor(scope: SettingsScope<HeadroomSettings>) {
    this.form = new CardForm(scope, [
      selectField('mode', ['audit', 'live']),
      boolField('enabled'),
      textField('baseUrl'),
      numberField('timeoutMs'),
      numberField('minChars'),
      numberField('minSavingsRatio'),
      boolField('protectErrorOutputs'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): HeadroomCardState {
    return {
      ...this.form.shell(),
      mode: this.form.field('mode'),
      enabled: this.form.field('enabled'),
      baseUrl: this.form.field('baseUrl'),
      timeoutMs: this.form.field('timeoutMs'),
      minChars: this.form.field('minChars'),
      minSavingsRatio: this.form.field('minSavingsRatio'),
      protectErrorOutputs: this.form.field('protectErrorOutputs'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): HeadroomCardFace {
    return { hooks: { headroomCard: this.store }, ...this.form.actions() }
  }
}
