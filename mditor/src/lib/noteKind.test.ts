// MF 轮：isReadonlyTab 收敛判别的单测——html/pdf/docx 三类只读全 true，
// md（含 undefined kind）与非标签全 false。这是「全仓只读判别一致性」的
// 锚点：App/TabsBar 的消费点一律经 noteKind.isReadonlyTab，语义漂移在此钉死。
// DE 轮：三判别拆分锚定（任务书 §4.3）——isReadonlyTab 语义更新为「md 管线
// 隔离（含编辑态恒真）」，isDocEditActive / isViewOnlyTab 承载条件只读。

import { describe, expect, it } from "vitest";

import { isReadonlyTab, isDocEditActive, isViewOnlyTab } from "./noteKind";
import { makeHtmlTab } from "./htmlNote";
import { makeDocxTab, makePdfTab } from "./docNote";
import type { TabItem } from "../types";

const mdTab: TabItem = {
  key: "untitled-1",
  path: null,
  name: "未命名.md",
  dirty: false,
  content: "",
};

describe("isReadonlyTab", () => {
  it("html / pdf / docx 三类只读视图全 true", () => {
    expect(isReadonlyTab(makeHtmlTab("C:/a.html"))).toBe(true);
    expect(isReadonlyTab(makePdfTab("C:/a.pdf"))).toBe(true);
    expect(isReadonlyTab(makeDocxTab("C:/a.docx"))).toBe(true);
  });

  it("md（undefined kind 与显式 kind=md）为 false", () => {
    expect(isReadonlyTab(mdTab)).toBe(false);
    expect(isReadonlyTab({ ...mdTab, kind: "md" })).toBe(false);
  });

  it("null / undefined 标签为 false（对齐 isHtmlTab 的宽容形态）", () => {
    expect(isReadonlyTab(null)).toBe(false);
    expect(isReadonlyTab(undefined)).toBe(false);
  });

  it("DE 轮语义更新：编辑态（docEdit）不改变 isReadonlyTab——md 管线隔离含编辑态", () => {
    expect(isReadonlyTab({ ...makePdfTab("C:/a.pdf"), docEdit: true })).toBe(true);
    expect(isReadonlyTab({ ...makeDocxTab("C:/a.docx"), docEdit: true })).toBe(true);
  });
});

// ---- DE 轮：条件只读三判别 ------------------------------------------------------

describe("isDocEditActive / isViewOnlyTab（DE 轮拆分）", () => {
  it("未编辑：pdf/docx/html 全为 view-only，docEdit 全 false", () => {
    expect(isDocEditActive(makePdfTab("C:/a.pdf"))).toBe(false);
    expect(isDocEditActive(makeDocxTab("C:/a.docx"))).toBe(false);
    expect(isDocEditActive(makeHtmlTab("C:/a.html"))).toBe(false); // html 无编辑态
    expect(isViewOnlyTab(makePdfTab("C:/a.pdf"))).toBe(true);
    expect(isViewOnlyTab(makeDocxTab("C:/a.docx"))).toBe(true);
    expect(isViewOnlyTab(makeHtmlTab("C:/a.html"))).toBe(true);
  });

  it("编辑态 pdf/docx：isDocEditActive 真且 isReadonlyTab 仍真，isViewOnlyTab 翻 false", () => {
    const editingPdf = { ...makePdfTab("C:/a.pdf"), docEdit: true };
    const editingDocx = { ...makeDocxTab("C:/a.docx"), docEdit: true };
    expect(isDocEditActive(editingPdf)).toBe(true);
    expect(isDocEditActive(editingDocx)).toBe(true);
    // 铁律：编辑态不改变 md 管线隔离语义（不进 useFile/docCache/自动保存…）。
    expect(isReadonlyTab(editingPdf)).toBe(true);
    expect(isReadonlyTab(editingDocx)).toBe(true);
    // 编辑态不再是 view-only——dirty 圆点/关闭确认/Ctrl+S 生效的判定源。
    expect(isViewOnlyTab(editingPdf)).toBe(false);
    expect(isViewOnlyTab(editingDocx)).toBe(false);
  });

  it("docEdit=false（显式退出写回）与 undefined 等价；md 标签的 docEdit 字段不生效", () => {
    expect(isDocEditActive({ ...makePdfTab("C:/a.pdf"), docEdit: false })).toBe(false);
    expect(isViewOnlyTab({ ...makePdfTab("C:/a.pdf"), docEdit: false })).toBe(true);
    // 防御：docEdit 只对 pdf/docx kind 有意义（App 不写 md 的 docEdit，钉死语义）。
    expect(isDocEditActive({ ...mdTab, kind: "md", docEdit: true })).toBe(false);
    expect(isReadonlyTab({ ...mdTab, kind: "md", docEdit: true })).toBe(false);
  });

  it("null / undefined 宽容形态", () => {
    expect(isDocEditActive(null)).toBe(false);
    expect(isViewOnlyTab(undefined)).toBe(false);
  });
});
