#!/usr/bin/env python3
"""Detect which bottom-stack layers are baked into the merged *-底图.png components.
For each screen, composite candidate layer ranges and diff against the merged PNG."""
import os
import sys
import numpy as np
from PIL import Image
from psd_tools import PSDImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "UI组件")

# screen -> (merged bg component, candidate layer-name sequences to test, in order)
CANDIDATES = {
    "CG界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
    ],
    "人物": [
        ["底图", "渐变填充 3", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1", "星光"],
        ["底图", "渐变填充 3", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1"],
    ],
    "商城界面": [
        ["底图", "渐变填充 4", "渐变填充 2", "渐变填充 3", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝"],
    ],
    "回放界面": [
        ["底图", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2"],
        ["底图", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2", "对话回放", "渐变填充 2", "星光"],
        ["底图", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2", "对话回放", "渐变填充 2", "星光", "BACK按钮"],
    ],
    "存:读档界面": [
        ["底图"],
    ],
    "开屏": [
        ["底图", "底图 拷贝", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2", "渐变填充 5 拷贝 3", "星光"],
        ["底图", "底图 拷贝", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2", "渐变填充 5 拷贝 3", "星光", "星轨"],
    ],
    "服装": [
        ["底图", "图层 1", "渐变填充 7", "渐变填充 4", "渐变填充 1", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
        ["底图", "图层 1", "渐变填充 7", "渐变填充 4", "渐变填充 1", "渐变填充 5", "渐变填充 5 拷贝"],
    ],
    "设置界面": [
        ["底图", "渐变填充 3", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1"],
    ],
    "送礼:物品界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
    ],
    "音量:阅读模式界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝"],
        ["底图", "渐变填充 2", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
    ],
}

MERGED = {
    "CG界面": "CG界面-底图.png",
    "人物": "人物界面-底图.png",
    "商城界面": "商城界面-底图.png",
    "回放界面": "回放界面-底图.png",
    "存:读档界面": "存读档界面-底图.png",
    "开屏": "开屏-底图.png",
    "服装": "服装界面-底图.png",
    "设置界面": "设置界面-底图.png",
    "送礼:物品界面": "送礼物品界面-底图.png",
    "音量:阅读模式界面": "音量阅读模式界面-底图.png",
}


def pm_diff(A, B):
    pm = lambda X: np.concatenate([X[:, :, :3] * X[:, :, 3:4] / 255.0, X[:, :, 3:4]], axis=2)
    return float(np.abs(pm(A.astype(np.float32)) - pm(B.astype(np.float32))).mean())


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for screen, seqs in CANDIDATES.items():
        if only and only not in screen:
            continue
        merged = Image.open(os.path.join(UI, MERGED[screen])).convert("RGB")
        psd = PSDImage.open(os.path.join(ROOT, screen + ".psd"))
        flat = []

        def rec(ls):
            for l in ls:
                flat.append(l)
                if l.kind == "group":
                    rec(l)
        rec(list(psd))
        names = [l.name for l in flat]
        print("==", screen, "merged:", MERGED[screen], merged.size)
        for seq in seqs:
            try:
                idxs = set()
                for n in seq:
                    # first occurrence at top level order
                    for i, l in enumerate(flat):
                        if l.name == n and id(l) not in idxs:
                            idxs.add(id(l))
                            break
                filt = lambda l: id(l) in idxs
                comp = psd.composite(layer_filter=filt).convert("RGBA")
                comp = comp.convert("RGB")
                if comp.size != merged.size:
                    comp = comp.resize(merged.size)
                d = pm_diff(np.asarray(comp), np.asarray(merged))
                print("   n=%d diff=%6.2f  %s ... %s" % (len(seq), d, seq[0], seq[-1]))
            except Exception as ex:
                print("   ERROR", seq[0], "...", seq[-1], ex)


if __name__ == "__main__":
    main()
