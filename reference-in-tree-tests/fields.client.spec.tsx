// @vitest-environment jsdom
/**
 * The field controls: staged value input, one-of-options select, and the
 * boolean switch — labels, badges, resets, invalidity, and disabled states.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectField, SwitchField, ValueField } from '../src/client/fields.tsx'

const common = {
  label: '字段',
  hint: '提示',
  overriddenLabel: '已覆盖',
  resetLabel: '恢复默认',
  invalidLabel: '无效',
  overridden: false,
  invalid: false,
  disabled: false,
  text: 'x',
  onEdit: () => {},
  onReset: () => {},
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ValueField', () => {
  it('renders the label, the draft text, and the hint', () => {
    render(<ValueField id="v" {...common} />)
    expect(screen.getByLabelText('字段')).toHaveProperty('value', 'x')
    expect(screen.getByText('提示')).toBeDefined()
    expect(screen.queryByText('已覆盖')).toBeNull()
  })

  it('shows the overridden badge and reset, and stages edits', () => {
    const onEdit = vi.fn()
    const onReset = vi.fn()
    render(<ValueField id="v" {...common} overridden onEdit={onEdit} onReset={onReset} />)
    expect(screen.getByText('已覆盖')).toBeDefined()
    fireEvent.click(screen.getByText('恢复默认'))
    expect(onReset).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText('字段'), { target: { value: 'y' } })
    expect(onEdit).toHaveBeenCalledWith('y')
  })

  it('marks an invalid draft and disables every control', () => {
    render(<ValueField id="v" {...common} invalid disabled />)
    expect(screen.getByLabelText('字段').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('无效')).toBeDefined()
    expect(screen.queryByText('提示')).toBeNull()
    expect(screen.getByLabelText('字段')).toHaveProperty('disabled', true)
  })

  it('hints a numeric keypad and renders a placeholder', () => {
    render(<ValueField id="v" {...common} text="" numeric placeholder="留空" />)
    expect(screen.getByLabelText('字段')).toHaveProperty('inputMode', 'numeric')
    expect(screen.getByLabelText('字段')).toHaveProperty('placeholder', '留空')
  })
})

describe('SelectField', () => {
  it('renders the options and stages a pick', () => {
    const onEdit = vi.fn()
    render(<SelectField id="s" {...common} text="" options={['audit', 'live']} onEdit={onEdit} />)
    const select = screen.getByLabelText('字段') as HTMLSelectElement
    // An empty draft renders the first option without staging anything.
    expect(select.value).toBe('audit')
    fireEvent.change(select, { target: { value: 'live' } })
    expect(onEdit).toHaveBeenCalledWith('live')
  })

  it('renders the staged text, the badge, and invalid/disabled states', () => {
    render(<SelectField id="s" {...common} text="live" options={['audit', 'live']} overridden invalid disabled />)
    const select = screen.getByLabelText('字段') as HTMLSelectElement
    expect(select.value).toBe('live')
    expect(select.getAttribute('aria-invalid')).toBe('true')
    expect((select).disabled).toBe(true)
    expect(screen.getByText('已覆盖')).toBeDefined()
  })

  it('renders an empty select when no options are offered', () => {
    render(<SelectField id="s" {...common} text="" options={[]} />)
    expect(screen.getByLabelText('字段')).toHaveProperty('value', '')
  })
})

describe('SwitchField', () => {
  it('renders on/off and stages the next boolean', () => {
    const onEdit = vi.fn()
    const { rerender } = render(<SwitchField id="w" {...common} on={false} onEdit={onEdit} />)
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(onEdit).toHaveBeenCalledWith(true)
    rerender(<SwitchField id="w" {...common} on={true} onEdit={onEdit} />)
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('shows the badge with reset, and disables with the document', () => {
    const onReset = vi.fn()
    const { rerender } = render(<SwitchField id="w" {...common} on overridden onReset={onReset} />)
    expect(screen.getByText('已覆盖')).toBeDefined()
    fireEvent.click(screen.getByText('恢复默认'))
    expect(onReset).toHaveBeenCalledTimes(1)
    rerender(<SwitchField id="w" {...common} on overridden disabled onReset={onReset} />)
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  })
})
