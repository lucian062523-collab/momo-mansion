# -*- coding: utf-8 -*-
"""整合新老场景包 → 统一的场景资源库 + 场景注册表 game/content/scenes.json

- 老包（墨墨-美术资产-web/scenes）已经是 webp，原样沿用
- 新包（新美术资产/新场景，162MB PNG）按「压得更狠」的档位转 webp 落进同一个目录
- 美术命名不统一（早晨/早/早上/白天、夜晚/夜/夜-开灯、全天），
  这里统一归到 早晨 / 傍晚 / 夜晚 三个时段，并保留候选优先级，前端按序取第一个可用。
"""
import json, os, re, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NEW_SRC = os.path.join(ROOT, "新美术资产", "新场景")
LIB = os.path.join(ROOT, "墨墨-美术资产-web", "scenes")
OUT_JSON = os.path.join(ROOT, "game", "content", "scenes.json")

# 后缀 → 归属时段，按长度降序匹配（贪婪，避免「夜-开灯」被拆成「夜」）
SUFFIX = [
    ("夜-开灯", "夜晚"), ("早晨", "早晨"), ("傍晚", "傍晚"), ("夜晚", "夜晚"),
    ("早上", "早晨"), ("白天", "早晨"), ("全天", "*"),    # 全天=三个时段通用
    ("早", "早晨"), ("夜", "夜晚"), ("晚上", "夜晚"),
]
PERIODS = ["早晨", "傍晚", "夜晚"]
# 每个时段的候选后缀优先级（越前越优先）
PRIORITY = {
    "早晨": ["早晨", "早", "早上", "白天", "全天"],
    "傍晚": ["傍晚", "全天"],
    "夜晚": ["夜晚", "夜", "晚上", "夜-开灯", "全天"],
}


def split_name(stem):
    for suf, per in SUFFIX:
        if stem.endswith("-" + suf):
            return stem[: -(len(suf) + 1)], suf, per
    return None, None, None


def main():
    os.makedirs(LIB, exist_ok=True)
    # 文件 → (基名, 后缀)
    entries = []

    # 新包：转 webp
    news = sorted(f for f in os.listdir(NEW_SRC) if f.lower().endswith(".png"))
    print(f"新场景：{len(news)} 张待转换（加重压缩）")
    for i, fn in enumerate(news, 1):
        stem = os.path.splitext(fn)[0]
        base, suf, per = split_name(stem)
        if base is None:
            print(f"  !! 无法识别时段：{fn}")
            continue
        dst = os.path.join(LIB, stem + ".webp")
        if not os.path.exists(dst):
            im = Image.open(os.path.join(NEW_SRC, fn)).convert("RGB")
            im.save(dst, "WEBP", quality=62, method=6)
        entries.append((base, suf, stem + ".webp", "新"))
        if i % 20 == 0:
            print(f"  …已处理 {i}/{len(news)}")

    # 老包：已存在，直接登记
    olds = sorted(f for f in os.listdir(LIB) if f.lower().endswith(".webp") and "_" not in f)
    for fn in olds:
        stem = os.path.splitext(fn)[0]
        base, suf, per = split_name(stem)
        if base is None:
            continue
        entries.append((base, suf, fn, "老"))

    # 组装注册表
    scenes = {}
    for base, suf, fn, _ in entries:
        # 只存文件名（见 build_map_assets.py 里的同款说明）
        scenes.setdefault(base, {})[suf] = fn

    reg = {}
    missing = {}
    for base, bySuf in sorted(scenes.items()):
        reg[base] = {}
        for per in PERIODS:
            for cand in PRIORITY[per]:
                if cand in bySuf:
                    reg[base][per] = bySuf[cand]
                    break
        if not reg[base]:
            missing[base] = "该房间没有任何可用场景"

    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "periods": PERIODS, "scenes": reg}, f,
                  ensure_ascii=False, indent=1)

    size = sum(os.path.getsize(os.path.join(LIB, f)) for f in os.listdir(LIB)
               if f.endswith(".webp"))
    print(f"\n场景库：{len(reg)} 个房间，共 {size // 1024 // 1024} MB "
          f"（{sum(1 for f in os.listdir(LIB) if f.endswith('.webp'))} 张 webp）")
    none_period = {b: v for b, v in reg.items() if len(v) < 3}
    if none_period:
        print("\n时段不全的房间（缺的时段会退回可用时段）：")
        for b, v in sorted(none_period.items()):
            print(f"  {b}: {'/'.join(v.keys()) or '无'}")


if __name__ == "__main__":
    main()