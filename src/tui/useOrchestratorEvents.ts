import { useEffect, useReducer } from "react";

import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import type { OrchestratorEvent } from "../orchestrator/events.js";
import { eventToLines } from "./eventToLines.js";
import { initialSessionState, type SessionState } from "./types.js";

function reducer(state: SessionState, event: OrchestratorEvent): SessionState {
  switch (event.type) {
    case "agent:status":
      return { ...state, agents: { ...state.agents, [event.agent]: event.status } };
    case "agent:activity":
      if (event.state === "start") {
        return { ...state, current: { actor: event.actor, phase: event.phase, text: event.text } };
      }
      return { ...state, current: null, transcript: [...state.transcript, ...eventToLines(event)] };
    default:
      return { ...state, transcript: [...state.transcript, ...eventToLines(event)] };
  }
}

/**
 * S'abonne au flux d'événements d'un Orchestrator et maintient l'état de
 * session (statuts d'agents, transcript, activité en cours) dans un
 * reducer React. Le transcript n'est jamais muté en place — toujours
 * reconstruit par spread — pour rester compatible avec `<Static>` d'Ink.
 */
export function useOrchestratorEvents(orchestrator: Orchestrator, initialState?: SessionState): SessionState {
  const [state, dispatch] = useReducer(reducer, initialState ?? initialSessionState);

  useEffect(() => {
    const handler = (e: OrchestratorEvent) => dispatch(e);
    orchestrator.on("event", handler);
    return () => {
      orchestrator.off("event", handler);
    };
  }, [orchestrator]);

  return state;
}
