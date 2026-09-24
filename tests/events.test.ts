import { describe, expect, it } from 'vitest'
import { toSpendEvent } from '../src/events.ts'
import { UNATTRIBUTED } from '../src/spend.ts'

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000, cacheWriteTokens: 7 }

describe('toSpendEvent', () => {
  it('maps a settled assistant message onto its provider/model route', () => {
    expect(toSpendEvent({
      type: 'assistant/message',
      data: { turn: 3, step: 2, usage, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } } },
    })).toEqual({
      kind: 'usage',
      turn: 3,
      step: 2,
      model: 'deepseek/deepseek-chat',
      buckets: { input: 100, output: 20, cacheRead: 5000, cacheWrite: 7 },
    })
  })

  it('reads a usage sample out of the stream when the settlement carries none', () => {
    const event = toSpendEvent({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { source: { provider: 'p', model: 'm' } },
        stream: [
          { type: 'chunk', chunk: { type: 'usage', usage } },
          { type: 'chunk', chunk: { type: 'finish' } },
        ],
      },
    })
    expect(event).toMatchObject({ kind: 'usage', model: 'p/m', buckets: { input: 100, cacheRead: 5000 } })
  })

  it('ignores cache buckets a provider did not report', () => {
    expect(toSpendEvent({
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 2 } },
    })).toMatchObject({ model: UNATTRIBUTED, buckets: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } })
  })

  it('folds a message whose route is incomplete under the unattributed key', () => {
    expect(toSpendEvent({
      type: 'assistant/message',
      data: { turn: 1, step: 1, usage, message: { source: { provider: 'p', model: '' } } },
    })).toMatchObject({ model: UNATTRIBUTED })
  })

  it('converts a retry into a slot reopening', () => {
    expect(toSpendEvent({ type: 'llm/retry-started', data: { turn: 4, step: 2 } }))
      .toEqual({ kind: 'retry', turn: 4, step: 2 })
  })

  it('ignores events that bill nothing', () => {
    for (const type of ['user/message', 'tool/call', 'tool/result', 'turn/start', 'step/end']) {
      expect(toSpendEvent({ type, data: { turn: 1, step: 1 } })).toBeUndefined()
    }
  })

  it('ignores a settlement whose adapter reported no usage at all', () => {
    expect(toSpendEvent({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } }, stream: [] },
    })).toBeUndefined()
  })
})
