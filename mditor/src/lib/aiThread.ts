// Follow-up thread history construction for the AI panel's 追问 feature.
//
// A follow-up turn targets a specific assistant answer. The request history is
// NOT the whole chat — it is the chain of question/answer pairs from the
// thread's ROOT down to the answer being followed up on, plus the new question.
// This keeps the model focused on the thread the user is digging into.
//
// The chain is derived from the message records themselves (parentId =
// the answer a message hangs under; repliedUser = the question an answer
// replies to), so it survives React re-renders and tolerates the MAX_MESSAGES
// cap slicing away older ancestors (the chain simply starts later).

/** The subset of the AI panel's Msg shape this builder needs. */
export interface ThreadMsg {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Answer this message hangs under (undefined for root-level turns). */
  parentId?: number;
  /** (assistant) the user message this answer replies to. */
  repliedUser?: number;
}

/** Hard cap on how deep a thread chain is walked — pathological documents
 *  shouldn't build unbounded prompts. */
const MAX_CHAIN_TURNS = 40;

/**
 * Build the user/assistant history leading to `targetId` (an assistant
 * message), ordered oldest → newest. Ancestors missing from `messages`
 * (trimmed by the message cap) truncate the chain gracefully. Returns [] when
 * the target can't be found.
 */
export function buildThreadHistory<T extends ThreadMsg>(
  messages: readonly T[],
  targetId: number
): Array<{ role: "user" | "assistant"; content: string }> {
  const byId = new Map<number, T>();
  for (const m of messages) byId.set(m.id, m);

  const chain: Array<{ role: "user" | "assistant"; content: string }> = [];
  const visited = new Set<number>();
  let cur = byId.get(targetId);
  while (cur && chain.length < MAX_CHAIN_TURNS * 2 && !visited.has(cur.id)) {
    visited.add(cur.id);
    // The question this answer replies to (may be gone — keep the answer).
    // Pushed AFTER the answer so the final reverse yields [Q,A] pairs in
    // chronological order.
    const q = cur.repliedUser != null ? byId.get(cur.repliedUser) : undefined;
    chain.push({ role: "assistant", content: cur.content });
    if (q && !visited.has(q.id)) {
      visited.add(q.id);
      chain.push({ role: "user", content: q.content });
    }
    cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}
