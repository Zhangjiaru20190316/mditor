// @vitest-environment jsdom
// useFile 保存防护单测（v5.3.x 外部关联）：断开外部关联的文件写盘前做
// 内容级比对——磁盘被外部改动即冲突。范式沿用 useFile.docPathSync.test.ts
// （React Probe + mock 平台层）。锁死语义：
//   * 关联文件（shouldGuardWrite=false）→ 零校验，既有行为零变化
//   * 防护文件：磁盘===基线 → 正常写；磁盘===将写内容 → 免写收尾（same）
//   * 冲突：writeOnly 缺省静默跳过（false）；confirmOnConflict=true 弹确认，
//     确认覆盖 / 取消中止
//   * 基线未知（showDoc 脏快照）→ fail-open 放行；写盘成功后重建基线

import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { useFile } from "./useFile";

const mockFs = vi.hoisted(() => ({
  diskContent: new Map<string, string>(),
  readTextFile: vi.fn(async (p: string) => {
    const c = mockFs.diskContent.get(p);
    if (c === undefined) throw new Error("ENOENT: " + p);
    return c;
  }),
}));

vi.mock("../lib/store", () => ({
  pushRecent: vi.fn(async () => {}),
}));

vi.mock("../lib/tauriFs", () => ({
  openMd: vi.fn(async () => null),
  saveMd: vi.fn(async () => {}),
  saveMdAs: vi.fn(async () => "E:/new/path.md"),
  baseName: (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p,
}));

vi.mock("../platform", () => ({
  getAdapter: () => ({ fs: mockFs }),
}));

const confirmDialog = vi.fn<(msg: string, title?: string) => Promise<boolean>>();
vi.mock("../lib/dialogs", () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(a[0] as string, a[1] as string),
}));

import { saveMd } from "../lib/tauriFs";

const PATH = "E:/ws/frozen/a.md";
const BASE = "# 原始内容";
const EDITED = "# 原始内容\n新段落";
const EXTERNAL = "# 外部程序改写过";

let api: ReturnType<typeof useFile> | null = null;

function Probe({ guard }: { guard: boolean }): null {
  api = useFile(guard ? { shouldGuardWrite: () => true } : undefined);
  return null;
}

async function mount(guard = true): Promise<ReturnType<typeof useFile>> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(Probe, { guard }));
  });
  if (!api) throw new Error("probe did not mount");
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.diskContent.set(PATH, BASE);
  confirmDialog.mockResolvedValue(false);
});

describe("useFile 保存防护（v5.3.x 外部关联）", () => {
  it("关联文件（guard=false）：磁盘被外部改动仍照常写盘——既有行为零变化", async () => {
    const fa = await mount(false);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    mockFs.diskContent.set(PATH, EXTERNAL); // 外部改动
    let ok = false;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED);
    });
    expect(ok).toBe(true);
    expect(saveMd).toHaveBeenCalledWith(PATH, EDITED);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("防护文件：磁盘未动（=== 基线）→ 正常写盘", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    let ok = false;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED);
    });
    expect(ok).toBe(true);
    expect(saveMd).toHaveBeenCalledWith(PATH, EDITED);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("防护文件：外部改动 + 自动保存（缺省）→ 静默跳过（false，不弹确认）", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    mockFs.diskContent.set(PATH, EXTERNAL);
    let ok = true;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED);
    });
    expect(ok).toBe(false);
    expect(saveMd).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("防护文件：外部改动 + 手动保存 → 弹确认；确认后覆盖并重建基线", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    mockFs.diskContent.set(PATH, EXTERNAL);
    // 取消 → 中止，缓冲区保持 dirty。
    confirmDialog.mockResolvedValueOnce(false);
    let ok = true;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED, true);
    });
    expect(ok).toBe(false);
    expect(saveMd).not.toHaveBeenCalled();
    expect(confirmDialog).toHaveBeenCalledWith(
      "文件已被外部程序修改。\n确定覆盖磁盘上的版本并保存？",
      "Mditor"
    );
    // 确认 → 覆盖；基线重建为刚写内容（下次外部改动仍可检出）。
    confirmDialog.mockResolvedValueOnce(true);
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED, true);
    });
    expect(ok).toBe(true);
    expect(saveMd).toHaveBeenCalledWith(PATH, EDITED);
    mockFs.diskContent.set(PATH, "# 又被外部改了");
    let ok2 = true;
    await act(async () => {
      ok2 = await fa.writeOnly(() => EDITED + "2");
    });
    expect(ok2).toBe(false); // 新的外部改动再次被拦截
  });

  it("same：磁盘已等于将写内容 → 免写收尾但返回 true", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    let ok = false;
    await act(async () => {
      ok = await fa.writeOnly(() => BASE);
    });
    expect(ok).toBe(true);
    expect(saveMd).not.toHaveBeenCalled();
  });

  it("基线未知（showDoc 脏快照）→ fail-open 放行；成功写盘后基线重建恢复防护", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.showDoc({ path: PATH, content: BASE, dirty: true });
    });
    mockFs.diskContent.set(PATH, EXTERNAL);
    let ok = false;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED); // 脏快照 + 无基线 → 放行
    });
    expect(ok).toBe(true);
    expect(saveMd).toHaveBeenCalledWith(PATH, EDITED);
    // 基线已重建为 EDITED；新的外部改动被拦截。
    mockFs.diskContent.set(PATH, "# 二次外部改动");
    let ok2 = true;
    await act(async () => {
      ok2 = await fa.writeOnly(() => EDITED + "2");
    });
    expect(ok2).toBe(false);
  });

  it("磁盘读取失败（文件被删）→ 按冲突处理，不写盘", async () => {
    const fa = await mount(true);
    await act(async () => {
      await fa.openPath(PATH, BASE);
    });
    mockFs.diskContent.delete(PATH);
    let ok = true;
    await act(async () => {
      ok = await fa.writeOnly(() => EDITED);
    });
    expect(ok).toBe(false);
    expect(saveMd).not.toHaveBeenCalled();
  });
});
