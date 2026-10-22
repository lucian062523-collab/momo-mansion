#!/usr/bin/env python3
"""Render Photoshop linear gradient fill layers from extracted JSON parameters.

Validates the PS->pixel conventions against psd_tools-rendered PNGs, then
renders the two clipped+visible gradient layers psd_tools cannot composite.
Also emits CSS linear-gradient strings for every gradientfill layer.
"""
import json
import os
import glob
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "UI还原", "data")
ASSETS = os.path.join(ROOT, "UI还原", "assets")


def parse_css_rgb(s):
    return tuple(int(v) for v in s[s.index("(") + 1:s.index(")")].split(","))


def build_lut(grad):
    """Color+opacity LUT along normalized gradient axis t in [0,1] -> (H,1,3) colors, (H,1) alphas at 4097 steps."""
    N = 4097
    t = np.linspace(0, 1, N)
    # color stops
    cstops = sorted(grad["color_stops"], key=lambda s: s["location"])
    cstops_t = np.array([s["location"] / 100.0 for s in cstops])
    cstops_c = np.array([parse_css_rgb(s["color"]) for s in cstops], dtype=np.float32)
    colors = np.stack([np.interp(t, cstops_t, cstops_c[:, i]) for i in range(3)], axis=1)
    # opacity stops
    ostops = sorted(grad["opacity_stops"], key=lambda s: s["location"])
    ostops_t = np.array([s["location"] / 100.0 for s in ostops])
    ostops_o = np.array([s["opacity_pct"] / 100.0 for s in ostops], dtype=np.float32)
    alphas = np.interp(t, ostops_t, ostops_o)
    if grad.get("reversed"):
        colors = colors[::-1]
        alphas = alphas[::-1]
    return colors, alphas  # (N,3), (N,)


def ps_gradient_css(grad):
    """CSS linear-gradient string approximation (documented in 样式参数文档)."""
    colors, alphas = build_lut(grad)
    # sample 5 stops for the CSS string
    n = 5
    idx = np.linspace(0, len(colors) - 1, n).round().astype(int)
    stops = []
    for i, p in enumerate(np.linspace(0, 100, n)):
        c = colors[idx[i]]
        a = alphas[idx[i]]
        if a >= 0.999:
            stops.append("rgb(%d,%d,%d) %.1f%%" % (c[0], c[1], c[2], p))
        else:
            stops.append("rgba(%d,%d,%d,%.3f) %.1f%%" % (c[0], c[1], c[2], a, p))
    # PS angle: 0° = direction pointing RIGHT (east), increasing counterclockwise?
    # CSS: 0deg = to top, 90deg = to right.
    ang = grad["angle_deg"]
    css_angle = 90.0 - ang
    # reversed flips the direction by 180
    if grad.get("reversed"):
        css_angle += 180.0
    css_angle %= 360.0
    return "linear-gradient(%.2fdeg, %s)" % (css_angle, ", ".join(stops))


def render_ps_gradient(grad, w, h):
    """Render Photoshop linear gradient over an axis-aligned rect (w,h).
    Returns RGBA uint8 numpy array.

    Photoshop linear gradient convention (Gradient Overlay / Fill):
      - angle: direction of the gradient VECTOR (source -> target),
        measured counterclockwise from +X axis (east).
      - scale: gradient length as % of the layer diagonal-based extent;
        the gradient is centered on the layer center when align_with_layer.
      - offset shifts the gradient center.
    """
    colors, alphas = build_lut(grad)  # t=0 at gradient START, t=1 at END
    # direction unit vector: PS angle counterclockwise from east
    ang = np.deg2rad(grad["angle_deg"])
    d = np.array([np.cos(ang), np.sin(ang)])  # (x, y) with y down (image coords)
    # gradient line length: scale% of the full projection extent
    # full extent = projection of rect onto direction = w*|dx| + h*|dy|
    full = abs(w * d[0]) + abs(h * d[1])
    length = full * grad.get("scale_pct", 100.0) / 100.0
    cx = w / 2.0 + grad.get("offset", {}).get("x", 0.0)
    cy = h / 2.0 + grad.get("offset", {}).get("y", 0.0)
    xs = np.arange(w, dtype=np.float32)[None, :]
    ys = np.arange(h, dtype=np.float32)[:, None]
    # signed distance along direction from center
    proj = (xs - cx) * d[0] + (ys - cy) * d[1]
    if grad.get("reversed"):
        proj = -proj
    t = proj / max(length, 1e-6) * 0.5 + 0.5
    t = np.clip(t, 0.0, 1.0)
    ti = np.clip((t * (len(colors) - 1)).round().astype(np.int32), 0, len(colors) - 1)
    rgb = colors[ti]  # (h,w,3)
    a = alphas[ti][:, :, None]
    out = np.concatenate([rgb, a * 255.0], axis=2).astype(np.uint8)
    return out


def sanitize(s):
    import re
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s)[:60]


def psd_tools_render(screen, layer_name):
    p = os.path.join(ASSETS, sanitize(screen),
                     "%s_%s.png" % (sanitize(screen), sanitize(layer_name)))
    if os.path.exists(p):
        return Image.open(p).convert("RGBA")
    return None


def main():
    # 1) validate against psd_tools-rendered visible gradients
    all_entries = []
    for f in sorted(glob.glob(os.path.join(DATA, "layout_*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        screen = d["screen"]
        for e in d["layers"]:
            g = e.get("json", {}).get("gradient")
            if not g:
                continue
            w, h = e["bbox"]["width"], e["bbox"]["height"]
            if w <= 0 or h <= 0:
                continue
            mine = render_ps_gradient(g, w, h)
            mine_im = Image.fromarray(mine)
            ref = psd_tools_render(screen.replace(":", "_"), e["name"])
            css = ps_gradient_css(g)
            entry = {"screen": screen, "layer": e["name"], "visible": e["visible"],
                     "clipping": e["clipping"], "bbox": e["bbox"], "css": css,
                     "params": g}
            if ref is not None and e["visible"] and not e["clipping"]:
                A = np.asarray(mine, dtype=np.float32)
                B = np.asarray(ref, dtype=np.float32)
                pm = lambda X: np.concatenate([X[:, :, :3] * X[:, :, 3:4] / 255.0, X[:, :, 3:4]], axis=2)
                entry["diff_vs_psdtools"] = round(float(np.abs(pm(A) - pm(B)).mean()), 2)
            elif e["visible"] and e["clipping"]:
                # psd_tools cannot render these; save our synthesized render
                outp = os.path.join(ASSETS, sanitize(screen),
                                    "%s_%s.png" % (sanitize(screen), sanitize(e["name"])))
                os.makedirs(os.path.dirname(outp), exist_ok=True)
                mine_im.save(outp)
                entry["rendered"] = outp
            all_entries.append(entry)
    with open(os.path.join(DATA, "gradient_css.json"), "w", encoding="utf-8") as fh:
        json.dump(all_entries, fh, ensure_ascii=False, indent=1)
    for e in all_entries:
        print("%-14s %-12s vis=%-5s clip=%-5s diff=%s" % (
            e["screen"][:14], e["layer"], e["visible"], e["clipping"],
            e.get("diff_vs_psdtools", "-")))


if __name__ == "__main__":
    main()


if __name__ == "__main__":
    main()
