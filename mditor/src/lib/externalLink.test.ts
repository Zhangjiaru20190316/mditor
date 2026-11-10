// externalLink 单测（v5.3.x 外部关联）：resolveLinkScope 继承级联、
// shouldReactToChange / shouldWatchPath 反应判定、toggleFolderRule 快捷
// 开关往返。纯函数测试；tauriFs 依赖按 tauriFs.test.ts 同款范式 mock 平台层。

import { describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({
  detectRuntime: () => "tauri" as const,
  getAdapter: () => ({ fs: {} }),
}));

import {
  resolveLinkScope,
  shouldReactToChange,
  shouldWatchPath,
  toggleFolderRule,
} from "./externalLink";
import type { RootLinkOptions } from "../types";

const ALL = new Set(["md", "html", "pdf", "docx"]);
const kindSet = (ks: string[]) => new Set(ks);
const ROOTS = ["C:/ws"];
/** 契约：getOpts 返回 Record<根, 配置> 映射（App 传 settings.externalLinkOptions）。 */
const identity = (o: RootLinkOptions | undefined) =>
  () => ({ "C:/ws": o }) as Record<string, RootLinkOptions>;

describe("resolveLinkScope：继承级联（就近覆盖）", () => {
  it("无配置 = 关联 + 全部四类（既有行为零变化）", () => {
    expect(resolveLinkScope(undefined, "")).toEqual({ enabled: true, kinds: ALL });
    expect(resolveLinkScope(undefined, "a/b/c")).toEqual({ enabled: true, kinds: ALL });
    expect(resolveLinkScope({}, "a/b")).toEqual({ enabled: true, kinds: ALL });
  });

  it("根级开关与类型子集向下继承", () => {
    const opts: RootLinkOptions = { enabled: false, fileTypes: ["md"] };
    expect(resolveLinkScope(opts, "")).toEqual({ enabled: false, kinds: kindSet(["md"]) });
    expect(resolveLinkScope(opts, "notes/drafts")).toEqual({
      enabled: false,
      kinds: kindSet(["md"]),
    });
  });

  it("文件夹显式关：该子树全部断开", () => {
    const opts: RootLinkOptions = { folders: { assets: { enabled: false } } };
    expect(resolveLinkScope(opts, "assets").enabled).toBe(false);
    expect(resolveLinkScope(opts, "assets/deep/dir").enabled).toBe(false);
    expect(resolveLinkScope(opts, "assetsX").enabled).toBe(true); // 前缀不误伤
    expect(resolveLinkScope(opts, "notes").enabled).toBe(true);
  });

  it("父断开、子显式恢复：仅该子树恢复（就近覆盖）", () => {
    const opts: RootLinkOptions = {
      enabled: false,
      folders: { "a/b": { enabled: true } },
    };
    expect(resolveLinkScope(opts, "a").enabled).toBe(false);
    expect(resolveLinkScope(opts, "a/b").enabled).toBe(true);
    expect(resolveLinkScope(opts, "a/b/deep").enabled).toBe(true);
    expect(resolveLinkScope(opts, "a/c").enabled).toBe(false);
  });

  it("类型覆盖：子级子集收窄；子级全选四类恢复全部并继续向下继承", () => {
    const opts: RootLinkOptions = {
      fileTypes: ["md", "html"],
      folders: {
        pdfs: { fileTypes: ["pdf"] },
        "pdfs/back": { fileTypes: ["md", "html", "pdf", "docx"] },
      },
    };
    expect(resolveLinkScope(opts, "notes").kinds).toEqual(kindSet(["md", "html"]));
    expect(resolveLinkScope(opts, "pdfs").kinds).toEqual(kindSet(["pdf"]));
    // 全选四类在子级是显式覆盖（归一层保留），且向更深层继承
    expect(resolveLinkScope(opts, "pdfs/back").kinds).toEqual(ALL);
    expect(resolveLinkScope(opts, "pdfs/back/x").kinds).toEqual(ALL);
  });

  it("开关与类型独立级联（同一规则对象各自就近）", () => {
    const opts: RootLinkOptions = {
      enabled: false,
      fileTypes: ["md"],
      folders: { on: { enabled: true }, kinds: { fileTypes: ["pdf"] } },
    };
    expect(resolveLinkScope(opts, "on")).toEqual({ enabled: true, kinds: kindSet(["md"]) });
    expect(resolveLinkScope(opts, "kinds")).toEqual({ enabled: false, kinds: kindSet(["pdf"]) });
  });
});

describe("shouldReactToChange：事件路径反应判定", () => {
  it("不在任何根下 → 不反应", () => {
    expect(shouldReactToChange("D:/other/a.md", ROOTS, identity(undefined))).toBe(false);
  });

  it("默认配置：md 反应、目录反应、png 与隐藏项不反应", () => {
    const get = identity(undefined);
    expect(shouldReactToChange("C:/ws/a.md", ROOTS, get)).toBe(true);
    expect(shouldReactToChange("C:/ws/notes/b.markdown", ROOTS, get)).toBe(true);
    expect(shouldReactToChange("C:/ws/notes", ROOTS, get)).toBe(true); // 目录（无扩展名）
    expect(shouldReactToChange("C:/ws/img.png", ROOTS, get)).toBe(false);
    expect(shouldReactToChange("C:/ws/.hidden.md", ROOTS, get)).toBe(false);
  });

  it("断开的文件夹：文件与目录事件均不反应；子级显式恢复的反应", () => {
    const opts: RootLinkOptions = { folders: { assets: { enabled: false }, "assets/keep": { enabled: true } } };
    const get = identity(opts);
    expect(shouldReactToChange("C:/ws/assets/a.md", ROOTS, get)).toBe(false);
    expect(shouldReactToChange("C:/ws/assets/sub", ROOTS, get)).toBe(false);
    expect(shouldReactToChange("C:/ws/assets/keep/b.md", ROOTS, get)).toBe(true);
    expect(shouldReactToChange("C:/ws/assets/keep/sub", ROOTS, get)).toBe(true);
  });

  it("生效类型过滤：md 事件不反应、pdf 反应；目录事件不受类型影响", () => {
    const opts: RootLinkOptions = { folders: { p: { fileTypes: ["pdf"] } } };
    const get = identity(opts);
    expect(shouldReactToChange("C:/ws/p/a.md", ROOTS, get)).toBe(false);
    expect(shouldReactToChange("C:/ws/p/a.pdf", ROOTS, get)).toBe(true);
    expect(shouldReactToChange("C:/ws/p/sub", ROOTS, get)).toBe(true);
  });

  it("Windows 反斜杠事件路径（toPosix 归一）与大小写漂移", () => {
    const get = identity({ folders: { notes: { enabled: false } } } as RootLinkOptions);
    expect(shouldReactToChange("C:\\WS\\NOTES\\a.md", ROOTS, get)).toBe(false);
    expect(shouldReactToChange("C:\\ws\\a.md", ROOTS, get)).toBe(true);
  });
});

describe("shouldWatchPath：打开文件订阅判定", () => {
  it("默认关联 → 订阅；断开目录 → 不订阅", () => {
    const opts: RootLinkOptions = { folders: { frozen: { enabled: false } } };
    expect(shouldWatchPath("C:/ws/a.md", ROOTS, identity(undefined))).toBe(true);
    expect(shouldWatchPath("C:/ws/frozen/a.md", ROOTS, identity(opts))).toBe(false);
  });

  it("类型不在生效集合 → 不订阅；根外文件维持订阅（既有行为）", () => {
    const opts: RootLinkOptions = { folders: { p: { fileTypes: ["pdf"] } } };
    expect(shouldWatchPath("C:/ws/p/a.md", ROOTS, identity(opts))).toBe(false);
    expect(shouldWatchPath("C:/ws/p/a.pdf", ROOTS, identity(opts))).toBe(true);
    expect(shouldWatchPath("D:/elsewhere/a.md", ROOTS, identity(opts))).toBe(true);
  });
});

describe("toggleFolderRule：快捷开关往返", () => {
  it("默认配置上断开 → 写显式 false；再切换（父级开）→ 回到继承（删键）", () => {
    const off = toggleFolderRule(undefined, "assets");
    expect(off).toEqual({ folders: { assets: { enabled: false } } });
    const back = toggleFolderRule(off, "assets");
    expect(back).toBeUndefined(); // 全空 → 调用方删键
  });

  it("父级断开时切换子级 → 显式 true 恢复；再切换 → 显式 false", () => {
    const base: RootLinkOptions = { enabled: false };
    const on = toggleFolderRule(base, "a/b");
    expect(on).toEqual({ enabled: false, folders: { "a/b": { enabled: true } } });
    const off = toggleFolderRule(on, "a/b");
    expect(off?.folders?.["a/b"]).toEqual({ enabled: false });
    expect(off?.enabled).toBe(false); // 根级字段保留
  });

  it("删 enabled 时保留同规则的其他字段（fileTypes）", () => {
    const opts: RootLinkOptions = { folders: { x: { enabled: false, fileTypes: ["md"] } } };
    const next = toggleFolderRule(opts, "x");
    expect(next).toEqual({ folders: { x: { fileTypes: ["md"] } } });
  });

  it("深层子目录的切换只影响自身键；根级开关不走此函数", () => {
    const opts: RootLinkOptions = { folders: { a: { enabled: false } } };
    const next = toggleFolderRule(opts, "a/b/c");
    expect(next).toEqual({
      folders: { a: { enabled: false }, "a/b/c": { enabled: true } },
    });
    expect(toggleFolderRule(opts, "")).toBe(opts);
  });
});
