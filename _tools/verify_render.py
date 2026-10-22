#!/usr/bin/env python3
"""Verification: render PSD composites + headless Chrome screenshots, compare."""
import json
import os
import glob
import subprocess
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "UI还原")
VER = os.path.join(OUT, "verify")
os.makedirs(os.path.join(VER, "psd"), exist_ok=True)
os.makedirs(os.path.join(VER, "shot"), exist_ok=True)

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SCREENS = ["开屏", "主画面", "存:读档界面", "CG界面", "商城界面", "服装",
            "送礼:物品界面", "人物", "回放界面", "设置界面", "音量:阅读模式界面"]


def pm_diff(a, b):
    pm = lambda X: np.concatenate([X[:, :, :3] * X[:, :, 3:4] / 255.0, X[:, :, 3:4]], axis=2)
    A = np.asarray(a.convert("RGBA"), dtype=np.float32)
    B = np.asarray(b.convert("RGBA"), dtype=np.float32)
    return float(np.abs(pm(A) - pm(B)).mean())


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else None
    for screen in SCREENS:
        if which and which not in screen:
            continue
        # 1) psd composite
        psd_path = os.path.join(ROOT, screen + ".psd")
        p_ref = os.path.join(VER, "psd", screen.replace(":", "_") + ".png")
        if not os.path.exists(p_ref):
            psd = PSDImage.open(psd_path)
            comp = psd.composite()
            comp.convert("RGB").save(p_ref)
        # 2) chrome screenshot (file:// URL with shot mode)
        s_file = os.path.join(VER, "shot", screen.replace(":", "_") + ".png")
        url = "file://" + os.path.join(OUT, "index.html") + "?shot=1&scr=" + screen
        # screen name contains ':' -> URLSearchParams decodes %3A; quote it
        url = url.replace(":", "%3A").replace("?shot=1&scr=", "?shot=1&scr=")
        # only the colon in scr param must be encoded, not file://
        url = url.replace("file%3A//", "file://")
        subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                        "--window-size=1920,1080", "--hide-scrollbars",
                        "--virtual-time-budget=8000",
                        "--screenshot=" + s_file, url],
                       capture_output=True, timeout=120)
        if not os.path.exists(s_file):
            print(screen, ": screenshot FAILED")
            continue
        # 3) compare
        ref = Image.open(p_ref).convert("RGB").resize((1920, 1080))
        shot = Image.open(s_file).convert("RGB")
        if shot.size != (1920, 1080):
            shot = shot.crop((0, 0, 1920, 1080)) if shot.size[0] >= 1920 else shot.resize((1920, 1080))
        d = pm_diff(shot, ref)
        print("%-16s diff=%6.2f" % (screen, d))


if __name__ == "__main__":
    main()
