#!/usr/bin/env python3
"""Verify which layers are baked into the merged *-底图.png components,
using our own PIL compositor (psd_tools composite with layer_filter is broken).
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "UI还原", "data")
UI = os.path.join(ROOT, "UI组件")

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

# candidate layer sequences (bottom-stack order) per screen
CANDIDATES = {
    "CG界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝"],
    ],
    "人物": [
        ["底图", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1", "星光"],
        ["底图", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1"],
    ],
    "商城界面": [
        ["底图", "渐变填充 4", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
        ["底图", "渐变填充 4", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝"],
    ],
    "回放界面": [
        ["底图", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2"],
        ["底图", "图层 1", "渐变填充 1", "渐变填充 5 拷贝", "渐变填充 5 拷贝 2", "星光"],
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
        ["底图", "渐变填充 3", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "渐变填充 4", "渐变填充 1", "星光"],
    ],
    "送礼:物品界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
        ["底图", "渐变填充 2", "渐变填充 1", "图层 6", "渐变填充 5", "渐变填充 5 拷贝"],
    ],
    "音量:阅读模式界面": [
        ["底图", "渐变填充 2", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝"],
        ["底图", "渐变填充 2", "渐变填充 1", "图层 1", "渐变填充 5", "渐变填充 5 拷贝", "星光"],
    ],
}


def blend(dst, src, mode):
    """dst, src: float32 (h,w,4) straight-alpha. Returns new dst (straight alpha)."""
    d_rgb, d_a = dst[:, :, :3], dst[:, :, 3:4]
    s_rgb, s_a = src[:, :, :3], src[:, :, 3:4]
    if mode == "NORMAL":
        out_rgb = d_rgb * (1 - s_a) + s_rgb * s_a
        out_a = d_a + s_a * (1 - d_a)
    elif mode == "MULTIPLY":
        out_rgb = d_rgb * s_rgb
        out_a = d_a + s_a * (1 - d_a)
    elif mode == "COLOR_BURN":
        safe = np.clip(s_rgb, 1e-6, 1.0)
        out_rgb = 1.0 - np.clip((1.0 - d_rgb) / safe, 0, 1)
        out_a = d_a + s_a * (1 - d_a)
    elif mode == "LINEAR_DODGE":
        out_rgb = np.clip(d_rgb + s_rgb, 0, 1)
        out_a = d_a + s_a * (1 - d_a)
    elif mode == "SOFT_LIGHT":
        out_rgb = (1 - 2 * s_rgb) * d_rgb * d_rgb + 2 * s_rgb * d_rgb
        out_a = d_a + s_a * (1 - d_a)
    elif mode == "VIVID_LIGHT":
        # crude approximation: darken where src dark, brighten where src bright
        mid = 0.5
        out_rgb = np.where(s_rgb < mid,
                           np.clip(1 - (1 - d_rgb) / np.maximum(2 * s_rgb, 1e-6) * 0 + 0, 0, 1), d_rgb)
        out_rgb = d_rgb * 0.9  # fallback approximation
        out_a = d_a + s_a * (1 - d_a)
    else:
        out_rgb = d_rgb * (1 - s_a) + s_rgb * s_a
        out_a = d_a + s_a * (1 - d_a)
    return np.concatenate([out_rgb, out_a], axis=2)


def load_layer_image(e, screen):
    a = e.get("asset") or {}
    url = a.get("url")
    if not url:
        return None
    p = os.path.normpath(os.path.join(ROOT, "UI还原", url))
    if not os.path.exists(p):
        return None
    return Image.open(p).convert("RGBA")


def composite_stack(layers, screen, W=1920, H=1080):
    """layers: layout entries in bottom->top order."""
    canvas = np.zeros((H, W, 4), dtype=np.float32)
    for e in layers:
        if not e["visible"]:
            continue
        im = load_layer_image(e, screen)
        if im is None:
            continue
        pl = e.get("asset", {}).get("place") or e["bbox"]
        left, top = int(round(pl["left"])), int(round(pl["top"]))
        w = max(1, int(round(pl["width"])))
        h = max(1, int(round(pl["height"])))
        im = im.resize((w, h))
        arr = np.zeros((H, W, 4), dtype=np.float32)
        # paste with clipping to canvas
        x0, y0 = max(0, left), max(0, top)
        x1, y1 = min(W, left + w), min(H, top + h)
        if x1 <= x0 or y1 <= y0:
            continue
        sub = np.asarray(im.crop((x0 - left, y0 - top, x1 - left, y1 - top)), dtype=np.float32) / 255.0
        arr[y0:y1, x0:x1] = sub
        # apply layer opacity
        arr[:, :, 3] *= e["opacity"]
        canvas = blend(canvas, arr, e["blend_mode"].split(".")[-1])
    return canvas


def pm_diff(A, B):
    pm = lambda X: np.concatenate([X[:, :, :3] * X[:, :, 3:4], X[:, :, 3:4]], axis=2)
    a = np.asarray(A.convert("RGBA"), dtype=np.float32) / 255.0
    b = np.asarray(B.convert("RGBA"), dtype=np.float32) / 255.0
    return float(np.abs(pm(a) - pm(b)).mean()) * 255.0


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for screen, seqs in CANDIDATES.items():
        if only and only not in screen:
            continue
        d = json.load(open(os.path.join(DATA, "layout_%s.json" % screen), encoding="utf-8"))
        merged = Image.open(os.path.join(UI, MERGED[screen])).convert("RGBA")
        byname = {}
        for e in d["layers"]:
            byname.setdefault(e["name"], []).append(e)
        print("==", screen, "merged:", MERGED[screen])
        for seq in seqs:
            stack, missing = [], []
            used = set()
            for n in seq:
                pool = byname.get(n, [])
                cand = None
                for e in pool:
                    if e["id"] not in used:
                        cand = e
                        break
                if cand is None:
                    missing.append(n)
                    continue
                used.add(cand["id"])
                stack.append(cand)
            if missing:
                print("   MISSING:", missing)
                continue
            comp = composite_stack(stack, screen)
            comp_im = Image.fromarray((comp * 255).round().astype(np.uint8), "RGBA").convert("RGB")
            if comp_im.size != merged.size:
                comp_im = comp_im.resize(merged.size)
            diff = pm_diff(comp_im, merged)
            print("   n=%2d  diff=%6.2f   %s ... %s" % (len(seq), diff, seq[0], seq[-1]))


if __name__ == "__main__":
    main()
