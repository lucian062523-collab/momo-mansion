#!/usr/bin/env python3
"""Resolve every PSD layer to a UI组件 component or an exported original asset.

Strategy per layer:
- smartobject:
    1. embedded filename exists in UI组件 -> use that PNG (verify by pixel diff)
    2. stem with other extension exists (webp/psb -> png) -> candidate (verify)
    3. name hints table -> candidates (verify)
    4. export embedded original file (png/jpg/webp bytes or psb composite)
- pixel / gradientfill:
    1. name hints (底图 per screen etc.) -> candidates (verify)
    2. aspect-based scan of all UI组件 PNGs (verify)
    3. export rendered layer content
Verification = mean abs RGBA diff after resizing both to 256px; accept < 6.
Exports are deduped by sha1. Output: UI还原/data/layout_<screen>.json
"""
import json
import os
import glob
import hashlib
import re
import sys
import io

import numpy as np
from PIL import Image
from psd_tools import PSDImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(ROOT, "UI组件")
ASSETS_DIR = os.path.join(ROOT, "UI还原", "assets")
DATA_DIR = os.path.join(ROOT, "UI还原", "data")
os.makedirs(ASSETS_DIR, exist_ok=True)

# screen psd name -> 底图 component candidate
SCREEN_BG = {
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

# embedded smart filename (normalized stem) -> candidate component names
SMART_HINTS = {
    "按键（未点击）": ["按键A.png", "按键B.png", "读存档-未点击.png"],
    "按键（已点击）": ["按键A.png", "按键B.png", "读存档-点击.png"],
    "白框": ["服装卡片前板.png"],
    "图层 1": ["CG小窗（未解锁）.png"],
    "分类C 拷贝": ["分类C.png"],
    "属性_副本": ["bar.png", "长条.png", "横版小白bar.png"],
    "加": ["加.png"],
    "减": ["减.png"],
    "墨墨好感进度槽": ["墨墨好感进度槽.png"],
}

# raster layer name -> candidate component names
NAME_HINTS = {
    "星轨": ["星轨.png"],
    "换装背板": ["换装卡片背板.png"],
    "底图": [],  # filled per screen from SCREEN_BG
}

DIFF_ACCEPT = 6.0
_png_cache = {}          # filename -> PIL Image
_export_hash = {}        # sha1 -> relative asset url
THUMB = 256


def load_inventory():
    inv = {}
    for f in sorted(glob.glob(os.path.join(UI_DIR, "*.png"))):
        name = os.path.basename(f)
        im = Image.open(f).convert("RGBA")
        _png_cache[name] = im
        inv[name] = im.size
    return inv


def norm(s):
    return s.rstrip("\x00").strip()


def sanitize(s):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s)[:60]


def premult_diff(a, b):
    """Mean abs diff of premultiplied RGBA after normalizing both to THUMB.
    Handles garbage RGB in fully-transparent regions."""
    if a is None or b is None:
        return 999.0
    try:
        a2 = a.convert("RGBA").resize((THUMB, THUMB))
        b2 = b.convert("RGBA").resize((THUMB, THUMB))
        A = np.asarray(a2, dtype=np.float32)
        B = np.asarray(b2, dtype=np.float32)
        pm = lambda X: np.concatenate([X[:, :, :3] * X[:, :, 3:4] / 255.0, X[:, :, 3:4]], axis=2)
        return float(np.abs(pm(A) - pm(B)).mean())
    except Exception:
        return 999.0


def diff_score(a, b):
    return premult_diff(a, b)


def sha_of(im):
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    return hashlib.sha1(im.tobytes()).hexdigest()


def save_dedup(im, rel_name):
    """Save PIL image under assets/<rel_name>, deduped by content hash. Returns url."""
    h = sha_of(im)
    if h in _export_hash:
        return _export_hash[h]
    path = os.path.join(ASSETS_DIR, rel_name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)
    url = "assets/" + rel_name
    _export_hash[h] = url
    return url


def layer_content(layer):
    """Rendered content of a layer as PIL RGBA (without layer opacity applied)."""
    try:
        im = layer.topil()
    except Exception:
        im = None
    if im is None:
        try:
            im = layer.composite()
        except Exception:
            return None
    if im is None:
        return None
    if layer.has_mask and getattr(layer, "mask", None) is not None:
        try:
            im = layer.composite()
        except Exception:
            pass
    return im.convert("RGBA") if im is not None else None


def transform_bounds(layer):
    """Axis-aligned bounds of a smart object's true placement (may exceed bbox)."""
    try:
        tb = layer.smart_object.transform_box
        if tb is None:
            return None
        xs = [tb[0], tb[2], tb[4], tb[6]]
        ys = [tb[1], tb[3], tb[5], tb[7]]
        left, right = min(xs), max(xs)
        top, bottom = min(ys), max(ys)
        # rotation check: corners must form an axis-aligned rectangle
        corners = [(tb[0], tb[1]), (tb[2], tb[3]), (tb[4], tb[5]), (tb[6], tb[7])]
        if not all(abs(x - left) < 0.01 or abs(x - right) < 0.01 for x, _ in corners):
            return None
        if not all(abs(y - top) < 0.01 or abs(y - bottom) < 0.01 for _, y in corners):
            return None
        return {"left": left, "top": top, "right": right,
                "bottom": bottom, "width": right - left, "height": bottom - top}
    except Exception:
        return None


def placed_view(original, place, bbox):
    """Simulate placing `original` image at `place` rect, cropped to bbox."""
    pw = max(1, int(round(place["width"])))
    ph = max(1, int(round(place["height"])))
    im = original.convert("RGBA").resize((pw, ph))
    cx = int(round(bbox["left"] - place["left"]))
    cy = int(round(bbox["top"] - place["top"]))
    cw = bbox["right"] - bbox["left"]
    ch = bbox["bottom"] - bbox["top"]
    if cw <= 0 or ch <= 0:
        return None
    box = (max(0, cx), max(0, cy), max(0, cx) + cw, max(0, cy) + ch)
    if box[2] > im.size[0] or box[3] > im.size[1]:
        canvas = Image.new("RGBA", (max(im.size[0], box[2]), max(im.size[1], box[3])), (0, 0, 0, 0))
        canvas.paste(im, (0, 0), im)
        im = canvas
    return im.crop(box)


def try_candidates(content, candidates, place=None, bbox=None):
    """Return (url, score, name) of best candidate below threshold, else None.
    For smart objects, simulate true placement (scale to transform box, crop to bbox)."""
    best = None
    for name in candidates:
        im = _png_cache.get(name)
        if im is None:
            continue
        if place is not None and bbox is not None:
            view = placed_view(im, place, bbox)
            if view is None:
                continue
            s = diff_score(content, view)
        else:
            s = diff_score(content, im)
        if best is None or s < best[1]:
            best = ("../UI组件/" + name, s, name)
    if best and best[1] <= DIFF_ACCEPT:
        return best
    return None


def aspect_candidates(content, inv):
    w, h = content.size
    ar = w / h
    cands = []
    for name, (nw, nh) in inv.items():
        nar = nw / nh
        if abs(nar - ar) / ar < 0.03 and min(nw, nh) > 8:
            cands.append(name)
    return cands


def export_smart_original(layer, screen):
    """Export embedded smart object original. Returns (url, natural_size, note)."""
    so = layer.smart_object
    fn = norm(so.filename or "")
    stem = os.path.splitext(fn)[0]
    ext = os.path.splitext(fn)[1].lower()
    try:
        data = so.data
    except Exception:
        data = None
    if data and ext in (".png", ".jpg", ".jpeg", ".webp"):
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        url = save_dedup(im, sanitize(stem) + ".png")
        return url, im.size, "embedded " + ext
    # psb/psd -> composite
    try:
        inner = so.open(PSDImage)
        im = inner.composite().convert("RGBA")
        url = save_dedup(im, sanitize(stem) + ".png")
        return url, im.size, "embedded psb composite"
    except Exception as ex:
        return None, None, "export failed: %s" % ex


def resolve_layer_asset(layer, screen, kind):
    """Returns asset dict for a raster-like layer."""
    content = layer_content(layer)
    bbox = {"left": layer.bbox[0], "top": layer.bbox[1],
            "right": layer.bbox[2], "bottom": layer.bbox[3],
            "width": layer.bbox[2] - layer.bbox[0], "height": layer.bbox[3] - layer.bbox[1]}
    if content is None:
        return {"url": None, "source": "empty", "diff": None}
    # 1. smart object by filename (verify via true-placement simulation)
    if kind == "smartobject":
        place = transform_bounds(layer) or bbox
        fn = norm(layer.smart_object.filename or "")
        base = os.path.basename(fn)
        stem = os.path.splitext(base)[0]
        cands = []
        if base in _png_cache:
            cands.append(base)
        stem_png = stem + ".png"
        if ext_of(base) != ".png" and stem_png in _png_cache:
            cands.append(stem_png)
        cands += SMART_HINTS.get(stem, [])
        hit = try_candidates(content, cands, place, bbox)
        if hit:
            return {"url": hit[0], "source": "component", "component": hit[2],
                    "diff": round(hit[1], 2), "natural": list(_png_cache[hit[2]].size),
                    "place": place}
        url, nat, note = export_smart_original(layer, screen)
        if url:
            return {"url": url, "source": "export", "note": note,
                    "diff": None, "natural": list(nat) if nat else None,
                    "place": place}
        # fallback: export placed content at bbox
        url = save_dedup(content, "%s/%s_%s.png" % (sanitize(screen), sanitize(screen), sanitize(layer.name)))
        return {"url": url, "source": "export-placed", "note": "placed content",
                "diff": None, "natural": list(content.size), "place": bbox}
    # 2. pixel / gradientfill by name hints
    hints = list(NAME_HINTS.get(layer.name, []))
    if layer.name == "底图":
        hints.insert(0, SCREEN_BG.get(screen, ""))
    hit = try_candidates(content, [h for h in hints if h])
    if hit:
        return {"url": hit[0], "source": "component", "component": hit[2],
                "diff": round(hit[1], 2), "natural": list(_png_cache[hit[2]].size),
                "place": bbox}
    # 3. aspect scan
    hit = try_candidates(content, aspect_candidates(content, _inv))
    if hit:
        return {"url": hit[0], "source": "component-aspect", "component": hit[2],
                "diff": round(hit[1], 2), "natural": list(_png_cache[hit[2]].size),
                "place": bbox}
    # 4. export rendered content
    rel = "%s/%s_%s.png" % (sanitize(screen), sanitize(screen), sanitize(layer.name))
    url = save_dedup(content, rel)
    return {"url": url, "source": "export", "note": "layer content",
            "diff": None, "natural": list(content.size), "place": bbox}


def ext_of(fn):
    return os.path.splitext(fn)[1].lower()


def main():
    global _inv
    _inv = load_inventory()
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for psd_path in sorted(glob.glob(os.path.join(ROOT, "*.psd"))):
        screen = os.path.splitext(os.path.basename(psd_path))[0]
        if only and only not in screen:
            continue
        print("== resolving", screen, flush=True)
        psd = PSDImage.open(psd_path)
        with open(os.path.join(DATA_DIR, screen + ".json"), encoding="utf-8") as fh:
            jdata = json.load(fh)

        # map json entries to psd layers by walking both trees in same order
        entries = []

        def walk(psd_layers, json_layers, parent_id):
            for pl, jl in zip(psd_layers, json_layers):
                eid = "L%03d" % len(entries)
                e = {
                    "id": eid,
                    "parent": parent_id,
                    "name": pl.name,
                    "kind": pl.kind,
                    "visible": pl.visible,
                    "opacity": round(pl.opacity / 255.0, 4),
                    "blend_mode": str(pl.blend_mode),
                    "clipping": bool(pl.clipping),
                    "bbox": {"left": pl.bbox[0], "top": pl.bbox[1],
                             "right": pl.bbox[2], "bottom": pl.bbox[3],
                             "width": pl.bbox[2] - pl.bbox[0], "height": pl.bbox[3] - pl.bbox[1]},
                    "json": jl,
                }
                if pl.kind in ("smartobject", "pixel", "gradientfill", "shape"):
                    e["asset"] = resolve_layer_asset(pl, screen, pl.kind)
                entries.append(e)
                if pl.kind == "group":
                    walk(pl, jl["children"], eid)
        walk(list(psd), jdata["layers"], None)

        # build children id lists from parent links (document order preserved)
        by_id = {e["id"]: e for e in entries}
        for e in entries:
            if e["parent"] is not None:
                p = by_id[e["parent"]]
                p.setdefault("children", []).append(e["id"])

        # clip base resolution: nearest previous sibling with clipping False
        for e in entries:
            if not e["clipping"]:
                continue
            base = None
            if e["parent"]:
                sibs = by_id[e["parent"]]["children"]
                i = sibs.index(e["id"])
                for j in range(i - 1, -1, -1):
                    if not by_id[sibs[j]]["clipping"]:
                        base = sibs[j]
                        break
            e["clip_base"] = base

        out = {
            "screen": screen,
            "width": psd.width,
            "height": psd.height,
            "layers": entries,
        }
        with open(os.path.join(DATA_DIR, "layout_%s.json" % screen), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)

        # report
        for e in entries:
            a = e.get("asset")
            if a and a.get("source", "").startswith("component"):
                continue
            if a:
                print("   %-28s %-12s -> %-40s %s (diff=%s)" % (
                    e["name"][:28], e["kind"], a.get("url"), a["source"], a.get("diff")))
    # unused components
    used = set()
    for f in glob.glob(os.path.join(DATA_DIR, "layout_*.json")):
        d = json.load(open(f, encoding="utf-8"))
        for e in d["layers"]:
            a = e.get("asset")
            if a and a.get("component"):
                used.add(a["component"])
    unused = sorted(set(_inv.keys()) - used)
    print("\nUnused UI组件 components (%d):" % len(unused))
    for u in unused:
        print("   ", u)


if __name__ == "__main__":
    main()
