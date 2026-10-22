#!/usr/bin/env python3
"""Generate 样式参数文档.md — complete style parameters for engine reuse."""
import json
import os
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "UI还原", "data")
OUT = os.path.join(ROOT, "UI还原", "样式参数文档.md")

SCREEN_ORDER = ["开屏", "主画面", "存:读档界面", "CG界面", "商城界面", "服装",
                "送礼:物品界面", "人物", "回放界面", "设置界面", "音量:阅读模式界面"]

FONT_FRIENDLY = {"FZXBSJW--GB1-0": "方正小标宋简体 (FZXiaoBiaoSong)"}


def pm(v):
    try:
        return round(float(v), 2)
    except Exception:
        return v


def effects_md(e):
    lines = []
    seen = set()
    for eff in (e.get("json", {}).get("effects") or []):
        if not eff.get("enabled", True):
            continue
        key = (eff.get("type"), eff.get("color"), eff.get("blur_px"))
        if key in seen:
            continue
        seen.add(key)
        parts = ["**%s**" % eff["type"]]
        if "color" in eff:
            parts.append("颜色 %s" % eff["color"])
        if "opacity_pct" in eff:
            parts.append("不透明度 %g%%" % eff["opacity_pct"])
        if "angle_deg" in eff:
            parts.append("角度 %g°" % eff["angle_deg"])
        if "distance_px" in eff:
            parts.append("距离 %gpx" % eff["distance_px"])
        if "choke_pct" in eff:
            parts.append("扩展 %g%%" % eff["choke_pct"])
        if "blur_px" in eff:
            parts.append("模糊 %gpx" % eff["blur_px"])
        if "size_px" in eff:
            parts.append("大小 %gpx" % eff["size_px"])
        if "position" in eff:
            parts.append("位置 %s" % eff["position"])
        lines.append("  - " + "，".join(parts))
    return lines


def gradient_md(g):
    stops = []
    for s in g.get("color_stops", []):
        stops.append("%s @ %g%%" % (s["color"], pm(s["location"])))
    ostops = ["%g%% @ %g%%" % (s["opacity_pct"], pm(s["location"]))
              for s in g.get("opacity_stops", [])]
    lines = [
        "  - 类型: 线性渐变，角度 %g°，缩放 %g%%，反向 %s" % (
            pm(g.get("angle_deg", 0)), pm(g.get("scale_pct", 100)),
            "是" if g.get("reversed") else "否"),
        "  - 色标: " + " → ".join(stops),
    ]
    if ostops:
        lines.append("  - 透明度: " + " → ".join(ostops))
    return lines


def main():
    md = []
    md.append("# UI 1:1 还原 · 样式参数文档\n")
    md.append("> 画布统一 **1920×1080**；坐标为 PSD 画布像素坐标 (left, top, w×h)。\n")
    md.append("> 资产来源：`UI组件/`（组件库）与 `UI还原/assets/`（PSD 内嵌原件导出：立绘/场景/课文牌等无对应组件者）。\n")
    md.append("> 氛围层（星光/渐变填充/暗色遮罩等）已合并进各界面 `*-底图.png`，按 (0,0,1920×1080) 铺底。\n")

    for screen in SCREEN_ORDER:
        f = os.path.join(DATA, "layout2_%s.json" % screen)
        if not os.path.exists(f):
            continue
        d = json.load(open(f, encoding="utf-8"))
        md.append("\n---\n\n## %s\n" % screen)
        md.append("### 图层摆放（自下而上）\n")
        md.append("| 图层 | 类型 | 位置 (x, y) | 尺寸 (w×h) | 不透明度 | 混合 | 资产 | 说明 |")
        md.append("|---|---|---|---|---|---|---|---|")

        def rec(ids, dep):
            for i in ids:
                e = by[i]
                if e.get("skip"):
                    md.append("| %s%s | %s | — | — | — | — | *(已并入合并底图)* | 氛围层 |" % (
                        "　" * dep, e["name"], e["kind"]))
                    continue
                pl = (e.get("asset") or {}).get("place") or e["bbox"]
                url = (e.get("asset") or {}).get("url") or ""
                comp = (e.get("asset") or {}).get("component") or url.replace("assets/", "PSD导出:")
                note = []
                if e.get("clipping"):
                    note.append("剪贴层(裁剪到下方基础层)")
                if not e["visible"]:
                    note.append("隐藏")
                if (e.get("asset") or {}).get("flip_h"):
                    note.append("水平镜像(CSS scaleX(-1))")
                if e["kind"] == "type":
                    comp = "CSS 文本"
                if e["kind"] == "group":
                    comp = "容器"
                md.append("| %s%s | %s | %g, %g | %g×%g | %g | %s | %s | %s |" % (
                    "　" * dep, e["name"], e["kind"], pm(pl["left"]), pm(pl["top"]),
                    pm(pl["width"]), pm(pl["height"]), e["opacity"],
                    e["blend_mode"].replace("BlendMode.", ""), comp, "；".join(note)))
                if e.get("children"):
                    rec(e["children"], dep + 1)

        by = {e["id"]: e for e in d["layers"]}
        rec([e["id"] for e in d["layers"] if e["parent"] is None], 0)

        # text params
        texts = [e for e in d["layers"] if e["kind"] == "type"]
        grads = [e for e in d["layers"] if (e.get("json") or {}).get("gradient")]
        effs = [e for e in d["layers"] if (e.get("json") or {}).get("effects")]
        if texts:
            md.append("\n### 文本参数\n")
            for e in texts:
                jt = e["json"]["type"]
                r0 = (jt.get("runs") or [{}])[0]
                font = FONT_FRIENDLY.get(r0.get("font", "").strip("'"), r0.get("font", ""))
                size = pm(r0.get("font_size_pt", 0) * jt.get("scale", 1))
                md.append("- **%s**「%s」" % (e["name"], jt.get("text", "").strip("\x00")))
                md.append("  - 字体: %s；字号: %g pt × 缩放 %g ≈ **%gpx**" % (
                    font, pm(r0.get("font_size_pt")), pm(jt.get("scale", 1)), size))
                md.append("  - 填充色: %s；描边色: %s；字距: %g/1000em ≈ %gpx" % (
                    r0.get("fill_color"), r0.get("stroke_color"), pm(r0.get("tracking", 0)),
                    pm(r0.get("tracking", 0) / 1000 * size)))
                for ln in effects_md(e):
                    md.append(ln)
        if grads:
            md.append("\n### 渐变参数（供引擎复刻）\n")
            for e in grads:
                md.append("- **%s** (%s，已并入合并底图，此处仅记录参数)" % (
                    e["name"], "可见" if e["visible"] else "隐藏"))
                for ln in gradient_md(e["json"]["gradient"]):
                    md.append(ln)
        if effs:
            md.append("\n### 图层效果\n")
            for e in effs:
                if e["kind"] == "type":
                    continue
                lines = effects_md(e)
                if lines:
                    md.append("- **%s**" % e["name"])
                    md.extend(lines)

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md))
    print("written:", OUT, "lines:", len(md))


if __name__ == "__main__":
    main()
