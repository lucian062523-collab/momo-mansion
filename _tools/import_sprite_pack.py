# -*- coding: utf-8 -*-
"""墨墨 · 立绘包导入（把外部给的两类「更新包」并进素材库）

用户会不定期丢包过来，目前见过两种打包形态，都要支持：

  A. 平铺包（立绘补充&更新包）：分类目录里平铺着「{套装前缀}-{表情}.png」，
     同一套的图靠**文件名前缀**认。见下面的 SET_DIRS。
  B. 分套包（墨墨的新装）：分类目录下每个「墨墨-{套装}/」自己一个文件夹，
     文件夹里是「{套装}-{表情}.png」+ 一张默认立绘（{套装}-默认.png 或 {套装}.png）。
     见下面的 CAT_DIRS —— 文件夹名就是套装名，比形态 A 靠前缀猜可靠得多。

形态 B 的表情名只取文件名最后一个「-」之后的部分，所以「秋栗子-害羞.png」这种
前缀笔误会被自动归一到该套，不会漏图也不会串套。

两种形态的共同要求：这些图要落到素材库对应的套装目录：

    墨墨-美术资产-web/立绘-校园包/墨墨-运动/运动-夏-疑惑.webp

三件事必须做对，否则「图换了但游戏里没变」：

  1) **转成 webp 并按目录里既有的前缀命名** —— 各套前缀并不统一
     （初始立绘 / 运动-夏 / 休闲-粉 / 职业 / 森系…），新图跟着旧的叫什么。
  2) **同一个（套装，表情）只留一份**：像「惊讶 / 眯眼笑 / 欲言又止」这批是重画的，
     包里的 png 和库里的 webp 同名同表情 —— 直接覆盖旧 webp，不能两份并存，
     否则 build_expr_map 会在两份里随机挑一个，改了图却看不出变化。
  3) 导入完要重跑 _tools/build_expr_map.py 重建表情表，再重建产物。

只能靠文件名认套装 —— 所以文件必须带前缀（「校园/眯眼笑.png」这种无前缀的会被跳过）。

用法：  python3 _tools/import_sprite_pack.py "/Users/lucian/Desktop/立绘补充&更新包"
        python3 _tools/import_sprite_pack.py "<包目录>" --dry-run
"""

import io
import os
import sys
from collections import Counter

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "墨墨-美术资产-web")
WEBP_QUALITY = 82                       # 与 build_dist 保持一致
IMG_EXT = (".png", ".webp", ".jpg", ".jpeg", ".gif")

# 包里的分类目录 → 素材库里的分类目录（形态 B 用；形态 A 的 SET_DIRS 里也各自带着路径）
# 华服单开一包：墨墨-和风合集 是原来那批和服，新来的华服（墨藤/酒欲/黑珍…）不是和风
CAT_DIRS = {
    "校园": "立绘-校园包",
    "生活": "立绘-生活包",
    "职业": "立绘-职场合集包",
    "华服": "立绘-华服包",
}

# 形态 A：包里的「分类目录 + 套装前缀」→ 素材库里的套装目录。
# 写死而不是自动猜：包里的 休闲装-粉 与库里的 休闲-粉、包里的 职业 与库目录 墨墨-职业装
# 都对不上，靠字符串相似度去凑迟早会串套。
SET_DIRS = {
    "校园": {
        "初始立绘": "立绘-校园包/墨墨-初始立绘",
        "制服裙": "立绘-校园包/墨墨-制服裙",
        "软毛衣": "立绘-校园包/墨墨-软毛衣",
        "运动-夏": "立绘-校园包/墨墨-运动",
        "不良": "立绘-校园包/墨墨-不良",
    },
    "生活": {
        "森系": "立绘-生活包/森系",
        "皮草": "立绘-生活包/墨墨-皮草",
        "知性": "立绘-生活包/墨墨-知性",
        "休闲-蓝": "立绘-生活包/墨墨-休闲-蓝",
        "休闲-粉": "立绘-生活包/墨墨-休闲装-粉",
        "休闲装-粉": "立绘-生活包/墨墨-休闲装-粉",
    },
    "职业": {
        "礼服": "立绘-职场合集包/墨墨-礼服",
        "简装": "立绘-职场合集包/墨墨-简装",
        "职业": "立绘-职场合集包/墨墨-职业装",
        "间谍": "立绘-职场合集包/墨墨-间谍",
    },
    "华服": {
        "紫苏": "墨墨-和风合集/墨墨-紫苏",
        "艳楸": "墨墨-和风合集/墨墨-艳楸",
        "葱葱": "墨墨-和风合集/墨墨-葱葱",
        "金鲤": "墨墨-和风合集/墨墨-金鲤",
        "铅华": "墨墨-和风合集/墨墨-铅华",
    },
}


def canon_prefix(folder):
    """套装目录里既有的表情前缀（出现次数最多的那个）。
       默认立绘以「墨墨」开头（墨墨-紫苏 / 墨墨（初始立绘））或本身就是套装图，
       所以统计时排除掉；剩下 森系-不悦 / 运动-夏-疑惑 这类才是表情文件。"""
    c = Counter()
    if not os.path.isdir(folder):
        return None
    for fn in os.listdir(folder):
        stem, ext = os.path.splitext(fn)
        if ext.lower() not in IMG_EXT or "-" not in stem:
            continue
        if stem.startswith("墨墨"):
            continue
        c[stem.rsplit("-", 1)[0]] += 1
    return c.most_common(1)[0][0] if c else None


def to_webp(src, dst):
    """PNG → webp（有 alpha 走 RGBA，跟 build_dist 的产物口径一致）"""
    im = Image.open(src)
    alpha = (im.mode in ("RGBA", "LA")
             or (im.mode == "P" and "transparency" in im.info))
    buf = io.BytesIO()
    if alpha:
        im.convert("RGBA").save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    else:
        im.convert("RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    with open(dst, "wb") as f:
        f.write(buf.getvalue())


def import_nested(cat, cd, dry, rep):
    """形态 B：分类目录下每个「墨墨-{套装}/」自己一个文件夹。
       文件夹名就是权威的套装名，所以表情名只取文件名最后一个「-」之后的部分，
       前缀写错（秋栗子-害羞）也能归到本套。默认立绘统一存成「墨墨-{套装}.webp」，
       跟库里既有的默认图命名保持一致；叫「默认」的那张当默认立绘、不当表情。"""
    dest_dir = os.path.join(LIB, CAT_DIRS.get(cat, cat))
    for st in sorted(os.listdir(cd)):
        sd = os.path.join(cd, st)
        if not os.path.isdir(sd) or st.startswith("."):
            continue
        name = st[3:] if st.startswith("墨墨-") else st
        files = [f for f in sorted(os.listdir(sd)) if _ext(f) in IMG_EXT]
        dflt = None
        for cand in ("%s-默认" % name, name, "墨墨-%s" % name):
            for f in files:
                if os.path.splitext(f)[0] == cand:
                    dflt = f
                    break
            if dflt:
                break
        if not dflt:
            rep["skipped"].append("%s/%s（找不到默认立绘）" % (cat, st))
            continue
        out_dir = os.path.join(dest_dir, "墨墨-%s" % name)
        if not dry:
            os.makedirs(out_dir, exist_ok=True)
        dst = os.path.join(out_dir, "墨墨-%s.webp" % name)
        existed = os.path.exists(dst)
        if not dry:
            to_webp(os.path.join(sd, dflt), dst)
        rep["overwrote" if existed else "ok"].append(
            "墨墨-%s.webp%s  ←  %s/%s/%s" % (name, "" if existed else "  [新增]", cat, st, dflt))
        rep["sets"].append((cat, name, len(files)))
        for f in files:
            if f == dflt:
                continue
            stem = os.path.splitext(f)[0]
            if "-" not in stem:
                rep["skipped"].append("%s/%s/%s（没有前缀，认不出表情）" % (cat, st, f))
                continue
            expr = stem.rsplit("-", 1)[1]
            if expr == "默认":
                rep["skipped"].append("%s/%s/%s（「默认」是回默认立绘的哨兵值，不当表情）"
                                      % (cat, st, f))
                continue
            dst2 = os.path.join(out_dir, "%s-%s.webp" % (name, expr))
            existed2 = os.path.exists(dst2)
            if not dry:
                to_webp(os.path.join(sd, f), dst2)
            rep["overwrote" if existed2 else "ok"].append(
                "%s-%s.webp%s  ←  %s/%s/%s"
                % (name, expr, "" if existed2 else "  [新增]", cat, st, f))


def _ext(fn):
    return os.path.splitext(fn)[1].lower()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        print(__doc__)
        return 2
    pack = os.path.abspath(args[0])
    if not os.path.isdir(pack):
        print("找不到包目录：%s" % pack)
        return 2

    rep = {"ok": [], "overwrote": [], "skipped": [], "sets": []}
    for cat in sorted(os.listdir(pack)):
        cd = os.path.join(pack, cat)
        if not os.path.isdir(cd) or cat.startswith("."):
            continue
        # 形态判定：分类目录里还有子目录 = 分套包（形态 B），否则是平铺包（形态 A）
        if any(os.path.isdir(os.path.join(cd, x)) and not x.startswith(".")
               for x in os.listdir(cd)):
            import_nested(cat, cd, dry, rep)
            continue
        for fn in sorted(os.listdir(cd)):
            src = os.path.join(cd, fn)
            if not os.path.isfile(src) or _ext(fn) not in IMG_EXT:
                continue
            stem = os.path.splitext(fn)[0]
            if "-" not in stem:
                rep["skipped"].append("%s/%s（文件名没有前缀，认不出是哪套）" % (cat, fn))
                continue
            prefix, expr = stem.rsplit("-", 1)
            rel = SET_DIRS.get(cat, {}).get(prefix)
            if not rel:
                rep["skipped"].append("%s/%s（分类/前缀没登记：%s）" % (cat, fn, prefix))
                continue
            folder = os.path.join(LIB, rel)
            cp = canon_prefix(folder) or prefix
            dst = os.path.join(folder, "%s-%s.webp" % (cp, expr))
            existed = os.path.exists(dst)
            if not dry:
                to_webp(src, dst)
            rep["overwrote" if existed else "ok"].append(
                "%s-%s.webp%s  ←  %s/%s" % (cp, expr, "" if existed else "  [新增]", cat, fn))

    ok, overwrote, skipped, sets = rep["ok"], rep["overwrote"], rep["skipped"], rep["sets"]
    print("包目录：%s%s" % (pack, "   （dry-run，没有真的写文件）" if dry else ""))
    if sets:
        print("套装 %d 套：" % len(sets))
        for cat, name, n in sets:
            print("   %-4s %-10s %d 张" % (cat, name, n))
    print("新增 %d 张：" % len([x for x in ok]))
    for x in ok:
        print("   +", x)
    print("覆盖旧图 %d 张：" % len(overwrote))
    for x in overwrote:
        print("   ~", x)
    if skipped:
        print("跳过 %d 张：" % len(skipped))
        for x in skipped:
            print("   !", x)
    if not dry:
        print("\n下一步：补 wardrobe.json 的新套装 → python3 _tools/build_expr_map.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())