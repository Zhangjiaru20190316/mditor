// cleanLocalRef / normalizeLocalPath（v4.10.1）的行为锚点：其他编辑器写进
// markdown 的图片引用常带 file:// 前缀、?# 分隔符、percent 编码或 `.`/`..`
// 段，此前 resolveImgSrc 裸拼接导致 convertFileSrc 双重编码或路径带锚点，图
// 片 404。这里锁定两条纯函数的清洗/归一化语义——编辑器（resolveImgSrc）与
// 导出（exporter.inlineLocalImages）共用，漂移会同时影响两条路径。
//
// v4.12.1 补 resolveImgSrc 全链路用例：mock 平台适配器的 convertFileSrc，
// 锁定「markdown 里的引用 → 交给 convertFileSrc 的绝对路径」的完整换算
// （404 修复的消费端语义；两平台实现各自吃这个入参出 asset/mditor-asset URL）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanLocalRef, normalizeLocalPath, resolveImgSrc } from "./imageManager";

const { calls, adapter } = vi.hoisted(() => {
  const calls: string[] = [];
  const adapter = {
    app: {
      convertFileSrc: (p: string) => {
        calls.push(p);
        return `mock-asset://${p}`;
      },
    },
  };
  return { calls, adapter };
});

vi.mock("../platform", () => ({
  getAdapter: () => adapter,
}));

describe("cleanLocalRef（本地图片引用清洗）", () => {
  it("file:// URL → 剥协议取本地路径", () => {
    expect(cleanLocalRef("file:///C:/docs/pic.png")).toBe("C:/docs/pic.png");
    expect(cleanLocalRef("file://C:\\docs\\pic.png")).toBe("C:\\docs\\pic.png");
  });

  it("`?query` / `#fragment` 剥离", () => {
    expect(cleanLocalRef("assets/pic.png?v=2")).toBe("assets/pic.png");
    expect(cleanLocalRef("assets/pic.png#section")).toBe("assets/pic.png");
    expect(cleanLocalRef("assets/pic.png?a=1#b")).toBe("assets/pic.png");
  });

  it("percent 编码解码：Typora 风格 `assets/my%20pic.png`", () => {
    expect(cleanLocalRef("assets/my%20pic.png")).toBe("assets/my pic.png");
    // 中文文件名（URL 编码形态写入 markdown）
    expect(cleanLocalRef("%E5%9B%BE%E7%89%87.png")).toBe("图片.png");
  });

  it("非法编码序列保留原字面（`100%.png` 不是合法 percent 编码）", () => {
    expect(cleanLocalRef("assets/100%.png")).toBe("assets/100%.png");
  });

  it("先剥 ?# 再解码：`%3F` / `%23` 解码出的字面 ?/# 得以保留", () => {
    // 文件名本身含问号（磁盘上真实存在的 `what?.png`，作者写成 URL 编码）：
    // 剥离阶段不识别 `%3F`（不是裸 ?），解码阶段还原为字面 ?——属于文件名。
    expect(cleanLocalRef("what%3F.png")).toBe("what?.png");
    expect(cleanLocalRef("a%23b.png")).toBe("a#b.png");
  });

  it("普通引用原样返回（幂等、无副作用）", () => {
    expect(cleanLocalRef("assets/pic.png")).toBe("assets/pic.png");
    expect(cleanLocalRef("C:/docs/pic.png")).toBe("C:/docs/pic.png");
    expect(cleanLocalRef("")).toBe("");
  });
});

describe("normalizeLocalPath（`.`/`..` 段归一化）", () => {
  it("`a/./b` → `a/b`", () => {
    expect(normalizeLocalPath("a/./b")).toBe("a/b");
  });

  it("`a/x/../b` → `a/b`", () => {
    expect(normalizeLocalPath("a/x/../b")).toBe("a/b");
  });

  it("反斜杠归一为正斜杠（Windows 盘符根保留）", () => {
    expect(normalizeLocalPath("C:\\docs\\assets\\..\\pic.png")).toBe(
      "C:/docs/pic.png"
    );
  });

  it("盘符根 `C:/` 归一后保留", () => {
    expect(normalizeLocalPath("C:/./a/b/../c")).toBe("C:/a/c");
  });

  it("UNC `//server/share` 双斜杠语义保留", () => {
    expect(normalizeLocalPath("//server/share/./pic.png")).toBe(
      "//server/share/pic.png"
    );
  });

  it("相对路径上跳段在无根时保留（`../x`）", () => {
    expect(normalizeLocalPath("../x")).toBe("../x");
    expect(normalizeLocalPath("a/../../x")).toBe("../x");
  });

  it("绝对路径根之上的 `..` 不越根（`/a/../../b` → `/b`）", () => {
    expect(normalizeLocalPath("/a/../../b")).toBe("/b");
  });

  it("POSIX 绝对路径归一", () => {
    expect(normalizeLocalPath("/home/./u/../u/pic.png")).toBe(
      "/home/u/pic.png"
    );
  });

  it("重复分隔符折叠、尾部分隔符去除", () => {
    expect(normalizeLocalPath("C://docs//pic.png/")).toBe("C:/docs/pic.png");
  });
});

describe("resolveImgSrc（引用 → convertFileSrc 入参 全链路）", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("远程 / data / blob / asset URL 直通，不碰 convertFileSrc", () => {
    for (const url of [
      "https://example.com/a.png",
      "http://example.com/a.png?x=1",
      "data:image/png;base64,AAAA",
      "blob:https://app/x",
      "asset://localhost/C%3A%2Fx.png",
    ]) {
      expect(resolveImgSrc(url, "C:/docs/n.md")).toBe(url);
    }
    expect(calls).toHaveLength(0);
  });

  it("空引用原样返回", () => {
    expect(resolveImgSrc("", "C:/docs/n.md")).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("相对引用按文档目录解析（%20 编码 / ?# 剥离）", () => {
    expect(resolveImgSrc("assets/pic.png", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/pic.png"
    );
    expect(resolveImgSrc("assets/my%20pic.png", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/my pic.png"
    );
    expect(resolveImgSrc("assets/pic.png?v=2", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/pic.png"
    );
    expect(resolveImgSrc("assets/pic.png#sec", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/pic.png"
    );
  });

  it("`./` 与 `../` 段在最终路径归一化（normalizeLocalPath 收口）", () => {
    expect(resolveImgSrc("./assets/pic.png", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/pic.png"
    );
    expect(resolveImgSrc("../shared/pic.png", "C:/docs/sub/note.md")).toBe(
      "mock-asset://C:/docs/shared/pic.png"
    );
  });

  it("Windows 反斜杠相对引用归一为正斜杠", () => {
    expect(resolveImgSrc("assets\\pic.png", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/pic.png"
    );
  });

  it("中文文件名保持原字（编码是 convertFileSrc 的职责）", () => {
    expect(resolveImgSrc("assets/截图.png", "C:/docs/note.md")).toBe(
      "mock-asset://C:/docs/assets/截图.png"
    );
  });

  it("file:// 绝对引用剥协议后直传（无 docPath 也可用）", () => {
    expect(resolveImgSrc("file:///C:/docs/pic.png", null)).toBe(
      "mock-asset://C:/docs/pic.png"
    );
  });

  it("绝对路径直传；POSIX 与 Windows 盘符两种形态", () => {
    expect(resolveImgSrc("C:\\pics\\a.png", null)).toBe("mock-asset://C:/pics/a.png");
    expect(resolveImgSrc("/home/u/a.png", null)).toBe("mock-asset:///home/u/a.png");
  });

  it("无 docPath 的相对引用尽力直传（best effort，不抛）", () => {
    expect(resolveImgSrc("assets/pic.png", null)).toBe("mock-asset://assets/pic.png");
  });

  it("convertFileSrc 抛异常时回退原引用（渲染层保底）", () => {
    const orig = adapter.app.convertFileSrc;
    adapter.app.convertFileSrc = () => {
      throw new Error("boom");
    };
    try {
      expect(resolveImgSrc("assets/pic.png", "C:/docs/n.md")).toBe("assets/pic.png");
    } finally {
      adapter.app.convertFileSrc = orig;
    }
  });
});
