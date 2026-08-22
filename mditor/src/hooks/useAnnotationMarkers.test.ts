// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { stampAnnotationMarkers } from "./useAnnotationMarkers";

// 数字徽章的契约：marker <sup data-label="anno-N"> 必须被盖上
// data-anno-num="N"（annotation.css 的 ::before 用 attr() 画编号，属性缺失
// = 正式版「圆形无数字」bug 的直接形态）。这里测纯 DOM 盖章函数本身。

/** 造一个 Milkdown gfm 渲染形态的批注 marker。 */
function marker(label: string): HTMLElement {
  const sup = document.createElement("sup");
  sup.setAttribute("data-type", "footnote_reference");
  sup.setAttribute("data-label", label);
  sup.textContent = label;
  return sup;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("stampAnnotationMarkers", () => {
  it("从 data-label 提取编号写入 data-anno-num", () => {
    document.body.append(marker("anno-3"), marker("anno-12"));
    expect(stampAnnotationMarkers()).toBe(true);
    const sups = [...document.querySelectorAll("sup")];
    expect(sups[0].getAttribute("data-anno-num")).toBe("3");
    expect(sups[1].getAttribute("data-anno-num")).toBe("12");
  });

  it("幂等：值已正确时不产生任何 DOM 写入（零 MutationRecord）", () => {
    document.body.append(marker("anno-1"));
    stampAnnotationMarkers();
    const p = document.createElement("p");
    p.append(marker("anno-2"));
    document.body.append(p);
    stampAnnotationMarkers();
    const mo = new MutationObserver(() => {});
    mo.observe(document.body, { subtree: true, attributes: true });
    stampAnnotationMarkers();
    const records = mo.takeRecords();
    mo.disconnect();
    expect(records).toHaveLength(0);
  });

  it("编号过期（外部改错）时重写为 label 的编号", () => {
    const sup = marker("anno-7");
    sup.setAttribute("data-anno-num", "99");
    document.body.append(sup);
    stampAnnotationMarkers();
    expect(sup.getAttribute("data-anno-num")).toBe("7");
  });

  it("非 anno-N 形态不盖章：普通脚注 label 与非数字后缀都跳过", () => {
    const plain = marker("footnote-1");
    const bad = marker("anno-abc");
    document.body.append(plain, bad);
    // anno-abc 匹配 [data-label^="anno-"] 前缀（pass 不早退），但数字正则
    // 不匹配 → 不写编号。
    expect(stampAnnotationMarkers()).toBe(true);
    expect(plain.hasAttribute("data-anno-num")).toBe(false);
    expect(bad.hasAttribute("data-anno-num")).toBe(false);
  });

  it("无批注节点时早退返回 false", () => {
    const p = document.createElement("p");
    p.textContent = "hello";
    document.body.append(p);
    expect(stampAnnotationMarkers()).toBe(false);
  });

  it("marker-only 段落获得 anno-row-item（代码块批注行 inline 化前提）", () => {
    const p = document.createElement("p");
    p.append(marker("anno-1"), document.createElement("br"));
    document.body.append(p);
    stampAnnotationMarkers();
    expect(p.classList.contains("anno-row-item")).toBe(true);
  });

  it("prose 段落（marker 与正文混排）不获得 anno-row-item", () => {
    const p = document.createElement("p");
    p.append(document.createTextNode("正文 "), marker("anno-1"));
    document.body.append(p);
    stampAnnotationMarkers();
    expect(p.classList.contains("anno-row-item")).toBe(false);
  });
});
