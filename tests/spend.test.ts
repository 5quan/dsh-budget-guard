import { describe, expect, it } from 'vitest'
import { applySpendEvent, initialSpendState } from '../src/spend.ts'
import type { SpendEvent } from '../src/spend.ts'

const fold = (events: readonly SpendEvent[]) => events.reduce(applySpendEvent, initialSpendState())

const usage = (turn: number, step: number, model: string, input: number, output = 0): SpendEvent => ({
  kind: 'usage', turn, step, model, buckets: { input, output, cacheRead: 0, cacheWrite: 0 },
})

describe('applySpendEvent', () => {
  it('accumulates distinct calls under their model', () => {
    const state = fold([usage(1, 1, 'a/one', 100, 20), usage(1, 2, 'a/one', 50, 10)])
    expect(state.byModel).toEqual({ 'a/one': { input: 150, output: 30, cacheRead: 0, cacheWrite: 0 } })
  })

  it('keeps one bucket per model so a cost ceiling can price each rate separately', () => {
    const state = fold([usage(1, 1, 'a/one', 100), usage(1, 2, 'b/two', 70)])
    expect(Object.keys(state.byModel).sort()).toEqual(['a/one', 'b/two'])
    expect(state.byModel['a/one']).toEqual({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(state.byModel['b/two']).toEqual({ input: 70, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('replaces a second sample for the same turn/step instead of doubling it', () => {
    const state = fold([usage(2, 5, 'a/one', 100), usage(2, 5, 'a/one', 120)])
    expect(state.byModel['a/one']).toEqual({ input: 120, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('is a no-op when a repeated sample reports the same buckets', () => {
    const first = applySpendEvent(initialSpendState(), usage(2, 5, 'a/one', 100))
    expect(applySpendEvent(first, usage(2, 5, 'a/one', 100))).toBe(first)
  })

  it('adds rather than replaces once a retry reopens the slot', () => {
    const state = fold([
      usage(3, 1, 'a/one', 100),
      { kind: 'retry', turn: 3, step: 1 },
      usage(3, 1, 'a/one', 100),
    ])
    expect(state.byModel['a/one']).toEqual({ input: 200, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('ignores a retry that reopens a different slot than the last settlement', () => {
    const state = fold([usage(3, 1, 'a/one', 100), { kind: 'retry', turn: 9, step: 9 }])
    expect(state.last).toEqual({ turn: 3, step: 1, model: 'a/one', buckets: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } })
    expect(state.byModel['a/one']).toEqual({ input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('does not double-count a rerouted slot, but moves the spend to the new model', () => {
    const state = fold([usage(1, 1, 'a/one', 100), usage(1, 1, 'b/two', 30)])
    expect(state.byModel['a/one']).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(state.byModel['b/two']).toEqual({ input: 30, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('keeps the reference stable across an unrelated retry', () => {
    const state = initialSpendState()
    expect(applySpendEvent(state, { kind: 'retry', turn: 1, step: 1 })).toBe(state)
  })
})
