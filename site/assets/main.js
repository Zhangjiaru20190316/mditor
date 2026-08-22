/* Mditor 官网交互 — 纯 vanilla JS，无依赖。
 * 模块：迷你 Markdown 渲染器（在线试用）、主题/模式切换演示、
 *       滚动进场动画、截图 Lightbox、FAQ 折叠、返回顶部、导航高亮。
 */
(function () {
  "use strict";

  /* ============ 1. 迷你 Markdown 渲染器 ============ */

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeUrl(u) {
    const t = u.trim();
    return /^(https?:\/\/|mailto:)/i.test(t) ? t : "#";
  }

  /* 输入需已做 HTML 转义 */
  function renderInline(text) {
    let s = text;
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      return '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    return s;
  }

  function renderMarkdown(src) {
    const lines = escapeHtml(String(src).replace(/\r\n?/g, "\n")).split("\n");
    const out = [];
    const para = [];
    var i = 0;

    function flushPara() {
      if (para.length) {
        out.push("<p>" + renderInline(para.join(" ")) + "</p>");
        para.length = 0;
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();

      /* 围栏代码块 */
      if (t.slice(0, 3) === "```") {
        flushPara();
        const buf = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "```") {
          buf.push(lines[i]);
          i++;
        }
        i++; /* 跳过收尾围栏 */
        out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
        continue;
      }

      if (t === "") {
        flushPara();
        i++;
        continue;
      }

      /* 标题 */
      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const lv = Math.min(h[1].length, 4);
        out.push("<h" + lv + ">" + renderInline(h[2]) + "</h" + lv + ">");
        i++;
        continue;
      }

      /* 分隔线 */
      if (/^(-{3,}|\*{3,})$/.test(t)) {
        flushPara();
        out.push("<hr>");
        i++;
        continue;
      }

      /* 引用块（转义后 > 为 &gt;） */
      if (t.slice(0, 4) === "&gt;") {
        flushPara();
        const buf = [];
        while (i < lines.length && lines[i].trim().slice(0, 4) === "&gt;") {
          buf.push(lines[i].trim().replace(/^&gt;\s?/, ""));
          i++;
        }
        out.push("<blockquote><p>" + renderInline(buf.join(" ")) + "</p></blockquote>");
        continue;
      }

      /* 表格：当前行含 |，下一行是分隔行 */
      if (
        t.indexOf("|") !== -1 &&
        i + 1 < lines.length &&
        lines[i + 1].trim().indexOf("|") !== -1 &&
        /^\|?\s*:?-{2,}/.test(lines[i + 1].trim())
      ) {
        flushPara();
        const parseRow = function (row) {
          return row
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map(function (c) { return c.trim(); });
        };
        const head = parseRow(t);
        i += 2;
        const body = [];
        while (i < lines.length) {
          const nt = lines[i].trim();
          if (nt === "" || nt.indexOf("|") === -1) break;
          body.push(parseRow(nt));
          i++;
        }
        out.push(
          "<table><thead><tr>" +
            head.map(function (c) { return "<th>" + renderInline(c) + "</th>"; }).join("") +
            "</tr></thead><tbody>" +
            body
              .map(function (r) {
                return "<tr>" + r.map(function (c) { return "<td>" + renderInline(c) + "</td>"; }).join("") + "</tr>";
              })
              .join("") +
            "</tbody></table>"
        );
        continue;
      }

      /* 无序列表 / 任务清单 */
      if (/^[-*]\s+/.test(t)) {
        flushPara();
        const items = [];
        let isTask = false;
        while (i < lines.length) {
          const m = lines[i].trim().match(/^[-*]\s+(.*)$/);
          if (!m) break;
          const task = m[1].match(/^\[( |x|X)\]\s*(.*)$/);
          if (task) {
            isTask = true;
            const checked = task[1].toLowerCase() === "x" ? " checked" : "";
            items.push('<li><input type="checkbox" disabled' + checked + ">" + renderInline(task[2]) + "</li>");
          } else {
            items.push("<li>" + renderInline(m[1]) + "</li>");
          }
          i++;
        }
        out.push("<ul" + (isTask ? ' class="md-task"' : "") + ">" + items.join("") + "</ul>");
        continue;
      }

      /* 有序列表 */
      if (/^\d+[.)]\s+/.test(t)) {
        flushPara();
        const items = [];
        while (i < lines.length) {
          const m = lines[i].trim().match(/^\d+[.)]\s+(.*)$/);
          if (!m) break;
          items.push("<li>" + renderInline(m[1]) + "</li>");
          i++;
        }
        out.push("<ol>" + items.join("") + "</ol>");
        continue;
      }

      para.push(t);
      i++;
    }
    flushPara();
    return out.join("\n") || '<p style="color:var(--muted-2)">（左侧开始输入，右侧实时预览）</p>';
  }

  /* ============ 2. 在线试用 ============ */

  const DEMO_DOC = [
    "# 欢迎使用 Mditor",
    "",
    "在这里输入 **Markdown**，右侧==实时渲染==——就像桌面版一样。",
    "",
    "## 你可以试试",
    "",
    "- **加粗**、*斜体*、`行内代码`、==高光==",
    "- 任务清单：",
    "  - [x] 下载 Mditor",
    "  - [ ] 写下第一篇笔记",
    "- [项目主页](https://github.com/Zhangjiaru20190316/mditor)",
    "",
    "> 支持引用块，适合摘录与批注。",
    "",
    "| 特性 | 浏览器演示 | 桌面版 |",
    "| --- | --- | --- |",
    "| GFM 表格 | ✅ | ✅ |",
    "| 代码高亮 | — | ✅ |",
    "| KaTeX 公式 | — | ✅ |",
    "",
    "```python",
    "def hello():",
    '    print("Hello, Mditor!")  # 桌面版支持高亮',
    "```",
    "",
    "---",
    "",
    "**提示**：选中文字后点上方工具栏按钮，即可包裹语法。",
  ].join("\n");

  const input = document.getElementById("demo-input");
  const output = document.getElementById("demo-output");
  const countEl = document.getElementById("demo-count");

  function updateDemo() {
    if (!input || !output) return;
    output.innerHTML = renderMarkdown(input.value);
    if (countEl) {
      const n = input.value.replace(/\s/g, "").length;
      countEl.textContent = "当前字数：" + n;
    }
  }

  if (input) {
    input.value = DEMO_DOC;
    input.addEventListener("input", updateDemo);
    updateDemo();
  }

  /* 工具栏：包裹选区 / 行前缀 / 插入块 */
  const toolbar = document.getElementById("demo-toolbar");
  const ACTIONS = {
    bold: { type: "wrap", before: "**", after: "**" },
    italic: { type: "wrap", before: "*", after: "*" },
    code: { type: "wrap", before: "`", after: "`" },
    mark: { type: "wrap", before: "==", after: "==" },
    link: { type: "wrap", before: "[", after: "](https://)" },
    h1: { type: "prefix", prefix: "# " },
    h2: { type: "prefix", prefix: "## " },
    ul: { type: "prefix", prefix: "- " },
    quote: { type: "prefix", prefix: "> " },
    table: { type: "block", text: "\n| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |\n" },
  };

  function applyAction(action, ta) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    let sel = value.slice(start, end);
    let next = value;
    let caret = end;

    if (action.type === "wrap") {
      if (!sel) sel = action.before === "**" ? "加粗文字" : action.before === "==" ? "高光文字" : "文字";
      next = value.slice(0, start) + action.before + sel + action.after + value.slice(end);
      caret = start + action.before.length + sel.length;
    } else if (action.type === "prefix") {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lineEndRaw = value.indexOf("\n", end);
      const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw;
      const chunk = value.slice(lineStart, lineEnd);
      const lines = chunk.split("\n");
      const already = lines.every(function (l) { return l.indexOf(action.prefix) === 0 || l === ""; });
      const toggled = lines
        .map(function (l) {
          if (l === "") return l;
          return already ? l.slice(action.prefix.length) : action.prefix + l;
        })
        .join("\n");
      next = value.slice(0, lineStart) + toggled + value.slice(lineEnd);
      caret = lineStart + toggled.length;
    } else if (action.type === "block") {
      next = value.slice(0, start) + action.text + value.slice(end);
      caret = start + action.text.length;
    }

    ta.value = next;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (toolbar) {
    toolbar.addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-md]");
      if (!btn || !input) return;
      e.preventDefault();
      applyAction(ACTIONS[btn.getAttribute("data-md")], input);
    });
  }

  /* ============ 3. 主题与模式切换演示 ============ */

  const editor = document.getElementById("demo-editor");
  const THEME_NAMES = { light: "浅色", dark: "深色", sepia: "护眼", claude: "Claude", "claude-dark": "Claude 深色" };
  const MODE_NAMES = { wysiwyg: "所见即所得", ir: "即时渲染", sv: "源码模式" };

  function bindSwitch(groupId, apply) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.addEventListener("click", function (e) {
      const btn = e.target.closest("button");
      if (!btn) return;
      group.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      apply(btn);
    });
  }

  if (editor) {
    const themeLabel = document.getElementById("de-theme-label");
    const modeLabel = document.getElementById("de-mode-label");
    const modeViews = editor.querySelectorAll("[data-mode-view]");

    bindSwitch("theme-switch", function (btn) {
      editor.setAttribute("data-demo-theme", btn.getAttribute("data-demo-theme"));
      if (themeLabel) themeLabel.textContent = THEME_NAMES[btn.getAttribute("data-demo-theme")] || "";
    });

    bindSwitch("mode-switch", function (btn) {
      const mode = btn.getAttribute("data-mode");
      modeViews.forEach(function (v) {
        v.hidden = v.getAttribute("data-mode-view") !== mode;
      });
      if (modeLabel) modeLabel.textContent = MODE_NAMES[mode] || "";
    });
  }

  /* ============ 4. 滚动进场动画 ============ */

  document.documentElement.classList.add("has-js");
  const revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("revealed");
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -40px 0px", threshold: 0.05 }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("revealed"); });
  }

  /* ============ 5. 截图 Lightbox ============ */

  const lightbox = document.getElementById("lightbox");
  const lightboxImg = lightbox ? lightbox.querySelector("img") : null;
  let lbRaf = 0;

  function closeLightbox() {
    if (!lightbox) return;
    cancelAnimationFrame(lbRaf);
    lightbox.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(function () { lightbox.hidden = true; }, 200);
  }

  if (lightbox && lightboxImg) {
    document.querySelectorAll(".shot-row img").forEach(function (img) {
      img.addEventListener("click", function () {
        lightboxImg.src = img.src;
        lightboxImg.alt = img.alt;
        lightbox.hidden = false;
        /* 强制一帧后再加 show，保证过渡生效；关闭时取消未决帧避免竞态 */
        lbRaf = requestAnimationFrame(function () { lightbox.classList.add("show"); });
        document.body.style.overflow = "hidden";
      });
    });
    lightbox.addEventListener("click", closeLightbox);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !lightbox.hidden) closeLightbox();
    });
  }

  /* ============ 6. FAQ 展开全部 / 收起全部 ============ */

  const faqToggle = document.getElementById("faq-toggle");
  const faqItems = document.querySelectorAll(".faq-list details");
  if (faqToggle && faqItems.length) {
    faqToggle.addEventListener("click", function () {
      const anyClosed = Array.prototype.some.call(faqItems, function (d) { return !d.open; });
      faqItems.forEach(function (d) { d.open = anyClosed; });
      faqToggle.textContent = anyClosed ? "收起全部" : "展开全部";
    });
  }

  /* ============ 7. 返回顶部 ============ */

  const toTop = document.getElementById("to-top");
  if (toTop) {
    window.addEventListener(
      "scroll",
      function () {
        toTop.classList.toggle("show", window.scrollY > 600);
      },
      { passive: true }
    );
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ============ 8. 导航当前区块高亮 ============ */

  const navLinks = document.querySelectorAll(".nav-links a[href^='#']");
  const sections = Array.prototype.map
    .call(navLinks, function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  if ("IntersectionObserver" in window && sections.length) {
    const navIo = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          const id = "#" + en.target.id;
          navLinks.forEach(function (a) {
            a.classList.toggle("active", a.getAttribute("href") === id);
          });
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    sections.forEach(function (s) { navIo.observe(s); });
  }
})();
