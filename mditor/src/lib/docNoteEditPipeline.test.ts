// @vitest-environment jsdom
// DE 轮 M2：编辑水合管线（表格三步预处理）+ 保存编排单测。
// preprocessMammothHtmlForEdit 纯函数（jsdom DOMParser）；docNoteSave 的
// 保存语义（另存 conflictFreeName / 替换 trash+rebase / 指纹校验）经平台
// 适配层 mock（对齐 htmlNote.test.ts 惯例）。

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- preprocessMammothHtmlForEdit（纯函数，无平台依赖）--------------------------

import { preprocessMammothHtmlForEdit, invalidateDocNoteBytes } from "./docNote";

describe("preprocessMammothHtmlForEdit（spike④ 表格三步配方）", () => {
  it("单元格内 <p> 解包为 <span>（阻断 turndown 原始 HTML 表死亡链）", () => {
    const r = preprocessMammothHtmlForEdit(
      '<table><tr><td><p>甲</p></td><td><p>乙</p></td></tr></table>'
    );
    expect(r.html).toContain("<span>甲</span>");
    expect(r.html).not.toContain("<td><p>");
    expect(r.flattenedSpans).toBe(false);
  });

  it("首行提升 <th>、各行列数补齐到最大列数", () => {
    // 首行 1 格（colspan 拆除后）正文 2 格 → 首行补齐 2 个 th。
    const r = preprocessMammothHtmlForEdit(
      '<table><tr><td colspan="2">表头</td></tr><tr><td><p>a</p></td><td><p>b</p></td></tr></table>'
    );
    expect(r.flattenedSpans).toBe(true); // 检测先于改写
    const ths = (r.html.match(/<th>/g) ?? []).length;
    expect(ths).toBe(2);
    expect(r.html).toContain("<span>a</span>");
  });

  it("colspan/rowspan 属性剥离 + flattenedSpans 置位（降级提示源）", () => {
    const r = preprocessMammothHtmlForEdit(
      '<table><tr><th><p>H</p></th></tr><tr><td rowspan="2"><p>x</p></td></tr></table>'
    );
    expect(r.flattenedSpans).toBe(true);
    expect(r.html).not.toContain("colspan");
    expect(r.html).not.toContain("rowspan");
  });

  it("script/style 剥除（S10 延伸：mammoth 产物进编辑面前的纯化）", () => {
    const r = preprocessMammothHtmlForEdit("<p>ok</p><script>alert(1)</script>");
    expect(r.html).toBe("<p>ok</p>");
  });

  it("无表格文档原样通过（仅剥除危险节点）", () => {
    const r = preprocessMammothHtmlForEdit("<h1>标题</h1><p>段落</p>");
    expect(r.html).toBe("<h1>标题</h1><p>段落</p>");
    expect(r.flattenedSpans).toBe(false);
  });
});

// ---- docNoteSave（平台 mock：fs + trashFile + stat 指纹）------------------------

let written: Array<{ path: string; bytes: Uint8Array }> = [];
let trashed: string[] = [];
let mockStat: { size: number; mtime: Date | null };
let dirEntries: Array<{ name: string; isDirectory: boolean }>;

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri",
  getAdapter: () => ({
    runtime: "tauri",
    fs: {
      stat: (_p: string) => Promise.resolve({ isFile: true, isDirectory: false, size: mockStat.size, mtime: mockStat.mtime }),
      readDir: (_d: string) => Promise.resolve(dirEntries),
      writeFile: (p: string, b: Uint8Array) => {
        written.push({ path: p, bytes: b });
        return Promise.resolve();
      },
    },
    app: {
      trashFile: (p: string) => {
        trashed.push(p);
        return Promise.resolve();
      },
    },
    capabilities: { docNoteEdit: true },
  }),
}));

import {
  __resetDocEditForTest,
  enterDocEdit,
  beginEditing,
  updateDocEditBuffer,
} from "./docNoteEdit";
import { DocNoteConflictError, saveDocNoteEdited } from "./docNoteSave";

const DOCX = "C:/Notes/报告.docx";
const BYTES = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  __resetDocEditForTest();
  written = [];
  trashed = [];
  dirEntries = [];
  mockStat = { size: 100, mtime: new Date("2026-11-01T08:00:00Z") };
  invalidateDocNoteBytes(DOCX);
});

describe("saveDocNoteEdited", () => {
  it("save-as：另存「原名 (编辑版).ext」到源目录，原件不动、不进回收站", async () => {
    await enterDocEdit(DOCX);
    const r = await saveDocNoteEdited(DOCX, async () => BYTES, "save-as");
    expect(r.mode).toBe("save-as");
    expect(r.path.endsWith("报告 (编辑版).docx")).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(r.path);
    expect(trashed).toHaveLength(0);
  });

  it("save-as 冲突：conflictFreeName 递增（绝不覆盖既有文件）", async () => {
    await enterDocEdit(DOCX);
    dirEntries = [
      { name: "报告 (编辑版).docx", isDirectory: false },
      { name: "报告 (编辑版) (1).docx", isDirectory: false },
    ];
    const r = await saveDocNoteEdited(DOCX, async () => BYTES, "save-as");
    expect(r.path.endsWith("报告 (编辑版) (2).docx")).toBe(true);
  });

  it("replace：原件先 trash 进回收站，新字节写原路径", async () => {
    await enterDocEdit(DOCX);
    const r = await saveDocNoteEdited(DOCX, async () => BYTES, "replace");
    expect(r.mode).toBe("replace");
    expect(r.path).toBe(DOCX);
    expect(trashed).toEqual([DOCX]);
    expect(written).toEqual([{ path: DOCX, bytes: BYTES }]);
  });

  it("指纹校验失败（外部修改）→ DocNoteConflictError，零写入零回收", async () => {
    await enterDocEdit(DOCX);
    mockStat = { size: 999, mtime: new Date("2026-11-01T09:00:00Z") };
    await expect(
      saveDocNoteEdited(DOCX, async () => BYTES, "save-as")
    ).rejects.toBeInstanceOf(DocNoteConflictError);
    expect(written).toHaveLength(0);
    expect(trashed).toHaveLength(0);
  });

  it("produce 恰被调用一次且产物即写盘内容", async () => {
    await enterDocEdit(DOCX);
    const produce = vi.fn(async () => BYTES);
    await saveDocNoteEdited(DOCX, produce, "save-as");
    expect(produce).toHaveBeenCalledTimes(1);
    expect(written[0].bytes).toBe(BYTES);
  });

  it("无编辑条目（未进入编辑态）→ 保守拒绝（不覆盖）", async () => {
    await expect(
      saveDocNoteEdited(DOCX, async () => BYTES, "replace")
    ).rejects.toBeInstanceOf(DocNoteConflictError);
    expect(trashed).toHaveLength(0);
  });

  it("replace 后状态机重定基准（后续保存按新指纹校验）", async () => {
    await enterDocEdit(DOCX);
    beginEditing(DOCX);
    updateDocEditBuffer(DOCX, { htmlBuffer: "<p>x</p>" });
    await saveDocNoteEdited(DOCX, async () => BYTES, "replace");
    const st = (await import("./docNoteEdit")).getDocEditState(DOCX);
    expect(st).not.toBeNull(); // rebaseAfterReplace 重建了条目
    expect(st?.baseSize).toBe(100);
  });
});
