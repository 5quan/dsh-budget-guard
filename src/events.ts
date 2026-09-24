/**
 * Normalizes committed session events into the vocabulary the spend fold
 * understands.
 *
 * The shape here is deliberately structural rather than the harness's
 * `SessionEvent` union: the fold then depends on no host types, the plugin
 * entry performs the only cast, and the interesting behaviour — which events
 * bill, and where an unattributed settlement goes — stays unit-testable without
 * a running composition. The usage fallback mirrors the harness's own token
 * accounting: a settlement prefers its explicit `usage` and otherwise reads the
 * last usage chunk embedded in its stream record.
 *
 * @module dsh-budget-guard/events
 */

import type { Usage } from './budget.ts'
import { UNATTRIBUTED } from './spend.ts'
import type { SpendEvent } from './spend.ts'

/** The streamed-chunk wrapper shape the guard reads a usage sample from. */
interface StreamRecordLike {
  type: string
  chunk?: { type?: string; usage?: Usage }
}

/** The structural slice of one session event the guard reads. */
export interface SessionEventLike {
  type: string
  data: {
    turn?: number
    step?: number
    usage?: Usage
    message?: { source?: { provider?: string; model?: string } }
    stream?: readonly StreamRecordLike[]
  }
}

/** The last usage sample embedded in a settlement's stream, if it streamed one. */
function streamUsage(stream: readonly StreamRecordLike[] | undefined): Usage | undefined {
  if (stream === undefined) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) {
      return record.chunk.usage
    }
  }
  return undefined
}

/** `provider/model` for one settlement, or undefined when it names neither. */
function routeOf(message: SessionEventLike['data']['message']): string | undefined {
  const source = message?.source
  if (source === undefined) return undefined
  const { provider, model } = source
  if (provider === undefined || model === undefined || provider.length === 0 || model.length === 0) {
    return undefined
  }
  return `${provider}/${model}`
}

/**
 * Convert one committed session event into spend-fold input.
 *
 * Only model settlements bill, and a settlement with no usage sample at all
 * contributes nothing. An `assistant/attempt` — a billed attempt that never
 * settled into a final message — has no route, so it folds under
 * {@link UNATTRIBUTED}: it counts against the token ceiling but prices no cost,
 * which is the honest reading of "tokens were spent, the model is unknown".
 *
 * @param event - one committed session event, structurally read.
 * @returns the fold input, or undefined when the event bills nothing.
 */
export function toSpendEvent(event: SessionEventLike): SpendEvent | undefined {
  const { turn, step } = event.data
  if (turn === undefined || step === undefined) return undefined
  if (event.type === 'llm/retry-started') return { kind: 'retry', turn, step }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const usage = event.data.usage ?? streamUsage(event.data.stream)
  if (usage === undefined) return undefined
  const model = event.type === 'assistant/message' ? routeOf(event.data.message) : undefined
  return {
    kind: 'usage',
    turn,
    step,
    model: model ?? UNATTRIBUTED,
    buckets: {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
    },
  }
}
