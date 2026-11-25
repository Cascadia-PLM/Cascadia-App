// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

type Graph = Record<string, Record<string, string>>
type ValidGraph<TGraph extends Graph> = {
  [TState in keyof TGraph]: {
    [TCommand in keyof TGraph[TState]]: keyof TGraph & string
  }
}
declare const evidenceBrand: unique symbol

export interface TransitionEvidence<
  TGraph extends Graph,
  TState extends keyof TGraph,
  TCommand extends keyof TGraph[TState],
> {
  readonly from: TState
  readonly command: TCommand
  readonly to: TGraph[TState][TCommand]
  readonly [evidenceBrand]: TGraph
}

export interface ProgressionPhase<
  TGraph extends Graph,
  TState extends keyof TGraph,
> {
  readonly state: TState
  readonly commands: {
    readonly [TCommand in keyof TGraph[TState]]: () => TransitionOutcome<
      TGraph,
      TState,
      TCommand
    >
  }
  transition: <TCommand extends keyof TGraph[TState] & string>(
    command: TCommand,
  ) => TransitionOutcome<TGraph, TState, TCommand>
}

type TransitionOutcome<
  TGraph extends Graph,
  TState extends keyof TGraph,
  TCommand extends keyof TGraph[TState],
> =
  | {
      kind: 'advanced'
      phase: ProgressionPhase<TGraph, TGraph[TState][TCommand] & keyof TGraph>
      evidence: TransitionEvidence<TGraph, TState, TCommand>
    }
  | { kind: 'stale' }
  | { kind: 'invalid' }

export type AnyProgressionPhase<TGraph extends Graph> = {
  [TState in keyof TGraph]: ProgressionPhase<TGraph, TState>
}[keyof TGraph]

/**
 * Derives legal commands, successor phases and transition evidence from one
 * graph. Runtime generations also reject retained aliases after progression.
 * This owns local sequencing; domains still own effects and durable truth.
 */
export function defineProgression<const TGraph extends Graph>(
  graph: TGraph & ValidGraph<TGraph>,
) {
  // Snapshot the declaration so external mutation cannot change legal edges.
  const edges = new Map(
    Object.entries(graph).map(([state, commands]) => [
      state,
      new Map(Object.entries(commands)),
    ]),
  )
  for (const commands of edges.values()) {
    for (const next of commands.values()) {
      if (!edges.has(next)) throw new Error('Unknown successor phase')
    }
  }

  return {
    start<TState extends keyof TGraph & string>(
      state: TState,
    ): ProgressionPhase<TGraph, TState> {
      if (!edges.has(state)) throw new Error('Unknown initial phase')
      let generation = 0

      function issue<TCurrent extends keyof TGraph & string>(
        current: TCurrent,
      ): ProgressionPhase<TGraph, TCurrent> {
        const issuedGeneration = generation
        const phase: ProgressionPhase<TGraph, TCurrent> = {
          state: current,
          commands: Object.freeze(
            Object.fromEntries(
              [...(edges.get(current)?.keys() ?? [])].map((command) => [
                command,
                () => phase.transition(command),
              ]),
            ),
          ) as ProgressionPhase<TGraph, TCurrent>['commands'],
          transition<TCommand extends keyof TGraph[TCurrent] & string>(
            command: TCommand,
          ): TransitionOutcome<TGraph, TCurrent, TCommand> {
            if (issuedGeneration !== generation) return { kind: 'stale' }
            const next = edges.get(current)?.get(command)
            if (next === undefined) return { kind: 'invalid' }
            generation++
            return {
              kind: 'advanced',
              phase: issue(next),
              evidence: Object.freeze({ from: current, command, to: next }),
            } as TransitionOutcome<TGraph, TCurrent, TCommand>
          },
        }
        return Object.freeze(phase)
      }

      return issue(state)
    },
  }
}
