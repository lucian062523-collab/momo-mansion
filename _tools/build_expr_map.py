# -*- coding: utf-8 -*-
"""墨墨 · 立绘表情表生成（生成物：game/content/expressions.json）

每套立绘都是「一张默认图 + 若干张 '{套装前缀}-{表情}.webp'」同目录摆放，
但各套的前缀并不统一（初始立绘 / 运动-夏 / 休闲-蓝 / 职业 …），
所以不能靠运行时拼文件名，得在构建期扫出来落成一张表：

    套装默认图文件名 → { 表情名: 表情图文件名 }

director.js 说「表情：不悦」时拿当前套装的默认图来这里查，查不到就退回默认图
（例如华服那几套还没有表情图），保证立绘永远有东西可显示。

素材解析顺序复用 build_dist.LIBS，避免两份索引各自漂移。

用法：  python3 _tools/build_expr_map.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_dist as BD  # noqa: E402  （只用到 LIBS / build_index / CONTENT_DIR）

OUT = os.path.join(BD.CONTENT_DIR, "expressions.json")
IMG_EXT = (".webp", ".png")

# 表情名同样不统一：同一张「难过脸」，多数套的文件叫「悲伤」，简装那套叫「难过」。
# 文案（送礼回话）统一写的是「难过」——不归一的话，同一个表情 18 套都叫悲伤、
# 只有简装叫难过，文案写哪个都会有一半的套退回默认立绘。这里把别名折到主名上。
EXPR_ALIAS = {"难过": "悲伤"}


def main():
    idx = BD.build_index()
    wd = json.load(open(os.path.join(BD.CONTENT_DIR, "wardrobe.json"), encoding="utf-8"))

    sets, no_dir, no_expr = {}, [], []
    for s in wd["sets"]:
        img = s["img"]
        path = idx.get(img)
        if not path:
            no_dir.append("%s (%s)" % (s["id"], img))
            continue
        d = os.path.dirname(path)
        exprs = {}
        for fn in sorted(os.listdir(d)):
            stem, ext = os.path.splitext(fn)
            if ext.lower() not in IMG_EXT or fn == img:
                continue
            # 表情名 = 最后一个「-」之后的部分（运动-夏-不悦 → 不悦），再过一遍别名表
            if "-" not in stem:
                continue
            name = stem.rsplit("-", 1)[1]
            exprs[EXPR_ALIAS.get(name, name)] = fn
        if exprs:
            sets[img] = exprs
        else:
            no_expr.append("%s (%s)" % (s["id"], img))

    out = {
        "version": 1,
        "note": "生成物，勿手改：_tools/build_expr_map.py。"
                "套装默认图 → {表情: 图}；'默认' 表示用套装自己的默认图。"
                "aliases 是表情别名（同一种表情在不同套里文件名不一致），写文案时按主名写即可。",
        "default": "默认",
        "aliases": EXPR_ALIAS,
        "sets": sets,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("已写出 %s" % OUT)
    print("   有表情的套装 %d 套（共 %d 套）" % (len(sets), len(wd["sets"])))
    for img, m in sets.items():
        print("     %-22s %s" % (img, " / ".join(sorted(m))))
    if no_expr:
        print("   [无表情图，退回默认立绘] %d 套：%s" % (len(no_expr), "，".join(no_expr)))
    if no_dir:
        print("   [找不到默认图] %d 套：%s" % (len(no_dir), "，".join(no_dir)))
    return 0


if __name__ == "__main__":
    sys.exit(main())