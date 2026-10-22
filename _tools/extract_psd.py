#!/usr/bin/env python3
"""Extract full layer parameters (positions / styles / text / gradients / effects)
from all PSDs for 1:1 UI restoration. Output: UI还原/data/*.json
"""
import json
import os
import glob
import sys

from psd_tools import PSDImage
from psd_tools.constants import Tag

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "UI还原", "data")
os.makedirs(OUT_DIR, exist_ok=True)


def norm_key(k):
    if isinstance(k, bytes):
        return k.decode("utf-8", "replace").rstrip("\x00").strip()
    return str(k)


def is_dictlike(x):
    return isinstance(x, dict) or (hasattr(x, "keys") and hasattr(x, "items"))


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        try:
            return float(v.value)
        except Exception:
            return default


def color_of(d):
    """Descriptor color dict -> css rgb()."""
    if not is_dictlike(d):
        return None
    r = d.get(b"Rd  ", d.get("Rd  "))
    g = d.get(b"Grn ", d.get("Grn "))
    b = d.get(b"Bl  ", d.get("Bl  "))
    if None in (r, g, b):
        return None
    return "rgb(%d,%d,%d)" % (round(_f(r)), round(_f(g)), round(_f(b)))


def rgba_of_values(vals, as_alpha_first=True):
    """FillColor Values [1.0, R, G, B] (0..1) -> css rgba/rgb."""
    if not vals:
        return None
    if len(vals) >= 4:
        r, g, b = [round(v * 255) for v in vals[1:4]]
        return "rgb(%d,%d,%d)" % (r, g, b)
    return None


def enum_val(v):
    if hasattr(v, "value") and not isinstance(v, (dict, list)):
        try:
            return v.value
        except Exception:
            pass
    if hasattr(v, "enum"):
        try:
            return v.enum
        except Exception:
            pass
    return str(v) if not isinstance(v, (int, float, str, bool)) else v


def _simplify_descriptor(x, depth=0):
    """Recursively convert descriptor structures (bytes keys, Enumerated...) to plain JSON."""
    if depth > 8:
        return "..."
    if is_dictlike(x):
        return {norm_key(k): _simplify_descriptor(v, depth + 1) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_simplify_descriptor(v, depth + 1) for v in x]
    if isinstance(x, bool) or isinstance(x, int):
        return x
    if isinstance(x, float):
        return round(x, 4)
    if isinstance(x, str):
        return x.rstrip("\x00")
    # Enumerated / UnitFloat / objects with .value
    for attr in ("value", "enum", "name", "classID"):
        if hasattr(x, attr):
            try:
                v = getattr(x, attr)
                if isinstance(v, (str, bytes, int, float)):
                    return v.decode("utf-8", "replace") if isinstance(v, bytes) else v
            except Exception:
                pass
    return str(x)


# effects2 (modern object-based) key -> short effect name
_EFF2_KEYS = {
    "DrSh": "dropShadow", "dropShadow": "dropShadow",
    "OrGl": "outerGlow", "outerGlow": "outerGlow",
    "IrGl": "innerGlow", "innerGlow": "innerGlow",
    "FrFX": "stroke", "frameFX": "stroke", "stroke": "stroke",
    "SoFi": "colorOverlay", "solidFill": "colorOverlay",
    "GrFl": "gradientOverlay", "gradientFill": "gradientOverlay",
    "Pattern": "patternOverlay",
    "SprL": "satin",
    "patternOverlay": "patternOverlay",
    "Shdw": "dropShadow",
}


def extract_effects(layer):
    """Legacy + object-based effects -> list of dicts with CSS-friendly fields."""
    out = []
    seen_legacy = set()
    try:
        for e in layer.effects:
            d = getattr(e, "descriptor", None)
            if not is_dictlike(d):
                continue
            etype = type(e).__name__
            item = {"src": "legacy", "type": etype,
                    "enabled": bool(d.get(b"enab", d.get("enab", True)))}
            keys = {norm_key(k) for k in d.keys()}
            if "Clr" in keys:
                item["color"] = color_of(d.get(b"Clr "))
            if "Opct" in keys:
                item["opacity_pct"] = _f(d.get(b"Opct"))
            if "Dstn" in keys:
                item["distance_px"] = _f(d.get(b"Dstn"))
            if "blur" in keys:
                item["blur_px"] = _f(d.get(b"blur"))
            if "Ckmt" in keys:
                item["choke_pct"] = _f(d.get(b"Ckmt"))
            if "lagl" in keys:
                item["angle_deg"] = _f(d.get(b"lagl"))
            if "Nose" in keys:
                item["noise_pct"] = _f(d.get(b"Nose"))
            if "Sz" in keys:
                v = d.get(b"Sz  ", None)
                item["size_px"] = _f(v) if v is not None else None
            out.append(item)
            seen_legacy.add(etype)
    except Exception as ex:
        out.append({"src": "legacy", "type": "ERROR", "error": str(ex)})
    # effects2 (object-based)
    try:
        e2 = layer._record.tagged_blocks.get_data(Tag.OBJECT_BASED_EFFECTS_LAYER_INFO)
        if e2 is not None:
            d2 = _simplify_descriptor(dict(e2))
            for k, v in d2.items():
                if not isinstance(v, dict):
                    continue
                short = _EFF2_KEYS.get(k)
                if short is None:
                    continue
                if short in seen_legacy:
                    # prefer effects2 (modern) but keep only one entry per effect type;
                    # effects2 usually carries the same/updated values.
                    out = [o for o in out if not (o.get("src") == "legacy" and o.get("type") == short)]
                item = {"src": "effects2", "type": short,
                        "enabled": bool(v.get("enab", True))}
                if "Clr" in v:
                    c = v["Clr"]
                    if isinstance(c, dict):
                        r, g, b = (c.get("Rd"), c.get("Grn"), c.get("Bl"))
                        if None not in (r, g, b):
                            item["color"] = "rgb(%d,%d,%d)" % (round(r), round(g), round(b))
                if "Opct" in v:
                    item["opacity_pct"] = float(v["Opct"])
                if "Dstn" in v:
                    item["distance_px"] = float(v["Dstn"])
                if "blur" in v:
                    item["blur_px"] = float(v["blur"])
                if "Ckmt" in v:
                    item["choke_pct"] = float(v["Ckmt"])
                if "lagl" in v:
                    item["angle_deg"] = float(v["lagl"])
                if "Nose" in v:
                    item["noise_pct"] = float(v["Nose"])
                if "Sz" in v:
                    item["size_px"] = float(v["Sz"])
                if "Stgl" in v:
                    item["position"] = {"OutF": "outside", "InsF": "inside", "CtrF": "center"}.get(v["Stgl"], v["Stgl"])
                if "Md  " in v or "Md" in v:
                    item["blend"] = v.get("Md  ", v.get("Md"))
                out.append(item)
    except Exception as ex:
        out.append({"src": "effects2", "type": "ERROR", "error": str(ex)})
    return out


def extract_gradient(layer):
    tb = layer._record.tagged_blocks.get_data(Tag.GRADIENT_FILL_SETTING)
    if tb is None:
        return None
    grad = dict(tb).get(b"Grad")
    if grad is None:
        return None
    stops = []
    for s in grad.get(b"Clrs", []):
        stops.append({
            "location": float(s[b"Lctn"]) / 4096.0 * 100.0,
            "color": color_of(s[b"Clr "]),
            "type": enum_val(s.get(b"Type")),
        })
    tstops = []
    for s in grad.get(b"Trns", []):
        tstops.append({
            "location": float(s[b"Lctn"]) / 4096.0 * 100.0,
            "opacity_pct": float(s[b"Opct"]),
        })
    return {
        "name": norm_key(grad.get(b"Nm  ", "")),
        "form": enum_val(grad.get(b"GrdF")),
        "interpolation": float(grad.get(b"Intr", 4096)) / 4096.0,
        "angle_deg": float(dict(tb).get(b"Angl", 0)),
        "scale_pct": float(dict(tb).get(b"Scl ", 100)),
        "reversed": bool(dict(tb).get(b"Rvrs", False)),
        "align_with_layer": bool(dict(tb).get(b"Algn", True)),
        "offset": {"x": float(dict(tb).get(b"Ofst", {}).get(b"Hrzn", 0)),
                   "y": float(dict(tb).get(b"Ofst", {}).get(b"Vrtc", 0))},
        "type": enum_val(dict(tb).get(b"Type")),
        "color_stops": stops,
        "opacity_stops": tstops,
        "aspect_ratio": float(dict(tb).get(b"gradientAspectRatio", 1)),
    }


def extract_text(layer):
    ed = layer.engine_dict
    rd = layer.resource_dict
    runs = []
    text = ""
    try:
        text = layer.text or ""
    except Exception:
        text = ""
    sr = ed.get("StyleRun", {})
    run_lengths = list(sr.get("RunLengthArray", []))
    run_array = list(sr.get("RunArray", []))
    fontset = list(rd.get("FontSet", []))
    pos = 0
    for length, run in zip(run_lengths, run_array):
        style = run["StyleSheet"]["StyleSheetData"]
        font_idx = int(style.get("Font", 0))
        font_name = fontset[font_idx].get("Name", "?") if font_idx < len(fontset) else "?"
        runs.append({
            "text": text[pos:pos + int(length)],
            "font": font_name,
            "font_size_pt": float(style.get("FontSize", 0)),
            "tracking": float(style.get("Tracking", 0)),
            "fill_color": rgba_of_values(style.get("FillColor", {}).get("Values")),
            "stroke_color": rgba_of_values(style.get("StrokeColor", {}).get("Values")),
            "fake_bold": bool(style.get("FauxBold", False)),
            "fake_italic": bool(style.get("FauxItalic", False)),
        })
        pos += int(length)
    para = []
    try:
        for pr in ed.get("ParagraphRun", {}).get("RunArray", []):
            props = pr["ParagraphSheet"]["Properties"]
            para.append({
                "align": {0: "left", 1: "right", 2: "center", 3: "justify"}.get(
                    int(props.get("Justification", 0)), "left"),
                "first_line_indent_pt": float(props.get("FirstLineIndent", 0)),
                "space_before_pt": float(props.get("SpaceBefore", 0)),
                "space_after_pt": float(props.get("SpaceAfter", 0)),
            })
    except Exception:
        pass
    tx = layer.transform if layer.transform else (1, 0, 0, 1, 0, 0)
    scale = (abs(tx[0] * tx[3] - tx[1] * tx[2])) ** 0.5 if tx else 1.0
    return {
        "text": text,
        "runs": runs,
        "paragraphs": para,
        "transform": [round(v, 6) for v in tx],
        "scale": round(scale, 6),
    }


def layer_info(layer, path=""):
    b = layer.bbox
    info = {
        "name": layer.name,
        "kind": layer.kind,
        "path": path,
        "visible": layer.visible,
        "opacity": round(layer.opacity / 255.0, 4),
        "fill_opacity": round(getattr(layer, "fill_opacity", 255) / 255.0, 4),
        "blend_mode": str(getattr(layer, "blend_mode", "")),
        "clipping": bool(getattr(layer, "clipping", False)),
        "bbox": {"left": b[0], "top": b[1], "right": b[2], "bottom": b[3],
                 "width": b[2] - b[0], "height": b[3] - b[1]},
    }
    if layer.kind == "smartobject":
        try:
            info["smart_filename"] = layer.smart_object.filename
        except Exception:
            info["smart_filename"] = None
    if layer.kind == "type":
        info["type"] = extract_text(layer)
    if layer.kind in ("pixel", "gradientfill", "shape", "smartobject", "type"):
        g = extract_gradient(layer)
        if g:
            info["gradient"] = g
    eff = extract_effects(layer)
    if eff:
        info["effects"] = eff
    return info


def walk(psd):
    def rec(layers, path, out):
        for l in layers:
            p = path + "/" + l.name
            info = layer_info(l, p)
            out.append(info)
            if l.kind == "group":
                info["children"] = []
                rec(l, p, info["children"])
    out = []
    rec(list(psd), "", out)
    return out


def main():
    summary = []
    for f in sorted(glob.glob(os.path.join(ROOT, "*.psd"))):
        name = os.path.splitext(os.path.basename(f))[0]
        print("extracting:", name, flush=True)
        psd = PSDImage.open(f)
        data = {
            "file": os.path.basename(f),
            "width": psd.width,
            "height": psd.height,
            "layers": walk(psd),
        }
        outp = os.path.join(OUT_DIR, name + ".json")
        with open(outp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1,
                      default=lambda o: str(o))
        n = sum(1 for _ in data["layers"])
        summary.append((name, psd.width, psd.height, n))
    for s in summary:
        print("%s %dx%d top-level=%d" % s)


if __name__ == "__main__":
    main()
