// DE 轮（M1）：docNoteEdit 状态机单测——生命周期（enter→editing→saving）、
// 切走/切回缓冲序列化、放弃释放、外部修改校验（mtime/size 指纹）。
// 平台适配层 mock 对齐 htmlNote.test.ts 惯例（getAdapter 调用时求值）。

import { describe, expect, it, vi, beforeEach } from "vitest";

// 可变 fs mock：各用例切换 stat 返回（mtime/size 指纹）。
let statCalls: string[] = [];
let mockStat: { size: number; mtime: Date | null };

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    runtime: "tauri",
    fs: {
      stat: (p: string) => {
        statCalls.push(p);
        return Promise.resolve({
          isFile: true,
          isDirectory: false,
          size: mockStat.size,
          mtime: mockStat.mtime,
        });
      },
    },
    capabilities: { docNoteEdit: true },
  }),
}));

import {
  __resetDocEditForTest,
  beginEditing,
  discardDocEdit,
  endSaving,
  enterDocEdit,
  getDocEditState,
  markSaving,
  resumeDocEdit,
  suspendDocEdit,
  updateDocEditBuffer,
  verifyBaseUnchanged,
} from "./docNoteEdit";
import { pdfLineKey } from "./docNote";

const PDF = "C:/Notes/de.pdf";
const DOCX = "C:/Notes/de.docx";

beforeEach(() => {
  __resetDocEditForTest();
  statCalls = [];
  mockStat = { size: 1000, mtime: new Date("2026-11-01T10:00:00Z") };
  vi.clearAllMocks();
});

describe("生命周期", () => {
  it("enterDocEdit 捕获指纹并建 converting 条目；beginEditing 翻相位", async () => {
    const st = await enterDocEdit(PDF);
    expect(st.phase).toBe("converting");
    expect(st.baseSize).toBe(1000);
    expect(st.baseMtime).toBe(new Date("2026-11-01T10:00:00Z").getTime());
    expect(st.patches).toEqual([]);
    beginEditing(PDF);
    expect(getDocEditState(PDF)?.phase).toBe("editing");
  });

  it("重复 enter（已编辑）保持缓冲不重置；saving 相位则重建", async () => {
    await enterDocEdit(PDF);
    beginEditing(PDF);
    updateDocEditBuffer(PDF, { htmlBuffer: "<p>x</p>" });
    const again = await enterDocEdit(PDF);
    expect(again.htmlBuffer).toBe("<p>x</p>");
    expect(again.phase).toBe("editing");
    markSaving(PDF);
    const third = await enterDocEdit(PDF); // saving 中重进 = 新会话（指纹刷新）
    expect(third.phase).toBe("converting");
    expect(third.htmlBuffer).toBeUndefined();
  });

  it("markSaving/endSaving 往返；endSaving 对无条目安全", () => {
    expect(() => endSaving(PDF)).not.toThrow();
  });

  it("key 按格式前缀隔离：pdf 与 docx 同路径互不碰撞（docTabKey 语义）", async () => {
    const a = await enterDocEdit("C:/x/a.pdf");
    const b = await enterDocEdit("C:/x/a.docx");
    updateDocEditBuffer("C:/x/a.pdf", { htmlBuffer: "pdf-buffer" });
    expect(getDocEditState("C:/x/a.docx")?.htmlBuffer).toBeUndefined();
    expect(b.baseSize).toBe(a.baseSize);
    expect(getDocEditState("C:/x/a.pdf")?.htmlBuffer).toBe("pdf-buffer");
  });
});

describe("切走/切回（buffer 序列化）", () => {
  it("suspend → resume 保缓冲；discard 释放条目", async () => {
    await enterDocEdit(DOCX);
    beginEditing(DOCX);
    suspendDocEdit(DOCX, { htmlBuffer: "<h1>serialized</h1>" });
    const st = resumeDocEdit(DOCX);
    expect(st?.htmlBuffer).toBe("<h1>serialized</h1>");
    expect(resumeDocEdit("C:/none.pdf")).toBeNull();
    discardDocEdit(DOCX);
    expect(getDocEditState(DOCX)).toBeNull();
    // suspend/discard 对无条目路径安全（视图卸载竞态兜底）。
    expect(() => suspendDocEdit(DOCX, { htmlBuffer: "x" })).not.toThrow();
    expect(() => discardDocEdit(DOCX)).not.toThrow();
  });

  it("PDF patches 全量覆盖更新（唯一事实源语义）", async () => {
    await enterDocEdit(PDF);
    beginEditing(PDF);
    const p1 = {
      page: 1,
      lineKey: pdfLineKey(1, 720, 72),
      origText: "旧文本",
      newText: "新文本",
      bbox: [71, 716, 370, 736] as [number, number, number, number],
      baseline: { x: 72, y: 720 },
      fontSize: 14,
    };
    updateDocEditBuffer(PDF, { patches: [p1] });
    expect(getDocEditState(PDF)?.patches).toHaveLength(1);
    updateDocEditBuffer(PDF, { patches: [] });
    expect(getDocEditState(PDF)?.patches).toHaveLength(0);
  });
});

describe("外部修改校验（保存前防覆盖）", () => {
  it("指纹一致 → unchanged", async () => {
    await enterDocEdit(PDF);
    const r = await verifyBaseUnchanged(PDF);
    expect(r.unchanged).toBe(true);
  });

  it("size 变化或 mtime 变化 → unchanged=false（任一即触发）", async () => {
    await enterDocEdit(PDF);
    mockStat = { size: 2000, mtime: new Date("2026-11-01T10:00:00Z") };
    expect((await verifyBaseUnchanged(PDF)).unchanged).toBe(false);
    mockStat = { size: 1000, mtime: new Date("2026-11-01T11:00:00Z") };
    expect((await verifyBaseUnchanged(PDF)).unchanged).toBe(false);
  });

  it("mtime 为 null（平台未提供）时退化为仅 size 判定", async () => {
    mockStat = { size: 1000, mtime: null };
    await enterDocEdit(PDF);
    mockStat = { size: 1000, mtime: new Date("2026-11-01T12:00:00Z") };
    expect((await verifyBaseUnchanged(PDF)).unchanged).toBe(true);
  });

  it("无条目（已退出编辑）→ unchanged=false（保守：不覆盖）", async () => {
    const r = await verifyBaseUnchanged(PDF);
    expect(r.unchanged).toBe(false);
  });
});
