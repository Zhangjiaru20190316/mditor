// DE 轮阶段 0 spike ④-A：mammoth 承载边界清单（Node）。
//
// 手工构造含「Word 特有结构」的 docx（jszip 拼 OOXML），用 mammoth 转 HTML，
// 逐项记录承载情况（产出标签 / 降级文本 / 静默丢失 / messages 告警）：
//   多级标题、加粗斜体、超链接、有序/无序列表、合并单元格表格（gridSpan/vMerge）、
//   脚注引用、文本框（w:txbxContent）、SmartArt（mc:AlternateContent 占位）、
//   分页符、内嵌图片、目录域（TOC field）。
// 结果打印 JSON（报告人工整理）。
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import mammothPkg from "mammoth";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "perf", "de-spike", "out");
const mammoth = mammothPkg.default ?? mammothPkg;

// 最小 PNG（1x1 红）——图片夹具
const PNG1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:v="urn:schemas-microsoft-com:vml"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
<w:body>
  <!-- 1 多级标题 + 2 加粗斜体 + 3 超链接 -->
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>一级标题 Title H1</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>二级标题 Title H2</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗片段</w:t></w:r><w:t xml:space="preserve"> 与 </w:t><w:r><w:rPr><w:i/></w:rPr><w:t>斜体片段</w:t></w:r></w:p>
  <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>外部超链接文字</w:t></w:r></w:hyperlink></w:p>

  <!-- 4 有序/无序列表（numbering.xml） -->
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>编号项 A</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>编号项 B</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>圆点项甲</w:t></w:r></w:p>

  <!-- 5 合并单元格表格：首行 gridSpan=2；左列纵向 vMerge -->
  <w:tbl>
    <w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
      <w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/>
      <w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/>
    </w:tblBorders></w:tblPr>
    <w:tr>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>表头横跨两列</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>纵向合并起点</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>右侧单元 1</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
      <w:tc><w:p><w:r><w:t>右侧单元 2</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>

  <!-- 6 脚注引用 -->
  <w:p><w:r><w:t>正文带脚注</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:t>（脚注挂在句尾）</w:t></w:r></w:p>

  <!-- 7 文本框（VML w:txbxContent） -->
  <w:p><w:r><w:pict>
    <v:shape id="tb1" style="width:180pt;height:60pt"><v:textbox>
      <w:txbxContent><w:p><w:r><w:t>文本框内部文字 TextBox Content</w:t></w:r></w:p></w:txbxContent>
    </v:textbox></v:shape>
  </w:pict></w:r></w:p>

  <!-- 8 SmartArt：Word 实际用 mc:AlternateContent 包 w:dgm + DrawingML 兜底 -->
  <w:p><w:r>
    <mc:AlternateContent>
      <mc:Choice Requires="wps">
        <w:drawing><wp:inline><wp:extent cx="3600000" cy="1800000"/>
          <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
            <dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
              r:dm="rIdDgm1" r:lo="rIdDgm2" r:qs="rIdDgm3" r:cs="rIdDgm4"/>
          </a:graphicData></a:graphic>
        </wp:inline></w:drawing>
      </mc:Choice>
      <mc:Fallback>
        <w:pict><v:rect style="width:280pt;height:120pt" fillcolor="#eeeeee">
          <v:textbox><w:txbxContent><w:p><w:r><w:t>SmartArt 兜底文字 Fallback</w:t></w:r></w:p></w:txbxContent></v:textbox>
        </v:rect></w:pict>
      </mc:Fallback>
    </mc:AlternateContent>
  </w:r></w:p>

  <!-- 9 分页符 -->
  <w:p><w:r><w:br w:type="page"/></w:r></w:p>
  <w:p><w:r><w:t>分页后的段落</w:t></w:r></w:p>

  <!-- 10 内嵌图片 -->
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:nvPicPr><pic:cNvPr id="1" name="img1"/><pic:cNvPicPr/></pic:nvPicPr>
        <pic:blipFill><a:blip r:embed="rIdImg1"/></pic:blipFill>
        <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
      </pic:pic>
    </a:graphicData></a:graphic>
  </wp:inline></w:drawing></w:r></w:p>

  <!-- 11 TOC 域 -->
  <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:t>目录域缓存文字 TOC cached text</w:t></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:body></w:document>`;

const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="1"><w:p><w:r><w:t>这是脚注正文 Footnote body text</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/></w:style>
</w:styles>`;

async function buildDocx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const w = zip.folder("word");
  w.file("document.xml", documentXml);
  w.file("numbering.xml", numberingXml);
  w.file("footnotes.xml", footnotesXml);
  w.file("styles.xml", stylesXml);
  w.folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docx-spike" TargetMode="External"/>
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`);
  w.folder("media").file("image1.png", PNG1x1);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(path.join(OUT, "spike4-features.docx"), buf);
  return buf;
}

const buf = await buildDocx();
const res = await mammoth.convertToHtml({ buffer: buf });
console.log("==== messages ====");
console.log(JSON.stringify(res.messages, null, 2));
console.log("==== html ====");
console.log(res.value);
writeFileSync(path.join(OUT, "spike4-features.html"), res.value);

// 承载判定（逐特征 grep）
const html = res.value;
const checks = {
  "多级标题(h1/h2)": /<h1>/.test(html) && /<h2>/.test(html),
  "加粗<strong>": /<strong>/.test(html),
  "斜体<em>": /<em>/.test(html),
  "超链接<a href>": /<a href="https:\/\/example.com\/docx-spike">/.test(html),
  "有序列表<ol>": /<ol>/.test(html),
  "无序列表<ul>": /<ul>/.test(html),
  "表格<table>": /<table>/.test(html),
  "表头跨列文字": html.includes("表头横跨两列"),
  "纵向合并起点文字": html.includes("纵向合并起点"),
  "脚注引用标记": /footnote|脚注/i.test(html),
  "脚注正文": html.includes("脚注正文 Footnote body text"),
  "文本框文字": html.includes("文本框内部文字 TextBox Content"),
  "SmartArt兜底文字": html.includes("SmartArt 兜底文字 Fallback"),
  "SmartArt主路径文字": /dgm|SmartArt(?! 兜底)/.test(html) && !html.includes("兜底文字 Fallback") ? false : undefined,
  "分页符后段落": html.includes("分页后的段落"),
  "分页符显式(<hr>/break)": /<hr/.test(html),
  "内嵌图片<img>": /<img /.test(html),
  "TOC域缓存文字": html.includes("目录域缓存文字 TOC cached text"),
};
console.log("==== 承载判定 ====");
console.log(JSON.stringify(checks, null, 2));
