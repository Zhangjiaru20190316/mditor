import { describe, expect, it } from "vitest";
import { setPendingJumpAnno, takePendingJumpAnno } from "./annoHandoff";
import type { Annotation } from "./annotations";

const anno = (id: string): Annotation => ({
  id,
  marker: parseInt(id.slice(5), 10),
  content: "c",
  codeLine: null,
});

describe("annoHandoff（侧栏跳转 → 弹层首击的一次性传递）", () => {
  it("returns the annotation only for the matching id, once", () => {
    setPendingJumpAnno(anno("anno-7"));
    expect(takePendingJumpAnno("anno-8")).toBeNull();
    // 不匹配的取走也清空槽位（一次性语义）。
    expect(takePendingJumpAnno("anno-7")).toBeNull();
  });

  it("matching take consumes the slot", () => {
    setPendingJumpAnno(anno("anno-3"));
    expect(takePendingJumpAnno("anno-3")?.id).toBe("anno-3");
    expect(takePendingJumpAnno("anno-3")).toBeNull();
  });

  it("null handoff is a no-op", () => {
    setPendingJumpAnno(null);
    expect(takePendingJumpAnno("anno-1")).toBeNull();
  });
});
