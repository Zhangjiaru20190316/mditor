"""RVF 追加轮：fontkit CFF 子集校验器 v2（字节级金标准）。

用法: python perf/rvf-subset-verify.py <subset.cff> <glyphs.json> [orig.otf]
  - glyphs.json: 子集 includeGlyph 插入序的原始 gid 列表（下标=子集 gid-1）
对每个字形：
  1. 字节等价：子集 charstring 字节 == 原版同 gid charstring 字节
  2. 执行体检：用所在 FD 的 subrs 执行，越界/空轮廓即报
返回码: 0 全过 / 1 有失败。
"""
import io
import json
import sys

from fontTools.cffLib import CFFFontSet
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont


def bias_for(count: int) -> int:
    if count < 1240:
        return 107
    if count < 33900:
        return 1131
    return 32768


def main() -> int:
    subset_path, glyphs_path = sys.argv[1], sys.argv[2]
    orig_path = sys.argv[3] if len(sys.argv) > 3 else "public/assets/fonts/NotoSansSC-Regular.otf"

    orig_glyph_gids = json.load(open(glyphs_path))

    orig = TTFont(orig_path)
    ocff = orig["CFF "].cff
    otop = ocff[ocff.fontNames[0]]
    ocharset = otop.charset  # gid -> name

    buf = open(subset_path, "rb").read()
    cff = CFFFontSet()
    cff.decompile(io.BytesIO(buf), None)
    top = cff[cff.fontNames[0]]

    print(f"subset charstrings: {len(top.CharStrings)}, glyphs.json: {len(orig_glyph_gids)}")

    byte_bad = []
    exec_bad = []
    n = min(len(orig_glyph_gids), 65535)
    for gid in range(n):
        # 子集侧字节
        name0 = ".notdef" if gid == 0 else "cid%05d" % gid
        try:
            s_cs = top.CharStrings[name0]
        except KeyError:
            exec_bad.append((gid, "charstring missing"))
            continue
        s_bytes = bytes(s_cs.bytecode)
        # 原版侧字节（glyphs[0]=.notdef 对应子集 gid 0，无额外偏移）
        o_gid = orig_glyph_gids[gid]
        o_name = ".notdef" if o_gid == 0 else ocharset[o_gid]
        o_cs = otop.CharStrings[o_name]
        o_bytes = bytes(o_cs.bytecode)
        if gid > 0 and s_bytes != o_bytes:
            byte_bad.append((gid, o_name, len(s_bytes), len(o_bytes)))

        # 执行体检
        try:
            fd = top.FDSelect[gid] if top.FDSelect is not None else 0
        except Exception:  # noqa: BLE001
            fd = 0
        subrs = getattr(top.FDArray[fd].Private, "Subrs", None)
        pen = RecordingPen()
        try:
            s_cs.draw(pen, subrs)
            s_ops = len(pen.value)
        except Exception as e:  # noqa: BLE001
            exec_bad.append((gid, f"{type(e).__name__}: {e}"))
            continue
        # 金标准：与原版同字形在其自身 FD subrs 下执行的 op 数一致
        o_fd2 = otop.FDSelect[o_gid]
        o_subrs = getattr(otop.FDArray[o_fd2].Private, "Subrs", None)
        pen2 = RecordingPen()
        try:
            o_cs.draw(pen2, o_subrs)
            o_ops = len(pen2.value)
        except Exception as e:  # noqa: BLE001
            o_ops = -1
        if s_ops != o_ops:
            exec_bad.append((gid, f"ops {s_ops} != orig {o_ops}"))

    print(f"byte mismatches: {len(byte_bad)}")
    for gid, name, sl, ol in byte_bad[:8]:
        print(f"  gid{gid} ({name}): subset {sl}B vs orig {ol}B")
    print(f"exec failures: {len(exec_bad)}")
    for gid, msg in exec_bad[:8]:
        print(f"  gid{gid}: {msg}")
    if byte_bad or exec_bad:
        return 1
    print("ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
