/**
 * Durable per-model spend fold: the state half of the `budgetGuardSpend`
 * session projection.
 *
 * A budget guard is worthless if restarting the process resets the meter, so
 * the running spend is not plugin state but a fold over the session log — the
 * harness's own mechanism for deriving durable per-session values. It replays
 * exactly on restore and fork, so a resumed session keeps its accumulated
 * spend and a fork starts from its inherited prefix's total.
 *
 * This module imports nothing from the harness: the plugin entry normalizes
 * each committed event into a {@link SpendEvent} (a settled usage sample or a
 * retry that reopens one slot) and this fold decides. That keeps the arithmetic
 * testable without a running composition.
 *
 * @module dsh-budget-guard/spend
 */

import type { Spend } from './budget.ts'
import { emptySpend } from './budget.ts'

/** Key for usage a settlement reports without provider/model attribution. */
export const UNATTRIBUTED = 'unattributed'

/** The fold's state: billed spend per model plus the newest settlement's slot. */
export interface SpendState {
  /** Billed buckets keyed by `provider/model`, or {@link UNATTRIBUTED}. */
  byModel: Record<string, Spend>
  /**
   * The newest settlement's slot, so a second usage sample for the same
   * `turn`/`step` replaces rather than duplicates it. `null` when the next
   * sample for that slot is a fresh attempt.
   */
  last: { turn: number; step: number; model: string; buckets: Spend } | null
}

/** One normalized session event the spend fold reacts to. */
export type SpendEvent =
  /** A model call settled and billed `buckets` under `model`. */
  | { kind: 'usage'; turn: number; step: number; model: string; buckets: Spend }
  /** A retry reopened the `turn`/`step` slot, so the next sample adds rather than replaces. */
  | { kind: 'retry'; turn: number; step: number }

/** State for an empty log. */
export function initialSpendState(): SpendState {
  return { byModel: {}, last: null }
}

function bucketsEqual(left: Spend, right: Spend): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
}

function plus(totals: Spend, next: Spend): Spend {
  return {
    input: totals.input + next.input,
    output: totals.output + next.output,
    cacheRead: totals.cacheRead + next.cacheRead,
    cacheWrite: totals.cacheWrite + next.cacheWrite,
  }
}

function minus(totals: Spend, previous: Spend): Spend {
  return {
    input: totals.input - previous.input,
    output: totals.output - previous.output,
    cacheRead: totals.cacheRead - previous.cacheRead,
    cacheWrite: totals.cacheWrite - previous.cacheWrite,
  }
}

/**
 * Advance the spend state through one normalized event.
 *
 * An event that changes nothing returns the same state reference, which is the
 * projection unit contract for "nothing happened" and what keeps the drive free
 * of downstream work on every unrelated log append.
 *
 * @param state - the state covering all earlier events.
 * @param event - the normalized next committed event.
 * @returns the next state, or `state` itself when the event changes nothing.
 */
export function applySpendEvent(state: SpendState, event: SpendEvent): SpendState {
  if (event.kind === 'retry') {
    const { last } = state
    return last !== null && last.turn === event.turn && last.step === event.step
      ? { ...state, last: null }
      : state
  }
  const previous = state.last !== null && state.last.turn === event.turn && state.last.step === event.step
    ? state.last
    : null
  if (previous !== null && previous.model === event.model && bucketsEqual(previous.buckets, event.buckets)) {
    return state
  }
  // A slot's newest settlement is the only one it bills: re-reporting replaces
  // its contribution, which may move it to a different model after a reroute.
  const byModel = { ...state.byModel }
  if (previous !== null) byModel[previous.model] = minus(byModel[previous.model] ?? emptySpend(), previous.buckets)
  byModel[event.model] = plus(byModel[event.model] ?? emptySpend(), event.buckets)
  return { byModel, last: { turn: event.turn, step: event.step, model: event.model, buckets: event.buckets } }
}
