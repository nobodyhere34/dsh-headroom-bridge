/**
 * Offline regression for the turn projection (③ chip selection): replays
 * durable-shaped events (verified against a real zstd session stream) through
 * the headroom node definition and asserts the chip would claim / decline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headroomTurnDefinition as def, selectHeadroom } from '../lib/turn-projection.js'

function markerLine(before, after, hash) {
  return '[headroom-bridge: ' + String(before) + '->' + String(after) +
    ' chars offloaded. Retrieve the exact original with headroom_retrieve hash=' + hash + ']'
}

function toolCall(seq, callId, name) {
  return { type: 'tool/call', seq, data: { turn: 1, callId, name } }
}

function toolResult(seq, callId, texts) {
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', content: texts.map(t => ({ type: 'text', text: t })) }],
      },
    },
  }
}

function fold(events) {
  let state
  for (const event of events) {
    const m = def.match(event)
    assert.ok(m, 'projection must match ' + event.type + ' events')
    if (m.role === 'start') state = def.start({ state: undefined }, { event })
    else state = def.update({ state }, { event })
  }
  return state
}

test('marker events claim the turn with lineage, type source, and accounting', () => {
  const h1 = '1f0bba3c88f684d3421da822'
  const h2 = '62002570367f945b3bf38baa'
  const state = fold([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, 'chatcmpl-tool-aec8', 'bash'),
    toolResult(5, 'chatcmpl-tool-aec8', ['compressed body…', markerLine(3200, 2404, h1)]),
    toolCall(6, 'chatcmpl-tool-b002', 'web_fetch'),
    toolResult(9, 'chatcmpl-tool-b002', ['body two\n\n' + markerLine(1121, 904, h2)]),
  ])
  assert.equal(state.hits.length, 2)
  assert.deepEqual(
    state.hits.map(h => [h.hash, h.charsBefore, h.charsAfter, h.toolName, h.callId, h.seq]),
    [
      [h1, 3200, 2404, 'bash', 'chatcmpl-tool-aec8', 5],
      [h2, 1121, 904, 'web_fetch', 'chatcmpl-tool-b002', 9],
    ],
  )
  const claimed = selectHeadroom({ turn: { data: { get: () => state } }, seq: 9 })
  assert.equal(claimed.hits.length, 2)
})

test('turns without markers decline selection (deliverables stays untouched)', () => {
  const state = fold([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, 'c1', 'bash'),
    toolResult(3, 'c1', ['plain output, no marker at all']),
  ])
  assert.equal(state.hits.length, 0)
  assert.equal(selectHeadroom({ turn: { data: { get: () => state } }, seq: 3 }), null)
  assert.equal(selectHeadroom({ turn: { data: { get: () => undefined } }, seq: 3 }), null)
})

test('multiple markers inside one result each get a hit', () => {
  const state = fold([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, 'c1', 'subagent'),
    toolResult(4, 'c1', ['a\n' + markerLine(900, 300, 'aabbccddee1122334455ff66') + '\nb\n' + markerLine(700, 500, 'ffeeddccbbaa998877665544')]),
  ])
  assert.deepEqual(state.hits.map(h => h.charsAfter), [300, 500])
})

test('tool name resolves through the tool/call pairing, malformed events are ignored', () => {
  const state = fold([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    toolCall(2, 'c1', 'grep'),
    toolResult(3, 'c1', ['tail ' + markerLine(100, 50, '0123456789abcdef01234567')]),
    // a result whose message.content is not an array must be skipped, not throw
    { type: 'tool/result', seq: 4, data: { turn: 1, message: { source: { callId: 'x' }, content: 'not-an-array' } } },
    // a result whose content blocks carry no inner array must be skipped
    { type: 'tool/result', seq: 5, data: { turn: 1, message: { source: { callId: 'x' }, content: [{ type: 'tool-result' }] } } },
  ])
  assert.equal(state.hits.length, 1)
  assert.equal(state.hits[0].toolName, 'grep')
})
