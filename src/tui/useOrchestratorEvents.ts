import { useCallback, useEffect, useReducer } from "react";

import type { Orchestrator } from "../orchestrator/Orchestrator.js";
import type { OrchestratorEvent } from "../orchestrator/events.js";
import { eventToLines } from "./eventToLines.js";
import { initialSessionState, type SessionState } from "./types.js";

type Action = OrchestratorEvent | { type: "session:clear" };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "session:clear":
      return { ...state, transcript: [] };
    case "agent:status":
      return { ...state, agents: { ...state.agents, [action.agent]: action.status } };
    case "agent:activity":
      if (action.state === "start") {
        return { ...state, current: { actor: action.actor, phase: action.phase, text: action.text } };
      }
      return { ...state, current: null, transcript: [...state.transcript, ...eventToLines(action)] };
    default:
      return { ...state, transcript: [...state.transcript, ...eventToLines(action)] };
  }
}

/**
 * S'abonne au flux d'événements d'un Orchestrator et maintient l'état de
 * session (statuts d'agents, transcript, activité en cours) dans un
 * reducer React. Le transcript n'est jamais muté en place — toujours
 * reconstruit par spread — pour rester compatible avec `<Static>` d'Ink.
 * Expose aussi `clear()` (commande `/clear`) pour vider le transcript
 * affiché sans perdre les statuts d'agents ni relancer la session.
 */
export function useOrchestratorEvents(
  orchestrator: Orchestrator,
  initialState?: SessionState,
): SessionState & { clear: () => void } {
  const [state, dispatch] = useReducer(reducer, initialState ?? initialSessionState);

  useEffect(() => {
    const handler = (e: OrchestratorEvent) => dispatch(e);
    orchestrator.on("event", handler);
    return () => {
      orchestrator.off("event", handler);
    };
  }, [orchestrator]);

  const clear = useCallback(() => dispatch({ type: "session:clear" }), []);

  return { ...state, clear };
}
