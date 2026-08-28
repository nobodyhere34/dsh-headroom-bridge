/**
 * Hand-written controls for the headroom card's configuration form. Each
 * renders one field's label, its staged text, whether saving would leave an
 * override, and — when one stands — the reset that stages a clear back to the
 * composition layer. Nothing here writes: a control reports what the user
 * typed, and the card's save is the single point where a draft becomes a
 * document mutation. The value/select/switch control trio mirrors the controls
 * the Plugins section ships for its own cards, so a card contributed from
 * outside that package reads the same.
 */

import css from './fields.module.css'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * A staged value field. 'numeric' only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A staged one-of-options control. An empty draft renders the first option
 * (a select must show a concrete value) but stages nothing, so saving an
 * untouched field writes nothing.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function SelectField(props: FieldProps & { options: readonly string[] }) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        className={props.invalid ? css.selectInvalid : css.select}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text === '' ? props.options[0] ?? '' : props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        {props.options.map(option => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** A staged boolean control's props. */
export interface SwitchFieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** True when the staged draft is the literal 'true'. */
  on: boolean
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Disables the control (read-only document). */
  disabled: boolean
  /** Stage the next boolean draft. */
  onEdit: (on: boolean) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * A staged boolean control rendered as a switch. The switch shows the staged
 * draft ('true' / 'false'); an empty draft renders off without staging
 * anything.
 * @param props - the field's copy, its on/off state, and the edit actions.
 * @returns the labelled control.
 */
export function SwitchField(props: SwitchFieldProps) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <button
        id={props.id}
        type="button"
        role="switch"
        aria-checked={props.on}
        className={props.on ? `${css.switch} ${css.switchOn}` : css.switch}
        disabled={props.disabled}
        onClick={() => { props.onEdit(!props.on) }}
      >
        <span className={css.thumb} />
      </button>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
