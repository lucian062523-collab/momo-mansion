# -*- coding: utf-8 -*-
"""从地图 PSD 里抽出「点按跳转范围示意」灰块的坐标 → game/content/map.json，
同时把 4 张干净平面图转 webp。

灰块是 PSD 里的定位占位，**不进最终画面**；成品只用导出的干净 png（转 webp 后内联）。
坐标按画布归一化成 0-1，前端用百分比定位，所以任何分辨率下都不会错位。
"""
import json, os
from psd_tools import PSDImage
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "新美术资产", "地图")
OUT_ART = os.path.join(ROOT, "墨墨-美术资产-web", "maps")
OUT_JSON = os.path.join(ROOT, "game", "content", "map.json")

# 平面图 → (楼层键, 显示名)。前三个是洋馆楼层，最后一个是室外。
MAPS = [
    ("F1.png", "F1", "洋馆 1F"),
    ("F2.png", "F2", "洋馆 2F"),
    ("F3.png", "F3", "洋馆 3F"),
    ("洋馆区室外大地图.png", "OUT", "洋馆区"),
]
# 灰块名 → 场景基名候选（场景文件按 基名-时段 查找）。
# 命中第一个可用的就用它；这样「游乐园/游乐场」「观星台/观星室」这类
# 美术命名不统一的情况都能兜住，不用去改美术。
ALIAS = {
    "卧室": ["卧房"],
    "咖啡馆": ["咖啡店"],
    "游乐园": ["游乐园", "游乐场"],
    "观星台": ["观星台", "观星室"],
    "洋馆（家）": ["洋馆"],
    "阳台": [],            # 场景图还没画
}
STAIR = "楼梯"


def norm(name):
    """灰块名 → 场景基名候选列表"""
    if name in ALIAS:
        return ALIAS[name]
    if STAIR in name:
        # 「F1楼梯(点这里换楼层）」→ F1楼梯
        return [name.split("(")[0].split("（")[0].strip()]
    return [name]


def main():
    os.makedirs(OUT_ART, exist_ok=True)
    floors = {}
    total_hot = 0

    for png, key, label in MAPS:
        psd_path = os.path.join(SRC, png.replace(".png", ".psd"))
        psd = PSDImage.open(psd_path)
        W, H = psd.width, psd.height

        group = None
        for l in psd:
            if l.is_group() and "范围" in l.name:
                group = l
                break
        if group is None:
            # 室外大地图那组没按命名规范走（叫「组 1」），退而取「像素层最多的组」
            best, bestn = None, 0
            for l in psd:
                if l.is_group():
                    n = sum(1 for c in l if c.kind == "pixel")
                    if n > bestn:
                        best, bestn = l, n
            group = best
        if group is None:
            print(f"  !! {png}: 没找到灰块组")
            continue

        rooms = []
        for l in group:
            b = l.bbox
            x0, y0, x1, y1 = b
            raw = l.name
            is_stair = STAIR in raw
            rooms.append({
                "raw": raw,
                "label": "楼梯" if is_stair else raw,
                "kind": "stair" if is_stair else "room",
                "scene": norm(raw),
                # 归一化坐标（0-1），前端 × 容器尺寸 即可，分辨率无关
                "x": round(x0 / W, 5), "y": round(y0 / H, 5),
                "w": round((x1 - x0) / W, 5), "h": round((y1 - y0) / H, 5),
            })
        total_hot += len(rooms)

        # 干净平面图 → webp（画质优先，地图是主要的可视内容）
        im = Image.open(os.path.join(SRC, png)).convert("RGBA")
        dst = os.path.join(OUT_ART, key + ".webp")
        im.save(dst, "WEBP", quality=88, method=6)
        floors[key] = {
            "label": label,
            # 只存文件名：构建时按 basename 建 ASSET_URI（原文件名 → data URI）表，
            # 运行时用 MomoAsset 查表换图，所以这里不能带目录。
            "art": os.path.basename(dst),
            "canvas": [W, H],
            "rooms": rooms,
        }
        print(f"  {key:4s} {label}  {len(rooms)} 个可点区域 → {os.path.getsize(dst)//1024} KB")

    data = {
        "version": 1,
        "canvas": [1672, 941],
        "order": ["F1", "F2", "F3", "OUT"],
        "interior": ["F1", "F2", "F3"],   # 室内楼层（室外是 OUT）
        "floors": floors,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"共 {total_hot} 个可点区域 → {os.path.relpath(OUT_JSON, ROOT)}")


if __name__ == "__main__":
    main()