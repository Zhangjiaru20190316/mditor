import { describe, expect, it } from "vitest";
import { buildThreadHistory, type ThreadMsg } from "./aiThread";

let nextId = 1;
const id = () => nextId++;
const mk = (partial: Partial<ThreadMsg> & { role: ThreadMsg["role"]; content: string }): ThreadMsg => ({
  id: id(),
  ...partial,
} as ThreadMsg);

describe("buildThreadHistory", () => {
  it("returns the root pair for a first-level follow-up target", () => {
    const u1 = mk({ role: "user", content: "Q1" });
    const a1 = mk({ role: "assistant", content: "A1", repliedUser: u1.id });
    const u2 = mk({ role: "user", content: "Q2", parentId: a1.id });
    const a2 = mk({ role: "assistant", content: "A2", parentId: a1.id, repliedUser: u2.id });
    const msgs = [u1, a1, u2, a2];
    expect(buildThreadHistory(msgs, a2.id)).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" },
    ]);
  });

  it("walks multiple levels down to the root", () => {
    const u1 = mk({ role: "user", content: "Q1" });
    const a1 = mk({ role: "assistant", content: "A1", repliedUser: u1.id });
    const u2 = mk({ role: "user", content: "Q2", parentId: a1.id });
    const a2 = mk({ role: "assistant", content: "A2", parentId: a1.id, repliedUser: u2.id });
    const u3 = mk({ role: "user", content: "Q3", parentId: a2.id });
    const a3 = mk({ role: "assistant", content: "A3", parentId: a2.id, repliedUser: u3.id });
    expect(buildThreadHistory([u1, a1, u2, a2, u3, a3], a3.id).map((m) => m.content)).toEqual([
      "Q1",
      "A1",
      "Q2",
      "A2",
      "Q3",
      "A3",
    ]);
  });

  it("follows only the targeted thread, not sibling follow-ups", () => {
    const u1 = mk({ role: "user", content: "Q1" });
    const a1 = mk({ role: "assistant", content: "A1", repliedUser: u1.id });
    const u2a = mk({ role: "user", content: "sibling-Q2", parentId: a1.id });
    const a2a = mk({ role: "assistant", content: "sibling-A2", parentId: a1.id, repliedUser: u2a.id });
    const u2b = mk({ role: "user", content: "thread-Q2", parentId: a1.id });
    const a2b = mk({ role: "assistant", content: "thread-A2", parentId: a1.id, repliedUser: u2b.id });
    const hist = buildThreadHistory([u1, a1, u2a, a2a, u2b, a2b], a2b.id);
    expect(hist.map((m) => m.content)).toEqual(["Q1", "A1", "thread-Q2", "thread-A2"]);
  });

  it("truncates gracefully when ancestors were sliced away", () => {
    const u1 = mk({ role: "user", content: "Q1" });
    const a1 = mk({ role: "assistant", content: "A1", repliedUser: u1.id });
    const u2 = mk({ role: "user", content: "Q2", parentId: a1.id });
    const a2 = mk({ role: "assistant", content: "A2", parentId: a1.id, repliedUser: u2.id });
    // a1/u1 sliced by the message cap — only a2 (with its question) remains.
    expect(buildThreadHistory([u2, a2], a2.id).map((m) => m.content)).toEqual(["Q2", "A2"]);
  });

  it("returns [] for an unknown target", () => {
    expect(buildThreadHistory([], 999)).toEqual([]);
  });

  it("survives a corrupt parent cycle", () => {
    const u1 = mk({ role: "user", content: "Q1" });
    const a1 = mk({ role: "assistant", content: "A1", repliedUser: u1.id });
    const u2 = mk({ role: "user", content: "Q2", parentId: a1.id });
    const a2 = mk({ role: "assistant", content: "A2", parentId: a1.id, repliedUser: u2.id });
    a1.parentId = a2.id; // cycle: a1 → a2 → a1
    const hist = buildThreadHistory([u1, a1, u2, a2], a2.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    expect(hist.length).toBeLessThanOrEqual(4);
  });
});
