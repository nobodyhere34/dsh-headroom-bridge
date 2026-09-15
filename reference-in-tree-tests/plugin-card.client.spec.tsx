// @vitest-environment jsdom
/**
 * The card chrome: disclosure header, dirty badge, read-only notice, and the
 * save/discard footer — the same contract the Plugins section cards follow.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginCard } from '../src/client/PluginCard.tsx'
import { zh } from '../src/client/locales.ts'

const t = (key: string): string => zh[key as keyof typeof zh] ?? key

const shell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PluginCard', () => {
  it('renders nothing while the namespace is unavailable', () => {
    const { container } = render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, available: false }} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    expect(container.innerHTML).toBe('')
  })

  it('names the plugin and discloses the body on click', () => {
    render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={shell} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    expect(screen.getByText('Headroom 压缩')).toBeDefined()
    expect(screen.getByText('对模型可见内容做内容感知压缩。')).toBeDefined()
    const header = screen.getByRole('button', { name: '展开设置: Headroom 压缩' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('内容')).toBeNull()
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '收起设置: Headroom 压缩' })).toBeDefined()
    expect(screen.getByText('内容')).toBeDefined()
  })

  it('marks a card holding staged edits', () => {
    render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, dirty: true }} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    expect(screen.getByText('未保存')).toBeDefined()
  })

  it('shows the read-only notice and disables the footer while unwritable', () => {
    render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, writable: false, dirty: true }} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    fireEvent.click(screen.getByRole('button', { name: '展开设置: Headroom 压缩' }))
    expect(screen.getByText('本部署的设置为只读。')).toBeDefined()
    // Read-only does not disable the footer: the Host is what refuses the write.
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', false)
  })

  it('enables save and discard only while dirty and valid', () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    const { rerender } = render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, dirty: true }} onSave={onSave} onDiscard={onDiscard}>
        <div>内容</div>
      </PluginCard>,
    )
    fireEvent.click(screen.getByRole('button', { name: '展开设置: Headroom 压缩' }))
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toHaveProperty('disabled', false)
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    // An invalid draft blocks the save but not the discard.
    rerender(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, dirty: true, invalid: true }} onSave={onSave} onDiscard={onDiscard}>
        <div>内容</div>
      </PluginCard>,
    )
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', false)
  })

  it('labels the save while one is crossing the wire', () => {
    render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, dirty: true, saving: true }} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    fireEvent.click(screen.getByRole('button', { name: '展开设置: Headroom 压缩' }))
    expect(screen.getByRole('button', { name: '保存中…' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '放弃修改' })).toHaveProperty('disabled', true)
  })

  it('reports a failed save', () => {
    render(
      <PluginCard t={t} titleKey="headroomTitle" descriptionKey="headroomDescription"
        state={{ ...shell, dirty: true, failed: true }} onSave={() => {}} onDiscard={() => {}}>
        <div>内容</div>
      </PluginCard>,
    )
    fireEvent.click(screen.getByRole('button', { name: '展开设置: Headroom 压缩' }))
    expect(screen.getByText('本部署没有接受这些值，已保留供你修改。')).toBeDefined()
  })
})
