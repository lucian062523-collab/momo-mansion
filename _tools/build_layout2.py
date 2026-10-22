#!/usr/bin/env python3
"""Final layout builder (v2).

Philosophy (user-confirmed):
- UI组件/*.png is the canonical asset library. Use it by name mapping.
- PSD provides positions (bbox/transform_box), opacity, blend, text/gradient/effect params.
- Atmosphere layers (底图 raw, 渐变填充*, 图层 1/6, 星光) are pre-merged into
  UI组件/<screen>-底图.png -> skip them; place merged bg at (0,0,1920,1080).
- Only layers with no UI组件 counterpart (character/scene art, 课文牌, etc.)
  use assets exported from the PSD embedded originals.

Output: UI还原/data/layout2_<screen>.json
"""
import json
import os
import glob
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI_DIR = os.path.join(ROOT, "UI组件")
ASSETS_DIR = os.path.join(ROOT, "UI还原", "assets")
DATA_DIR = os.path.join(ROOT, "UI还原", "data")

# merged background component per screen (None = screen has no merged bg)
MERGED_BG = {
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
    "主画面": None,
}

# atmosphere layer names baked into merged bg -> skipped in layout
# (底图 handled separately; these exact names, per screen or any screen)
ATMOSPHERE_ANY = {"星光"}
ATMOSPHERE_PREFIX = ("渐变填充", "图层 1", "图层 6")

# stem of embedded smart filename -> UI组件 component (verified mapping)
COMPONENT_MAP = {
    "BACK（简化）": "BACK（简化）.png",
    "1": "1.png", "2": "2.png", "3": "3.png", "4": "4.png", "5": "5.png",
    "右": "右.png", "左": "左.png",
    "存档条": "存档条.png",
    "对话组件-姓名条": "对话组件-姓名条.png",
    "对话组件-对话框": "对话组件-对话框.png",
    "对话组件-选择条（未选中）": "对话组件-选择条（未选中）.png",
    "对话组件-选择条（选中）": "对话组件-选择条（选中）.png",
    "小圆圈（点击）": "小圆圈（点击）.png",
    "小条（未点击）": "小条（未点击）.png",
    "小条（点击）": "小条（点击）.png",
    "短小条（未点击）": "短小条B.png",          # verified: B == un-clicked state
    "按键（未点击）": "按键A.png",              # verified: A == un-clicked
    "按键（已点击）": "按键B.png",              # verified: B == clicked
    "CG小窗（挖空）": "CG小窗（挖空）.png",
    "图层 1": "CG小窗（未解锁）.png",            # psb -> unlocked CG frame
    "分类A": "分类A.png", "分类B": "分类B.png",
    "分类C": "分类C.png", "分类C 拷贝": "分类C.png",
    "加": "加.png", "减": "减.png",
    "墨墨好感进度槽": "墨墨好感进度槽.png",
    "进度星星": "进度星星.png",
    "商城组件-书": "商城组件-书.png",
    "商城组件-钥匙": "商城组件-钥匙.png",
    "商城组件-衣服": "商城组件-衣服.png",
    "商城组件-金币": "商城组件-金币.png",
    "商城组件-银币": "商城组件-银币.png",
    "商城组件-大礼包": "商城组件-大礼包.png",
    "向右": "向右.png", "向左": "向左.png",
    "小名牌": "小名牌.png",
    "物品格子": "物品格子.png",
    "物品卡": "物品卡.png",
    "横板告示": "横板告示.png",
    "指南针": "指南针.png",
    "滑动条（米白色）": "滑动条（米白色）.png",
    "滑动条（咖啡色）": "滑动条（咖啡色）.png",
    "滑动按键": "滑动按键.png",
}

# smart-object layers that keep their PSD-exported original asset (no UI组件 counterpart)
PSD_EXPORT_OK = {
    "芍药", "墨墨-森系", "墨墨-皮草", "墨墨-休闲-蓝", "墨墨-知性",
    "墨墨（初始立绘）", "微笑", "卧房-早", "卧房", "金海", "香炉", "夏祭",
    "课文牌（正面）", "白框", "属性_副本", "圆弧条", "星轨",
}

# 用户提供的更新版部件（覆盖 UI组件 同名部件）
#   transform: 按真实放置框放置（保留素材内部留白，按钮美术自然缩小拉开）
#   alpha:     按可见内容对齐 PSD bbox
# 注意: 按键（已点击）新 仅用于 人物·跳转换装-送礼 的两个按键，
#       其余界面的 按键（已点击）仍用 按键B
USER_ASSETS = {
    "图层 1": {"url": "assets/CG（无图）.png", "mode": "alpha"},
}


def sanitize(s):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s)[:60] if False else _sanitize(s)


def _sanitize(s):
    return re.sub(r'[\\/:*?"<>|\s]+', "_", s)[:60]


import re
import hashlib
import io

_export_hash = {}


def sha_of(im):
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    return hashlib.sha1(im.tobytes()).hexdigest()


def save_dedup(im, rel_name):
    h = sha_of(im)
    if h in _export_hash:
        return _export_hash[h]
    path = os.path.join(ASSETS_DIR, rel_name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path)
    url = "assets/" + rel_name
    _export_hash[h] = url
    return url


def transform_bounds(layer, bbox):
    """Returns (place rect, flip_h)."""
    try:
        tb = layer.smart_object.transform_box
        if tb is None:
            return bbox, False
        xs = [tb[0], tb[2], tb[4], tb[6]]
        ys = [tb[1], tb[3], tb[5], tb[7]]
        left, right = min(xs), max(xs)
        top, bottom = min(ys), max(ys)
        corners = [(tb[0], tb[1]), (tb[2], tb[3]), (tb[4], tb[5]), (tb[6], tb[7])]
        if not all(abs(x - left) < 0.01 or abs(x - right) < 0.01 for x, _ in corners):
            return bbox, False
        if not all(abs(y - top) < 0.01 or abs(y - bottom) < 0.01 for _, y in corners):
            return bbox, False
        flip_h = corners[0][0] > corners[1][0]  # first corner at top-right -> mirrored
        return {"left": left, "top": top, "right": right,
                "bottom": bottom, "width": right - left, "height": bottom - top}, flip_h
    except Exception:
        return bbox, False


def alpha_aligned_place(comp_path, bbox, flip_h, transform_place=None):
    """Place a UI组件 component so its VISIBLE (alpha) content lands exactly on the
    PSD layer bbox. If transform_place is given and its visible extent already
    matches the bbox (component padding == PSD embedded), keep it (exact)."""
    import numpy as np
    from PIL import Image as PILImage
    im = PILImage.open(comp_path).convert("RGBA")
    A = np.asarray(im)
    ys, xs = np.where(A[:, :, 3] > 1)  # Photoshop trim convention: any non-zero alpha
    if len(xs) == 0:
        return transform_place or bbox
    ix0, ix1, iy0, iy1 = xs.min(), xs.max(), ys.min(), ys.max()
    vw, vh = ix1 - ix0 + 1, iy1 - iy0 + 1
    if vw < 2 or vh < 2:
        return transform_place or bbox
    if transform_place is not None:
        sx = transform_place["width"] / float(im.size[0])
        sy = transform_place["height"] / float(im.size[1])
        if flip_h:
            vis_l = transform_place["left"] + transform_place["width"] - (ix1 + 1) * sx
            vis_r = transform_place["left"] + transform_place["width"] - ix0 * sx
            vis_t = transform_place["top"] + (iy1 + 1) * sy
            vis_b = transform_place["top"] + iy0 * sy
        else:
            vis_l = transform_place["left"] + ix0 * sx
            vis_r = transform_place["left"] + (ix1 + 1) * sx
            vis_t = transform_place["top"] + iy0 * sy
            vis_b = transform_place["top"] + (iy1 + 1) * sy
        if (abs(vis_l - bbox["left"]) <= 6.0 and abs(vis_r - bbox["right"]) <= 6.0
                and abs(vis_t - bbox["top"]) <= 6.0 and abs(vis_b - bbox["bottom"]) <= 6.0):
            return transform_place  # component padding matches PSD (±6px 渲染软边) -> exact
    sx = bbox["width"] / float(vw)
    sy = bbox["height"] / float(vh)
    w = im.size[0] * sx
    h = im.size[1] * sy
    if flip_h:
        left = bbox["left"] - w + (ix1 + 1) * sx
        top = bbox["top"] - iy0 * sy
    else:
        left = bbox["left"] - ix0 * sx
        top = bbox["top"] - iy0 * sy
    return {"left": left, "top": top, "right": left + w, "bottom": top + h,
            "width": w, "height": h}


def is_atmosphere(name, kind, screen):
    if name in ATMOSPHERE_ANY:
        # 设置界面的星光在图层栈最顶部（BACK按钮之上），未并入合并底图 -> 保留
        if screen == "设置界面" and name == "星光":
            return False
        return True
    if name == "底图" or name.startswith("底图 "):
        return MERGED_BG.get(screen) is not None
    if kind in ("pixel", "gradientfill"):
        for p in ATMOSPHERE_PREFIX:
            if name.startswith(p):
                return True
    if kind == "gradientfill":
        return True  # all gradient-fill layers (incl. clipped ones) -> baked/skip
    return False


# 开屏整图替换：用户提供的完整标题图（MOMO/四卡/星轨均已并入），
# 仅保留四个菜单文本层并按新标签+卡片中心重排
KP_TITLE_IMAGE = "assets/开屏-整图.png"
KP_MENU = {
    # layer name -> (new label, card center x, measured from card dark-interior spans)
    "新的开始": ("新的故事", 449),
    "继续旅程": ("继续旅程", 790),
    "CG鉴赏": ("CG鉴赏", 1126),
    "关于作者": ("关于作者", 1465),
}


def settings_fixups(name, kind, screen):
    """设置界面：BACK按钮与其他界面对齐(106,65)；墨墨换用带效果整图。"""
    if screen != "设置界面":
        return None
    if name == "BACK按钮" and kind == "smartobject":
        return {"back_align": True}
    if name == "墨墨" and kind == "smartobject":
        return {"panel_asset": "assets/设置界面-看板-墨墨.png",
                "panel_size": [1920, 1080]}
    return None


def keep_clipped_pixel(name, clipping, kind):
    """Clipped pixel layers attached to content (开屏 scene shadows, 音量 slider fill)
    are content, not atmosphere: keep them."""
    return kind == "pixel" and clipping and name.startswith("渐变填充")


def is_dynamic_slider(name, kind, screen):
    """音量界面：滑动条3 为 PSD 静态填充示意（动态填充替代）；
    指南针已并入合并底图，跳过独立图层。"""
    if screen == "音量:阅读模式界面" and kind == "pixel" and name == "滑动条3":
        return True
    if screen == "音量:阅读模式界面" and kind == "smartobject" and name == "指南针":
        return True
    return False


def slider_base_override(name, kind, screen):
    """音量界面：滑动条2 的 PSD 底为咖啡色(满格态)，运行时底条统一米白色，
    满格程度由动态棕色填充表达。"""
    if screen == "音量:阅读模式界面" and name == "滑动条2" and kind == "smartobject":
        return "滑动条（米白色）.png"
    return None


def export_smart_original(layer, screen):
    so = layer.smart_object
    fn = (so.filename or "").rstrip("\x00").strip()
    stem = os.path.splitext(os.path.basename(fn))[0]
    ext = os.path.splitext(fn)[1].lower()
    try:
        data = so.data
    except Exception:
        data = None
    if data and ext in (".png", ".jpg", ".jpeg", ".webp"):
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        return save_dedup(im, _sanitize(stem) + ".png"), im.size
    try:
        inner = so.open(PSDImage)
        im = inner.composite().convert("RGBA")
        return save_dedup(im, _sanitize(stem) + ".png"), im.size
    except Exception:
        return None, None


def layer_content(layer):
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
    if getattr(layer, "has_mask", False) and getattr(layer, "mask", None) is not None:
        try:
            im = layer.composite()
        except Exception:
            pass
    return im.convert("RGBA") if im is not None else None


def main():
    for psd_path in sorted(glob.glob(os.path.join(ROOT, "*.psd"))):
        screen = os.path.splitext(os.path.basename(psd_path))[0]
        print("== layout2", screen, flush=True)
        psd = PSDImage.open(psd_path)
        jdata = json.load(open(os.path.join(DATA_DIR, screen + ".json"), encoding="utf-8"))

        entries = []

        def walk(psd_layers, json_layers, parent_id):
            for pl, jl in zip(psd_layers, json_layers):
                eid = "L%03d" % len(entries)
                b = pl.bbox
                bbox = {"left": b[0], "top": b[1], "right": b[2], "bottom": b[3],
                        "width": b[2] - b[0], "height": b[3] - b[1]}
                e = {
                    "id": eid, "parent": parent_id, "name": pl.name, "kind": pl.kind,
                    "visible": pl.visible, "opacity": round(pl.opacity / 255.0, 4),
                    "blend_mode": str(pl.blend_mode), "clipping": bool(pl.clipping),
                    "bbox": bbox, "json": jl,
                }
                atmos = is_atmosphere(pl.name, pl.kind, screen)
                if (screen == "开屏" and pl.kind != "group"
                        and not (pl.kind == "type" and pl.name in KP_MENU)):
                    # 开屏整图已并入全部视觉元素，仅保留四个菜单文本层
                    # （菜单 = 纯文字点击跳转，无按钮美术；组容器保留以维持树结构递归）
                    e["skip"] = "baked-in-title-image"
                    e["asset"] = None
                elif is_dynamic_slider(pl.name, pl.kind, screen):
                    e["skip"] = "dynamic-slider-fill"
                    e["asset"] = None
                elif atmos and not keep_clipped_pixel(pl.name, pl.clipping, pl.kind):
                    e["skip"] = "merged-bg"
                    e["asset"] = None
                elif pl.kind == "smartobject":
                    fn = (pl.smart_object.filename or "").rstrip("\x00").strip()
                    stem = os.path.splitext(os.path.basename(fn))[0]
                    place, flip_h = transform_bounds(pl, bbox)
                    fix = settings_fixups(pl.name, pl.kind, screen) or {}
                    if fix.get("back_align"):
                        place = {"left": 106.0, "top": 65.0, "right": 450.0, "bottom": 187.0,
                                 "width": 344.0, "height": 122.0}
                    if fix.get("panel_asset"):
                        e["asset"] = {"url": fix["panel_asset"], "source": "user-panel",
                                      "place": {"left": 0, "top": 0, "right": 1920, "bottom": 1080,
                                                "width": 1920, "height": 1080},
                                      "natural": fix["panel_size"]}
                    else:
                        ua = USER_ASSETS.get(stem)
                        if (screen == "人物" and pl.name == "按键（已点击） 拷贝"
                                and stem == "按键（已点击）"):
                            # 仅人物·跳转换装-送礼 的两个按键用新素材（缩小拉开）
                            ua = {"url": "assets/按键（已点击）新.png", "mode": "transform"}
                        comp = slider_base_override(pl.name, pl.kind, screen) or COMPONENT_MAP.get(stem)
                        if screen == "主画面" and pl.name == "对话组件-选择条（选中）":
                            # 深色选中条槽位改为第二个浅色（未选中）条（用户要求两条都是白色）
                            comp = "对话组件-选择条（未选中）.png"
                        if screen == "回放界面" and pl.name == "对话回放":
                            # 用户调过效果的面板素材（整屏透明底），替换 横板告示+剪贴渐变
                            comp = "回放界面-面板.png"
                            e["asset"] = {"url": "../UI组件/" + comp, "source": "user-panel",
                                          "component": comp,
                                          "place": {"left": 0, "top": 0, "right": 1920, "bottom": 1080,
                                                    "width": 1920, "height": 1080},
                                          "natural": [1920, 1080]}
                        elif ua:
                            apath = os.path.join(ROOT, "UI还原", ua["url"])
                            if ua["mode"] == "transform":
                                aplace = place
                            else:
                                aplace = alpha_aligned_place(apath, bbox, flip_h, transform_place=place)
                            e["asset"] = {"url": ua["url"], "source": "user-asset",
                                          "place": aplace, "flip_h": flip_h,
                                          "natural": list(Image.open(apath).size)}
                        elif comp and os.path.exists(os.path.join(UI_DIR, comp)):
                            # 组件放置：padding与PSD一致时保持精确transform放置；
                            # 不一致（重导出边距变化）时按可见内容对齐PSD bbox
                            aplace = alpha_aligned_place(os.path.join(UI_DIR, comp), bbox,
                                                          flip_h, transform_place=place)
                            e["asset"] = {"url": "../UI组件/" + comp, "source": "component",
                                          "component": comp, "place": aplace, "flip_h": flip_h,
                                          "natural": list(Image.open(os.path.join(UI_DIR, comp)).size)}
                        else:
                            url, nat = export_smart_original(pl, screen)
                            if url:
                                e["asset"] = {"url": url, "source": "export", "flip_h": flip_h,
                                              "place": place, "natural": list(nat) if nat else None}
                            else:
                                c = layer_content(pl)
                                if c is not None:
                                    url = save_dedup(c, "%s/%s_%s.png" % (_sanitize(screen), _sanitize(screen), _sanitize(pl.name)))
                                    e["asset"] = {"url": url, "source": "export-placed",
                                                  "place": bbox, "natural": list(c.size)}
                                else:
                                    e["asset"] = None
                elif pl.kind in ("pixel", "shape"):
                    c = layer_content(pl)
                    if c is None:
                        e["asset"] = None
                    else:
                        # pixel layers: name-based component mapping
                        comp = None
                        if pl.name == "换装背板":
                            comp = "换装卡片背板.png"
                        if comp and os.path.exists(os.path.join(UI_DIR, comp)):
                            e["asset"] = {"url": "../UI组件/" + comp, "source": "component",
                                          "component": comp, "place": bbox,
                                          "natural": list(Image.open(os.path.join(UI_DIR, comp)).size)}
                        else:
                            url = save_dedup(c, "%s/%s_%s.png" % (_sanitize(screen), _sanitize(screen), _sanitize(pl.name)))
                            e["asset"] = {"url": url, "source": "export", "place": bbox,
                                          "natural": list(c.size)}
                else:
                    e["asset"] = None  # group / type: no image asset
                entries.append(e)
                if pl.kind == "group":
                    walk(pl, jl["children"], eid)
        walk(list(psd), jdata["layers"], None)

        # 主画面：下侧浅色选择条与上侧同尺寸（沿用上条的宽/高，y 保持原位）
        if screen == "主画面":
            sel = next((e for e in entries if e["name"] == "对话组件-选择条（选中）"), None)
            unsel = next((e for e in entries if e["name"] == "对话组件-选择条（未选中）"), None)
            if sel is not None and unsel is not None:
                b = sel["bbox"]
                top = unsel["bbox"]["top"]
                nb = {"left": b["left"], "top": top, "right": b["right"],
                      "bottom": top + b["height"], "width": b["width"], "height": b["height"]}
                unsel["bbox"] = dict(nb)
                a = unsel.get("asset") or {}
                comp = a.get("component")
                if comp and os.path.exists(os.path.join(UI_DIR, comp)):
                    # 按素材留白外扩放置框，使可见内容精确填满目标框
                    a["place"] = alpha_aligned_place(os.path.join(UI_DIR, comp), nb,
                                                     bool(a.get("flip_h")), None)

        # 开屏：菜单文本层 -> 新标签 + 按卡片中心水平居中（y 保持 PSD 位置）
        if screen == "开屏":
            import copy
            for e in entries:
                if e["kind"] == "type" and e["name"] in KP_MENU:
                    label, cx = KP_MENU[e["name"]]
                    jt = copy.deepcopy(e["json"])
                    jt["type"]["text"] = label
                    for r in jt["type"].get("runs", []):
                        r["text"] = label
                    b = e["bbox"]
                    left = cx - b["width"] / 2.0
                    e["bbox"] = {"left": left, "top": b["top"], "right": left + b["width"],
                                 "bottom": b["bottom"], "width": b["width"], "height": b["height"]}
                    e["json"] = jt

        # merged bg entry as first layer (z below everything)
        bg_name = MERGED_BG.get(screen)
        if screen == "开屏" and os.path.exists(os.path.join(ASSETS_DIR, "开屏-整图.png")):
            bg_entry = {
                "id": "L000", "parent": None, "name": "开屏整图", "kind": "merged-bg",
                "visible": True, "opacity": 1.0, "blend_mode": "BlendMode.NORMAL",
                "clipping": False,
                "bbox": {"left": 0, "top": 0, "right": 1920, "bottom": 1080,
                         "width": 1920, "height": 1080},
                "asset": {"url": KP_TITLE_IMAGE, "source": "user-title-image",
                          "place": {"left": 0, "top": 0, "right": 1920, "bottom": 1080,
                                    "width": 1920, "height": 1080},
                          "natural": [1920, 1080]},
                "json": {},
            }
            bg_entry["id"] = "BG00"
            entries.insert(0, bg_entry)
            remap = {}
            for i, e in enumerate(entries):
                remap[e["id"]] = "L%03d" % i
            for e in entries:
                e["id"] = remap[e["id"]]
                if e["parent"] is not None:
                    e["parent"] = remap[e["parent"]]
        elif bg_name and os.path.exists(os.path.join(UI_DIR, bg_name)):
            bg_entry = {
                "id": "L000", "parent": None, "name": "合并底图", "kind": "merged-bg",
                "visible": True, "opacity": 1.0, "blend_mode": "BlendMode.NORMAL",
                "clipping": False,
                "bbox": {"left": 0, "top": 0, "right": 1920, "bottom": 1080,
                         "width": 1920, "height": 1080},
                "asset": {"url": "../UI组件/" + bg_name, "source": "component",
                          "component": bg_name, "place": {"left": 0, "top": 0, "right": 1920, "bottom": 1080, "width": 1920, "height": 1080},
                          "natural": list(Image.open(os.path.join(UI_DIR, bg_name)).size)},
                "json": {},
            }
            bg_entry["id"] = "BG00"
            entries.insert(0, bg_entry)
            # renumber ids consistently (bg takes L000, everything shifts)
            remap = {}
            for i, e in enumerate(entries):
                remap[e["id"]] = "L%03d" % i
            for e in entries:
                e["id"] = remap[e["id"]]
                if e["parent"] is not None:
                    e["parent"] = remap[e["parent"]]

        by_id = {e["id"]: e for e in entries}
        for e in entries:
            if e["parent"] is not None and e["parent"] in by_id:
                by_id[e["parent"]].setdefault("children", []).append(e["id"])
        # clip base resolution
        for e in entries:
            if not e["clipping"]:
                continue
            base = None
            if e["parent"] is not None and e["parent"] in by_id:
                sibs = by_id[e["parent"]]["children"]
                if e["id"] in sibs:
                    i = sibs.index(e["id"])
                    for j in range(i - 1, -1, -1):
                        if not by_id[sibs[j]]["clipping"]:
                            base = sibs[j]
                            break
            e["clip_base"] = base

        out = {"screen": screen, "width": psd.width, "height": psd.height, "layers": entries}
        with open(os.path.join(DATA_DIR, "layout2_%s.json" % screen), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
        skipped = [e["name"] for e in entries if e.get("skip")]
        print("   skipped(merged-bg):", len(skipped), "| layers:", len(entries))


if __name__ == "__main__":
    main()
