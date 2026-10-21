# 矢量导出回归样例（Vector Export Regression）

本文档覆盖 PDF 矢量导出改造的全部验收要素：中英文混排、跨页表格、块级与行内公式、
代码块、引用块、图片（位图 + SVG）、加粗斜体高光等行内样式。导出页数与视觉基线
以本文件为准（perf/rv-*.mjs 驱动）。

The quick brown fox jumps over the lazy dog. 0123456789 —— 中英混排与数字、
半角标点 (parentheses) [brackets] {braces} 与全角标点（括号）《书名》「引号」。

## 行内样式

**加粗文本 bold text** 与 *斜体文本 italic text* 与 `inline code` 与
==高光标记 highlighted== 与 ~~删除线 struck~~ 与 [外部链接](https://example.com)。

## 块级公式与行内公式

$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
\tag{V-1}
$$

欧拉公式 $e^{i\pi} + 1 = 0$ 与质能关系 $E = mc^2$；上标 $x^{n+1}$ 与下标 $a_1, a_2, a_{n}$；
分式 $\frac{1}{1+x^2}$ 与根式 $\sqrt[3]{8}=2$；求和 $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$。

## 代码块

```ts
// TypeScript 代码块：语法高亮 token 是矢量文字覆盖面的采样点
export function fibonacci(n: number): number {
  if (n <= 1) return n; // 递归出口
  return fibonacci(n - 1) + fibonacci(n - 2);
}
const ANSWER = 42; // 中文注释与 English comment
```

## 引用块

> 引用块第一段：竖线与底色是矢量装饰绘制的采样点。
>
> 引用块第二段：跨段引用。

---

## 图片

位图（PNG）：

![红色样图](../perf/fixtures/assets/normal-red.png)

矢量图（SVG）：

![mditor 标志](assets/mditor-promo.svg)

## 跨页表格

下表 24 行数据行，在 A4 / 15mm 边距下必然跨页——验收断页处边框闭合与页首续线：

| 序号 | 方法 Method | 精度 Acc | F1 | 备注 Remark |
| --: | :-- | --: | --: | :-- |
| 1 | Baseline | 82.10 | 80.70 | 基线 |
| 2 | + Ours | 87.40 | 86.20 | 本文方法 |
| 3 | + Ours + Aug | 88.10 | 87.00 | 数据增强 |
| 4 | + Ours + Aug + EMA | 88.60 | 87.50 | 权重平均 |
| 5 | CNN-5 | 81.30 | 79.90 | 五层卷积 |
| 6 | CNN-9 | 83.20 | 81.80 | 九层卷积 |
| 7 | ResNet-18 | 85.40 | 84.10 | 残差网络 |
| 8 | ResNet-34 | 85.90 | 84.70 | 更深残差 |
| 9 | ResNet-50 | 86.30 | 85.00 | 瓶颈结构 |
| 10 | ViT-S | 84.80 | 83.50 | 视觉 Transformer |
| 11 | ViT-B | 86.10 | 84.90 | 大模型 |
| 12 | Swin-T | 86.70 | 85.40 | 滑窗注意力 |
| 13 | Swin-S | 87.10 | 85.80 | 中模型 |
| 14 | MobileNet-V2 | 82.90 | 81.40 | 轻量网络 |
| 15 | MobileNet-V3 | 83.60 | 82.10 | 轻量改进 |
| 16 | EfficientNet-B0 | 84.20 | 82.80 | 复合缩放 |
| 17 | EfficientNet-B4 | 86.00 | 84.80 | 中型缩放 |
| 18 | DenseNet-121 | 85.10 | 83.80 | 稠密连接 |
| 19 | DenseNet-169 | 85.70 | 84.40 | 更稠密 |
| 20 | GCN | 83.90 | 82.50 | 图卷积 |
| 21 | GAT | 84.50 | 83.10 | 图注意力 |
| 22 | Transformer-XL | 85.80 | 84.50 | 长序列 |
| 23 | LSTM | 80.70 | 79.30 | 循环网络 |
| 24 | GRU | 81.00 | 79.60 | 门控循环 |

## 尾部段落

结尾段落用于确认末页收口：The end of the vector export regression document.
中文结尾：矢量导出回归样例到此结束。
