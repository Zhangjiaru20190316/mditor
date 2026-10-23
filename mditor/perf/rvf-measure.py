# RVF 度量脚本（附录验收方法的沉淀实现；RVF 轮起供各阶段复用）：
#   1) 墨量比：同页同区域暗像素(<128)占比 vec/ras（阶段 2 验收 >= 0.85）
#   2) 语法高亮：代码区（页面 75-92% 高度带）彩色像素数（max-min>30 且
#      max>70）——阶段 0 修复前双模式均为 0，修复后必须 > 0
#   3) 内容流算子计数：0 Tr / 2 Tr / 3 Tr（阶段 1 后 2 Tr 应仅剩 CJK 兜底）
# 用法：python perf/rvf-measure.py <vector.pdf> <raster.pdf> [页数]
import sys
import pymupdf
from PIL import Image

def ink_ratio(img, band=None):
    g = img.convert("L")
    w, h = g.size
    px = g.load()
    y0 = int(h * band[0]) if band else 0
    y1 = int(h * band[1]) if band else h
    dark = total = 0
    for y in range(y0, y1):
        for x in range(w):
            total += 1
            if px[x, y] < 128:
                dark += 1
    return dark / max(total, 1)

def color_pixels(img, band=None):
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    y0 = int(h * band[0]) if band else 0
    y1 = int(h * band[1]) if band else h
    n = 0
    for y in range(y0, y1):
        for x in range(w):
            r, g, b = px[x, y]
            if max(r, g, b) > 70 and max(r, g, b) - min(r, g, b) > 30:
                n += 1
    return n

def tr_counts(doc):
    counts = {0: 0, 1: 0, 2: 0, 3: 0, 7: 0}
    for page in doc:
        contents = page.get_contents()
        for xref in contents if contents and isinstance(contents[0], int) else [c[0] for c in contents]:
            data = doc.xref_stream(xref).decode("latin-1", "ignore")
            for mode in counts:
                counts[mode] += data.count(f"{mode} Tr")
    return counts

def main():
    vec_path, ras_path = sys.argv[1], sys.argv[2]
    pages = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    vec, ras = pymupdf.open(vec_path), pymupdf.open(ras_path)
    print(f"pages: vec={vec.page_count} ras={ras.page_count}")
    print("Tr counts (vec):", tr_counts(vec))
    for i in range(min(pages, vec.page_count)):
        vp = vec[i].get_pixmap(matrix=pymupdf.Matrix(2, 2))
        rp = ras[i].get_pixmap(matrix=pymupdf.Matrix(2, 2))
        vi = Image.frombytes("RGB", (vp.width, vp.height), vp.samples)
        ri = Image.frombytes("RGB", (rp.width, rp.height), rp.samples)
        body = (0.05, 0.7)
        code = (0.75, 0.92)
        v_ink, r_ink = ink_ratio(vi, body), ink_ratio(ri, body)
        print(
            f"p{i}: ink(vec/ras)={v_ink:.4f}/{r_ink:.4f} ratio={v_ink / max(r_ink, 1e-9):.3f} "
            f"colorPx(vec/ras)={color_pixels(vi, code)}/{color_pixels(ri, code)}"
        )

if __name__ == "__main__":
    main()
