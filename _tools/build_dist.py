# -*- coding: utf-8 -*-
"""
墨墨 · 构建

把「11 屏 1:1 UI」+ 两个组件库 + 美术资产，打成可发布的产物。两种出图方式：

  【默认｜拆分】dist/index.html(~1.3MB) + dist/assets/(每张图一个 webp 文件)
      · CSS / JS / 剧情数据仍然全部内联，只有图片是外链文件
      · PNG 一律转 webp（质量 82）；已经是 webp 的原样拷过来
      · 图片名带内容哈希（玄关-早晨.a3f7b2c1.webp）：改图 → URL 变 → 自动绕开旧缓存，
        所以托管方可以放心给 assets/ 设长缓存，「固定链接 + 后台随时更新」才成立
      · window.ASSET_URI 把「原文件名 → assets/带哈希的名字.webp」，运行时代码一行不改
      · 直接挂静态托管（GitHub Pages / Cloudflare Pages…）；本地双击也能开
      · 同样的图，base64 内联要 82MB，写成文件只要 62MB（省掉 base64 的 33% 膨胀）

  【--single｜单文件】一个自包含的 index.html（图全部 base64 内联）
      · 双击一个文件就能玩、方便甩给别人的场景用它
      · 代价：体积随美术线性膨胀，而且托管方对单文件普遍有 25–100MB 上限

两种方式都会输出 window.ASSET_PATH_OF（产物里的图片引用 → 原始文件名）：
  拆分后文件名部分保留、单文件下彻底消失，而 ui.js 判断「深色底图」要靠它反查。

用法：  python3 _tools/build_dist.py            # 拆分（默认，用来发站）
        python3 _tools/build_dist.py --zip      # 顺便打一个可直接拖去托管的上传包
        python3 _tools/build_dist.py --single   # 单文件（用来发人）
"""

import os
import re
import io
import json
import base64
import hashlib
import shutil
import sys
import zipfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "UI还原")

# 素材解析顺序（先命中者胜出）
#  1) 库2：含全部 *-底图 / 按键A·B / 短小条A·B / 换装卡片背板
#  2) 库1：权威组件库
#  3) UI还原/assets：用户提供的更新资产 + PSD 内嵌原件
#  4) 美术资产-web：场景 / 立绘 / CG
LIBS = [
    "/Users/lucian/Desktop/UI完成品！（严格按照摆放位置，记样式参数，各图层删格化导出）_副本/UI组件",
    "/Users/lucian/Desktop/墨墨（美术资产）/UI组件",
    os.path.join(UI, "assets"),
    os.path.join(ROOT, "墨墨-美术资产-web"),
]

SRC_HTML = os.path.join(UI, "index.html")
# Service Worker 是唯一不进 index.html 的脚本 —— 它必须是一个能被浏览器单独
# 注册、单独更新的文件（内容哈希 / 内联都会让它失去意义）。构建原样拷进 dist。
SRC_SW = os.path.join(UI, "sw.js")
SRC_CSS = [os.path.join(UI, "css", "common.css"), os.path.join(UI, "css", "screens.css"),
           # learn.css 是生成物（_tools/build_learn_assets.py），放最后让组件样式有最终话语权
           os.path.join(UI, "css", "learn.css")]
# 脚本顺序要紧：ui.js 负责界面切换并派发 momo:show；
# store 提供存档；wardrobe / cg 监听 momo:show 接管各自界面。
GAME_JS = os.path.join(ROOT, "game", "js")
SRC_JS = [
    # 首屏资源搬运必须排在最前面：它负责把「正在下载美术资产」那层盖上去，
    # 并抢在游戏开始拉图之前先把 SW 注册上。
    os.path.join(GAME_JS, "preload.js"),
    # 音频引擎要在 ui.js 之前挂好监听：ui.js 求值完会立刻派发第一次 momo:show，
    # audio.js 晚于它加载就会错过开屏那一次（BGM 的屏政策靠这个事件驱动）。
    os.path.join(GAME_JS, "audio.js"),
    os.path.join(UI, "js", "ui.js"),
    os.path.join(GAME_JS, "store.js"),
    os.path.join(GAME_JS, "wardrobe.js"),
    os.path.join(GAME_JS, "cg.js"),
    os.path.join(GAME_JS, "items.js"),
    # 商城：商城界面六张卡（补给消费 + 导览），排在 store 之后即可
    os.path.join(GAME_JS, "shop.js"),
    # 兑换码：商城右下角入口 + 弹窗，只依赖 MOMO_DATA.redeem 与 MomoStore
    os.path.join(GAME_JS, "redeem.js"),
    os.path.join(GAME_JS, "timebar.js"),
    # 主画面氛围光尘（motes.js）：作者 2026-10-12 要求撤掉 —— 「有点像灰尘」。
    # 想恢复就把下面这行取消注释；motes.js 与 CSS 的 #scr-主画面 .motes、HTML 里的
    # <canvas class="motes"> 都原样留着，恢复不需要改别的地方。
    # os.path.join(GAME_JS, "motes.js"),
    os.path.join(GAME_JS, "choice.js"),
    os.path.join(GAME_JS, "name.js"),
    # expr 只管「现在是哪个表情」，director 靠它演剧本；两个都在 name 之后
    # （director 要用 MomoName.fill 填 {{name}}）
    os.path.join(GAME_JS, "expr.js"),
    os.path.join(GAME_JS, "director.js"),
    # idle 是「待机演出」：切场景的四拍 + 常态点墨墨。它靠 director.playNodes 演临时脚本，
    # 所以必须排在 director 之后（momo:show 的监听顺序也要 director 在前）
    os.path.join(GAME_JS, "idle.js"),
    # 送礼回话：跟 idle 同一套机制（临时脚本 + playNodes），排在 director 之后即可
    os.path.join(GAME_JS, "gift-talk.js"),
    # 和墨墨说话（2026-10-20）：主画面右下角入口 + 对话面板。
    # 排在 idle 之后 —— 兜底台词要调 MomoIdle.pick，那个导出在 idle 里。
    os.path.join(GAME_JS, "chat.js"),
    # 语料库（2026-10-20）：听 chat.js 派发的 momo:chatlog，把玩家/墨墨的话分开
    # 沉淀成可检索、可 EN/JA 对照的私人语料。排在 chat.js 之后（事件名对齐即可）。
    os.path.join(GAME_JS, "corpus.js"),
    # 字符海（2026-10-20）：她学过的字在画面里落成潮水/瀑布，情绪改的是海面。
    # 它只听事件（momo:chatline / momo:store / momo:show），排哪都行，放最后不挡别人。
    os.path.join(GAME_JS, "wordsea.js"),
    # 换装回话：同款机制（momo:wear 事件 → pending → 回主画面演）
    os.path.join(GAME_JS, "wardrobe-talk.js"),
    # 前言「走神背单词」演出：momo:daze 节点触发，演完广播 momo:daze_end 续播
    os.path.join(GAME_JS, "prologue-daze.js"),
    # 剧情回放读存档里的 story.log；title.js 接管开屏的新档/继续并要跳屏（用 MomoUI）
    os.path.join(GAME_JS, "replay.js"),
    os.path.join(GAME_JS, "title.js"),
    os.path.join(GAME_JS, "save.js"),
    os.path.join(GAME_JS, "scene.js"),
    os.path.join(GAME_JS, "map.js"),
    os.path.join(GAME_JS, "srs.js"),
    os.path.join(GAME_JS, "quiz.js"),
    # daily 管「按天发生」的一切：日切 / 进游戏结算 / 时段在线奖励 / 物资日耗 / 死亡重开。
    # 必须排在 learn 之前 —— learn 在加载时就要读 MomoDaily.GIVE 取学习产出的数值。
    os.path.join(GAME_JS, "daily.js"),
    # 地点小游戏：要读存档（STORE）、场景图（MomoScene）与每日配额（MomoDaily），
    # 所以排在 daily 之后；它自己只在小游戏屏里跑，不参与主画面的演出。
    os.path.join(GAME_JS, "minigame.js"),
    # 主线章节事件（party.js）：接管 director 的群像剧本（NPC 立绘/姓名条），
    # 在主画面上叠桌视图跑茶会状态机；必须排在 director 之后，learn 之前。
    os.path.join(GAME_JS, "party.js"),
    # 临时 NPC 摆位修改器（只在 ?edit=1 时初始化，正式玩家看不到）
    os.path.join(GAME_JS, "npc-editor.js"),
    # 剧情通道（story-hub.js）：开屏第四卡的章节阁（八灯路线图 + 已通重看 + 门槛提示），
    # 需要 MomoParty.replay / MomoUI，排在 party 之后即可。
    os.path.join(GAME_JS, "story-hub.js"),
    # 茶会狼人杀 · AI 夜（tea-ai.js）：LLM 驱动的独立对局，人物/规则读
    # tea_personas.json，卡面图读 tea_cards.json。接在 party 之后、learn 之前。
    os.path.join(GAME_JS, "tea-ai.js"),
    os.path.join(GAME_JS, "learn.js"),
]
# 内容数据全部内联成 window.MOMO_DATA
CONTENT_DIR = os.path.join(ROOT, "game", "content")
CONTENT_JSON = {
    "words_en": "words_en.json",
    "words_ja": "words_ja.json",
    "grammar_en": "grammar_en.json",
    "grammar_ja": "grammar_ja.json",
    "lessons": "lessons.json",
    "minigames": "minigames.json",
    "dialogues": "dialogues.json",
    "wardrobe": "wardrobe.json",
    # 生成物：_tools/build_expr_map.py 扫素材得出「套装 → 各表情图」
    "expressions": "expressions.json",
    # Q 版墨墨（学习面板卡片右侧的陪读小人）的积极/消极表情池
    "qmomo": "qmomo.json",
    "cg": "cg.json",
    "items": "items.json",
    # 商城六张卡（shop.js 消费）：左列补给真消费，右列导览跳转
    "shop": "shop.json",
    # 兑换码（redeem.js）：商城右下角入口，码表在这里加
    "redeem": "redeem.json",
    "map": "map.json",
    "scenes": "scenes.json",
    # 主线章节表（心之桥八灯）与 S1C1 茶会对局数据（party.js 消费）
    "chapters": "chapters.json",
    "party_月见茶会": "party_月见茶会.json",
    # 茶会狼人杀 · AI 夜：人物/关系/规则（作者可直接改）与卡面图映射（没有图就用内置 SVG）
    "tea_personas": "tea_personas.json",
    "tea_cards": "tea_cards.json",
}

OUTDIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUTDIR, "index.html")
ASSETS_DIR = os.path.join(OUTDIR, "assets")
ASSET_URL_PREFIX = "assets/"      # 产物里图片引用的前缀（相对 index.html）

# 页面图标不转 webp：favicon 各家浏览器、以及 iOS 的 apple-touch-icon
# **只保证认 PNG**，转成 webp 会直接掉图标（页面上不报错，只是标签页/主屏没图标）。
KEEP_PNG = {"墨墨-图标.png", "墨墨-图标-180.png", "墨墨-图标-192.png", "墨墨-图标-maskable.png"}

# PNG → webp 是整个构建唯一的大头（实测每张约 1.4 秒，几十张就是一分多钟）。
# 但源图基本不变，所以按下表把「上次编码出来的产物名 + 字节数」记在磁盘上：
# 键 = 源路径 + mtime + 大小 + 质量。源图没动、产物也还在 → 整轮编码直接跳过。
# 缓存文件放在 _tools 下（不进 dist、不进上传包），删掉只会让下次构建慢一轮。
ENC_CACHE_FILE = os.path.join(ROOT, "_tools", ".asset_cache.json")
ENC = {}


def enc_key(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return "%s|%d|%d|%d" % (path, st.st_mtime_ns, st.st_size, WEBP_QUALITY)

ZIP_NAME = "墨墨上线包.zip"        # --zip 的产物，放在仓库根（不能放进 dist，否则会被下次拖拽带上）
SPLIT = True                      # True=拆分出图；main() 里按 --single 改
ZIP = False                       # True=额外打上传包；main() 里按 --zip 改
OUT_NAMES = {}                    # 输出名 → 源路径，用来防撞名
PRODUCED = set()                  # to_asset 已经产出过的引用，见 _is_produced()
PHASE = 0                         # 当前在处理的素材属于哪一类（越小越先下载），见 PHASE_OF
RANK = {}                         # 产物引用 → 下载优先级（喂给首屏搬运的清单）

# 首屏搬运的下载顺序。这份清单是「全下完才放行」的，所以顺序直接决定两件事：
#   1) 玩家等多久才能进游戏；
#   2) 万一中途断了（网差 / 手机存储配额不够），已经到手的是不是最有用的那一批。
# 界面本身（CSS/HTML/JS 引用的按钮、属性条、底图、字体）合计才 4.7MB，扫一遍几秒钟；
# 真正的体积大头是换装用的表情立绘（465 张 / 76.5MB），而它只在换装时才用得到 ——
# 排最后，前面的都到手了，随便断在哪一步，日常要用的东西都齐了。
PHASE_OF = {
    "scenes.json": 1,       # 场景底图：换个房间就要用
    "map.json": 1,          # 地图
    "items.json": 2,        # 道具图
    "wardrobe.json": 3,     # 套装立绘
    "cg.json": 4,           # CG 只在鉴赏页
    "qmomo.json": 4,
    "expressions.json": 5,  # 465 张 / 76.5MB：换装表情，最后
    # 茶会 NPC 立绘（7 角色 × 8 表情）：只在主线章节用，跟换装表情一起排最后
    "party_月见茶会.json": 5,
    "chapters.json": 2,     # 章节表本身没有图，只为对齐类别
}

WEBP_QUALITY = 82
# 会被当成「产物素材」处理的文件类型：图片 + 字体。
# 字体不做任何转码（woff2 已经压好了），只走同一套「内容哈希 + 复制 + 重写引用」。
IMG_EXT = (".png", ".webp", ".jpg", ".jpeg", ".gif", ".woff2", ".woff", ".ttf", ".otf")
_EXT_ALT = r"png|webp|jpe?g|gif|woff2?|ttf|otf"
# 文件名里出现这些字符会把 URL 弄坏（# 当锚点、? 当查询、% 要转义），换成下划线
_re_url_bad = re.compile(r"[#?%\s]")

_re_url = re.compile(r"""url\(\s*(['"]?)(.*?)\1\s*\)""")
_re_ext = re.compile(r"\.(%s)$" % _EXT_ALT, re.I)


def build_index():
    """按优先级建立 basename → 绝对路径 的索引"""
    idx = {}
    for root in LIBS:
        if not os.path.isdir(root):
            print("  [警告] 素材根目录不存在: %s" % root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            # verify/ 是 PSD 比对截图，不进产物
            dirnames[:] = [d for d in dirnames if d != "verify"]
            for fn in filenames:
                if fn.lower().endswith(IMG_EXT):
                    idx.setdefault(fn, os.path.join(dirpath, fn))
    return idx


def asset_out_name(path, digest):
    """源文件名 → assets/ 下的输出名：原名 + 内容哈希（如 玄关-早晨.a3f7b2c1.webp）。
    PNG 会转 webp，所以扩展名跟着换 —— 除了页面图标（见 KEEP_PNG）。

    为什么必须带内容哈希：这套产物是「一个固定链接 + 后台随时更新」的用法，
    托管方为了回访快通常会给图片设长缓存。而缓存是按 **URL** 认的 —— 如果我们
    改了同名文件的图画（文件名没变），URL 也就没变，回访用户的浏览器会一直拿旧缓存，
    变成「改了用户也看不到」。带上内容哈希之后：改了图 → 哈希变 → URL 变 →
    自动绕过旧缓存；没改的图 URL 不变 → 继续吃缓存。两头都对。"""
    base = os.path.basename(path)
    stem, ext = os.path.splitext(base)
    if ext.lower() == ".png" and base not in KEEP_PNG:
        ext = ".webp"
    name = "%s.%s%s" % (_re_url_bad.sub("_", stem), digest, ext)
    # 同一份内容可能被两个源路径命中（内容一样 → 哈希一样 → 名字一样），那时直接复用
    if name in OUT_NAMES and OUT_NAMES[name] != path:
        stem, ext = os.path.splitext(name)
        i = 2
        while "%s-%d%s" % (stem, i, ext) in OUT_NAMES:
            i += 1
        name = "%s-%d%s" % (stem, i, ext)
    OUT_NAMES[name] = path
    return name


def to_asset(path, cache, report):
    """图片 → 产物里可用的引用，带缓存；顺手记下它是哪一类（决定首屏下载顺序）。
       拆分模式给 assets/xxx.webp 相对路径；单文件模式给 base64 data URI。
       PNG 一律转 webp（质量 82），已经是 webp / jpg / gif 的原样带过来。

    为什么要包一层而不是直接在 _to_asset 里记：那个函数有好几个 return，
    漏一个就会让某类素材拿不到优先级、被默认排到最后 —— 包一层就只有一个出口。"""
    ref = _to_asset(path, cache, report)
    if ref and SPLIT:
        RANK.setdefault(ref, PHASE)      # 同一张图被多处引用时，按最早那个类别算
    return ref


def _to_asset(path, cache, report):
    if path in cache:
        return cache[path]
    name = None
    wrote = 0
    try:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".png" and os.path.basename(path) not in KEEP_PNG:
            key = enc_key(path)
            hit = ENC.get(key) if key else None
            # 源图没动过 + 上次的产物还在 → 跳过编码（这儿是唯一费时的地方）
            if SPLIT and hit and os.path.exists(os.path.join(ASSETS_DIR, hit["n"])):
                name, wrote = hit["n"], hit["b"]
                report["cached"] += 1
                raw = None
            else:
                im = Image.open(path)
                alpha = (
                    im.mode in ("RGBA", "LA")
                    or (im.mode == "P" and "transparency" in im.info)
                )
                buf = io.BytesIO()
                if alpha:
                    im.convert("RGBA").save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
                else:
                    im.convert("RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
                raw = buf.getvalue()
                name = asset_out_name(path, hashlib.md5(raw).hexdigest()[:8])
                if key:
                    ENC[key] = {"n": name, "b": len(raw)}
        else:
            with open(path, "rb") as f:
                raw = f.read()

        if SPLIT:
            if name is None:
                name = asset_out_name(path, hashlib.md5(raw).hexdigest()[:8])
            dst = os.path.join(ASSETS_DIR, name)
            if raw is None:
                pass                       # 命中缓存：产物上次就写好了
            elif os.path.exists(dst):
                report["reused"] += 1      # 同名必然同内容 —— 上次构建留下的直接用
            else:
                with open(dst, "wb") as f:
                    f.write(raw)
            ref = ASSET_URL_PREFIX + name
            if not wrote:
                wrote = len(raw)
        else:
            ref = "data:image/webp;base64," + base64.b64encode(raw).decode("ascii")
            wrote = len(raw)
    except Exception as e:  # 单张失败不应中断整个构建
        report["failed"].append("%s (%s)" % (os.path.basename(path), e))
        return None
    report["ok"] += 1
    report["before"] += os.path.getsize(path)
    report["after"] += wrote
    cache[path] = ref
    PRODUCED.add(ref)
    return ref


def _is_produced(raw):
    """这个字符串是不是构建自己刚写出来的引用，而不是源里的图片路径。
       一次 resolve_and_replace 里要跑两遍替换，而拆分模式下产出的 assets/xxx.webp
       和源里的相对路径长得一样 —— 不加这道闸，第二遍会把产物路径当成「找不到素材」，
       于是报告里冒出一大串假的缺图警告，真丢图反而被噪声埋掉。"""
    return raw.startswith("data:") or raw in PRODUCED


def resolve_and_replace(text, idx, cache, report, pathmap, is_html=False):
    """把 text 里所有图片引用换成产物引用（拆分模式=相对路径 / 单文件模式=data URI）"""

    def sub_url(m):
        quote, raw = m.group(1), m.group(2)
        if _is_produced(raw):
            return m.group(0)
        base = os.path.basename(raw)
        if not _re_ext.search(base) or base not in idx:
            if _re_ext.search(base):
                report["missing"].add(raw)
                report["refs"][raw] = report["refs"].get(raw, 0) + 1
            return m.group(0)
        uri = to_asset(idx[base], cache, report)
        if uri is None:
            return m.group(0)
        pathmap.setdefault(uri, raw)
        report["refs"][raw] = report["refs"].get(raw, 0) + 1
        return "url(%s%s%s)" % (quote, uri, quote)

    text = _re_url.sub(sub_url, text)

    if is_html:
        def sub_variant(m):
            raw = m.group(1)
            if _is_produced(raw):
                return m.group(0)
            base = os.path.basename(raw)
            if base not in idx:
                report["missing"].add(raw)
                return m.group(0)
            uri = to_asset(idx[base], cache, report)
            if uri is None:
                return m.group(0)
            pathmap.setdefault(uri, raw)
            report["refs"][raw] = report["refs"].get(raw, 0) + 1
            return 'data-variant="%s"' % uri

        text = re.sub(r'data-variant="([^"]+)"', sub_variant, text)

    # JS 里的图片路径字符串字面量
    def sub_literal(m):
        quote, raw = m.group(1), m.group(2)
        if _is_produced(raw):
            return m.group(0)
        base = os.path.basename(raw)
        if base not in idx:
            report["missing"].add(raw)
            return m.group(0)
        uri = to_asset(idx[base], cache, report)
        if uri is None:
            return m.group(0)
        pathmap.setdefault(uri, raw)
        report["refs"][raw] = report["refs"].get(raw, 0) + 1
        return '%s%s%s' % (quote, uri, quote)

    text = re.sub(r"""(['"])((?:\.\./|\./|[^'"/\s]+/)[^'"]*?\.(?:%s))\1""" % _EXT_ALT,
                  sub_literal, text)
    return text


def collect_images(obj, out=None):
    """递归收集 JSON 里所有像图片文件名的字符串"""
    if out is None:
        out = set()
    if isinstance(obj, dict):
        for v in obj.values():
            collect_images(v, out)
    elif isinstance(obj, list):
        for v in obj:
            collect_images(v, out)
    elif isinstance(obj, str):
        b = os.path.basename(obj)
        if _re_ext.search(b):
            out.add(b)
    return out


HEADERS_TXT = """# 缓存策略。Cloudflare Pages / Netlify 认这个文件；其他平台（GitHub Pages / COS）会忽略它，
# 那些平台要按各自的办法设缓存头（COS 是给 assets/ 前缀写 Cache-Control 元数据）。

# 图片都带内容哈希：改了图 → 文件名变 → URL 变 → 浏览器自动拿新的。
# 所以这里敢设一年强缓存，回访用户不再重复下载这几百张图。
/assets/*
  Cache-Control: public, max-age=31536000, immutable

# 声音（BGM / 音效 / 语音）跟图一样是内容哈希命名的：URL 变则内容变。
# 不设这条的话每次开屏都要把这些音频回源校验一遍，手机上白白多等一会儿。
/audio/*
  Cache-Control: public, max-age=31536000, immutable

# index.html 内联着「原文件名 → 带哈希的图 URL」这张映射表。
# 它要是也被缓存住，用户就拿不到新图的新 URL，等于白改 —— 必须每次回源校验。
/index.html
  Cache-Control: no-cache, must-revalidate

# Service Worker 更不能被缓存住 —— 它的更新是靠浏览器重新抓这个文件比对字节
# 来发现的，缓存住了新版本就永远装不上。
/sw.js
  Cache-Control: no-cache, must-revalidate
"""


def check_cache_const():
    """核对 sw.js 与 preload.js 里的 CACHE 常量是否一致。

    两边写的是同一个缓存名：SW 从它里面取图给页面，preload.js 往它里面搬图。
    一旦写岔，症状是「进度条每次都从 0 开始走完、图却还是要现下」——
    不报错、不白屏，就是永远不生效，极难查。所以构建时直接卡住。"""
    pat = re.compile(r'\bCACHE\s*=\s*"([^"]+)"')
    try:
        a = pat.search(open(SRC_SW, encoding="utf-8").read())
        b = pat.search(open(os.path.join(GAME_JS, "preload.js"), encoding="utf-8").read())
    except OSError as e:
        return "读不到 %s" % e
    if not a or not b:
        return "sw.js 或 preload.js 里找不到 CACHE = \"...\" 声明"
    if a.group(1) != b.group(1):
        return "缓存名不一致：sw.js=%r  preload.js=%r" % (a.group(1), b.group(1))
    return None


def write_headers():
    """写 dist/_headers（见 HEADERS_TXT 里的说明）。"""
    path = os.path.join(OUTDIR, "_headers")
    with open(path, "w", encoding="utf-8") as f:
        f.write(HEADERS_TXT)
    return path


ZIP_ROOT = "momo"   # 上传包里的第一层文件夹（TapTap 要求：有且仅有一个、只用英文数字）


def make_zip():
    """打一个可以直接拖去静态托管的上传包。

    必须用 zipfile，不能用命令行的 zip：macOS 自带的 zip 不给条目打 UTF-8 标记
    （实测 0/398），385 个中文文件名在服务端解压出来就是乱码 → 所有图片 404、
    页面能开但整屏空白。这里顺手自检一遍，别让这种包悄悄漏出去。

    条目统一套一层 ZIP_ROOT：TapTap 的 H5 包要求「解压后第一级只有一个英文名文件夹、
    打开它就是全部游戏文件、里面有 index.html」，index.html 直接躺在根目录会被判
    「包体解析错误」。静态托管那边多一层文件夹也无害。"""
    out = os.path.join(ROOT, ZIP_NAME)
    if os.path.exists(out):
        os.remove(out)
    rels = ["index.html"]
    if os.path.exists(os.path.join(OUTDIR, "_headers")):
        rels.append("_headers")      # Cloudflare Pages 的缓存策略就在这个文件里，漏了它就白设
    if os.path.exists(os.path.join(OUTDIR, "manifest.webmanifest")):
        rels.append("manifest.webmanifest")   # 漏了它 → 手机加主屏后没有独立模式（浏览器大条又回来了）
    if os.path.exists(os.path.join(OUTDIR, "sw.js")):
        rels.append("sw.js")                  # 漏了它 → 没有离线兜底，断网就是浏览器报错页
    rels += ["assets/" + n for n in sorted(os.listdir(ASSETS_DIR)) if not n.startswith(".")]
    audio_dir = os.path.join(OUTDIR, "audio")
    if os.path.isdir(audio_dir):                  # 漏了它 → 上传包是哑巴游戏
        rels += ["audio/" + n for n in sorted(os.listdir(audio_dir)) if not n.startswith(".")]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in rels:
            z.write(os.path.join(OUTDIR, rel), ZIP_ROOT + "/" + rel)
    info = zipfile.ZipFile(out).infolist()
    cn = [i.filename for i in info if any(ord(c) > 127 for c in i.filename)]
    bad = [f for f in cn
           if not os.path.exists(os.path.join(OUTDIR, f[len(ZIP_ROOT) + 1:]))]
    print("   上传包: %s   %.1f MB   %d 个文件" % (out, os.path.getsize(out) / 1048576, len(rels)))
    print("   自检: 中文名 %d 个 / 打了 UTF-8 标记 %d 个 / 名字对不上真文件 %d 个%s"
          % (len(cn), sum(1 for i in info if i.flag_bits & 0x800), len(bad),
             "" if not bad else "   ← 有问题，别上传！"))


def main():
    global SPLIT, ZIP, ENC
    SPLIT = "--single" not in sys.argv
    ZIP = "--zip" in sys.argv

    if not os.path.isdir(UI):
        print("找不到 UI还原 目录: %s" % UI)
        return 1

    bad = check_cache_const()
    if bad:
        print("[错误] Service Worker 与首屏搬运模块的缓存名对不上：%s" % bad)
        return 1

    # 读上次留下的编码缓存；坏了就当空表（最坏结果是这一轮慢一点，不会出错图）
    try:
        with open(ENC_CACHE_FILE, encoding="utf-8") as f:
            ENC = json.load(f)
    except Exception:
        ENC = {}

    print("== 出图方式: %s =="
          % ("拆分（index.html + assets/，发站用）" if SPLIT
             else "单文件内联（一个文件，发人用）"))
    if SPLIT:
        # **不整目录清空**：产物名带内容哈希，没变的图名字也一样，重写只是白花时间。
        # 改成「同名已存在就跳过」（见 emit）+ 收尾回收本次没用到的旧文件（见下面的 gc），
        # 仍然满足原来那条要求 —— 源里删掉的图不会在产物里留着。
        os.makedirs(ASSETS_DIR, exist_ok=True)

    print("== 建立素材索引 ==")
    idx = build_index()
    print("   可用图片 %d 个" % len(idx))

    report = {
        "ok": 0, "before": 0, "after": 0, "reused": 0, "cached": 0,
        "missing": set(), "failed": [], "refs": {},
    }
    cache, pathmap = {}, {}

    global PHASE
    PHASE = 0                        # CSS / JS / HTML = 界面本身，最先下
    print("== 处理 CSS ==")
    css_chunks, used_assets = [], set()
    for p in SRC_CSS:
        text = open(p, encoding="utf-8").read()
        used_assets.update(re.findall(r"""url\(\s*['"]([^'"]+)['"]\s*\)""", text))
        css_chunks.append("/* ===== %s ===== */\n%s" % (os.path.basename(p), text))
    css_all = resolve_and_replace("\n".join(css_chunks), idx, cache, report, pathmap)

    print("== 处理 JS ==")
    js_chunks = []
    for p in SRC_JS:
        if not os.path.exists(p):
            print("   [跳过] 不存在: %s" % p)
            continue
        js_chunks.append("/* ===== %s ===== */\n%s"
                         % (os.path.basename(p), open(p, encoding="utf-8").read()))
    js_all = resolve_and_replace("\n".join(js_chunks), idx, cache, report, pathmap)

    # ASSET_URI：原文件名 -> 产物引用。换装、CG 鉴赏、场景出图都要按名字动态换图，
    # 单文件模式下文件名在 URL 里已经消失、拆分模式下也统一走这张表，两边共用一套。
    asset_uri = {}
    for uri, p in pathmap.items():
        asset_uri.setdefault(os.path.basename(p), uri)

    print("== 处理内容数据 ==")
    data = {}
    for name, fn in CONTENT_JSON.items():
        PHASE = PHASE_OF.get(fn, 2)   # 每类素材自己的下载优先级，见 PHASE_OF
        fp = os.path.join(CONTENT_DIR, fn)
        if not os.path.exists(fp):
            print("   [跳过] %s 不存在" % fn)
            continue
        obj = json.load(open(fp, encoding="utf-8"))
        data[name] = obj
        n = 0
        for img in sorted(collect_images(obj)):
            if img in asset_uri:
                continue
            if img not in idx:
                report["missing"].add(img)
                continue
            uri = to_asset(idx[img], cache, report)
            if uri:
                asset_uri[img] = uri
                n += 1
        print("   %-16s 新增%s %2d 张图" % (fn, "外链" if SPLIT else "内联", n))

    print("== 处理 HTML ==")
    html = open(SRC_HTML, encoding="utf-8").read()
    # 去掉开发用的编辑器入口与提示
    html = re.sub(r'<button id="edit-toggle".*?</button>', "", html, flags=re.S)
    html = re.sub(r'<span class="hint">.*?</span>', "", html, flags=re.S)
    # 开发导航栏也不进产物 —— 玩家不该看到那排界面直达按钮。
    # 本地调试就带 ?dev（ui.js 会把它显示回来），源码直开也照样有。
    html = html.replace('<nav id="nav">', '<nav id="nav" hidden>', 1)
    # 去掉源码里的外链 css（稍后内联）。
    # 注意只删 rel="stylesheet" —— 不加限定会把 <link rel="icon"> 也一起干掉，
    # 图标就静默丢了（页面上看不出错，只是标签页没图标）。
    html = re.sub(r'\s*<link[^>]*rel="stylesheet"[^>]*>\s*', "\n", html)
    html = re.sub(r'\s*<script src="[^"]*"></script>\s*', "\n", html)
    html = resolve_and_replace(html, idx, cache, report, pathmap, is_html=True)

    # ---- 先把「只在清单里出现」的图标也产出来 ----
    # 192 与 maskable 这两张图标页面 HTML 从不引用它们（只在 manifest 里），所以
    # 它们不会出现在 pathmap 里 —— 必须自己拿素材索引 to_asset 一遍，否则会
    # 「图标文件明明在素材库里，却报缺图标」，清单里只剩一张 512。
    # 而且必须赶在下面算资产清单**之前**：首屏搬运要连图标一起下。
    icons = []
    if SPLIT:
        PHASE = 0                    # 回到「界面」一类（图标也是界面的一部分）
        uri_of = {}
        for uri, raw in pathmap.items():
            uri_of.setdefault(os.path.basename(raw), uri)
        for base, size, purpose in (("墨墨-图标-192.png", "192x192", "any"),
                                    ("墨墨-图标.png", "512x512", "any"),
                                    ("墨墨-图标-maskable.png", "512x512", "maskable")):
            u = uri_of.get(base)
            if not u and base in idx:
                u = to_asset(idx[base], cache, report)
            if u:
                icons.append({"src": u, "sizes": size, "type": "image/png", "purpose": purpose})
            else:
                print("   [提示] manifest 缺图标 %s（源文件不在素材库里？）" % base)

    # ---- 音频：game/audio/ → dist/audio/（内容哈希），并出 MOMO_AUDIO 映射 ----
    # 音频永远走独立文件、不内联（方案 §3.4：内联的音频无法流式播放，且会把
    # 单文件推爆体积上限）。名字规则与图片一致：短名 → audio/<短名>.<哈希>.mp3，
    # 改一个音效只有它的 URL 变，SW/浏览器的长缓存自动失效。
    # 单文件模式不出音频（MOMO_AUDIO 为空表 → audio.js 全部 no-op，游戏照跑）。
    audio_js = ""
    produced_audio = {}
    AUDIO_SRC = os.path.join(ROOT, "game", "audio")
    if SPLIT and os.path.isdir(AUDIO_SRC):
        out_audio = os.path.join(OUTDIR, "audio")
        os.makedirs(out_audio, exist_ok=True)
        momo_audio = {}
        for fn in sorted(os.listdir(AUDIO_SRC)):
            if not fn.lower().endswith((".mp3", ".ogg", ".wav", ".m4a")):
                continue
            with open(os.path.join(AUDIO_SRC, fn), "rb") as f:
                raw = f.read()
            stem, ext = os.path.splitext(fn)
            out_name = "%s.%s%s" % (_re_url_bad.sub("_", stem),
                                    hashlib.md5(raw).hexdigest()[:8], ext)
            with open(os.path.join(out_audio, out_name), "wb") as f:
                f.write(raw)
            ref = "audio/" + out_name
            momo_audio[stem] = ref
            produced_audio[ref] = len(raw)
        # 回收陈旧音频（改了内容 → 哈希变 → 旧文件没人引用了）
        have_a = set(n for n in os.listdir(out_audio) if not n.startswith("."))
        keep_a = set(r[len("audio/"):] for r in produced_audio)
        for n in sorted(have_a - keep_a):
            os.remove(os.path.join(out_audio, n))
        # 音频也进首屏搬运清单（RANK=0 界面级，跟按钮底图一起最早下）：
        # 不进清单的话，断网打开就是哑巴游戏 —— SW 只拦 /assets/ 与 /audio/，
        # 而 preload 只搬清单里有的东西。
        for ref in produced_audio:
            PRODUCED.add(ref)
            RANK[ref] = 0
        if momo_audio:
            audio_js = ("<script>window.MOMO_AUDIO=%s;</script>"
                        % json.dumps(momo_audio, ensure_ascii=False, separators=(",", ":")))
            print("   音频: %d 个文件 %.2f MB（bgm/sfx/vo）"
                  % (len(momo_audio), sum(produced_audio.values()) / 1048576))

    # ---- 资产清单：首屏一次性搬运的下载列表（game/js/preload.js 用）----
    # 到这一步 PRODUCED 已经齐了（CSS / JS / 内容数据 / HTML / 上面的图标都过完了），
    # 所以这里就是产物里 793 张图的完整集合。带字节数是为了让进度条按**体积**走 ——
    # 按张数走的话，一张 300KB 的立绘和一张 3KB 的图标推一格，进度看着是骗人的。
    # 按「类别优先级 + 路径」排：搬运是**顺序**消费这个清单的，所以序列即下载顺序。
    # preload.js 还会在内部再排一次（同一套 RANK 规则），这里排好是为了让产物自解释。
    assets_js = ""
    if SPLIT:
        items = sorted(PRODUCED, key=lambda r: (RANK.get(r, 6), r))
        pairs, total_bytes = [], 0
        for ref in items:
            try:
                n = os.path.getsize(os.path.join(OUTDIR, ref))
            except OSError:
                continue
            pairs.append([ref, n])
            total_bytes += n
        by_phase = {}
        for ref, n in pairs:
            by_phase[RANK.get(ref, 6)] = by_phase.get(RANK.get(ref, 6), 0) + n
        print("   下载顺序: " + " → ".join(
            "%s %.1fMB" % ({0: "界面", 1: "场景", 2: "道具", 3: "套装",
                            4: "CG/Q版", 5: "表情", 6: "其他"}.get(k, "?"), v / 1048576)
            for k, v in sorted(by_phase.items())))
        assets_js = ("<script>window.MOMO_ASSETS=%s;</script>"
                     % json.dumps(pairs, ensure_ascii=False, separators=(",", ":")))

    # 组装：ASSET_PATH_OF → 资产清单 → MOMO_DATA/ASSET_URI → 内联样式 → 页面 → 内联脚本
    head = '<meta name="viewport" content="width=device-width,initial-scale=1">'
    pathmap_js = ("<script>window.ASSET_PATH_OF=%s;</script>"
                  % json.dumps(pathmap, ensure_ascii=False, separators=(",", ":")))
    data_js = ("<script>window.MOMO_DATA=%s;\nwindow.ASSET_URI=%s;</script>"
               % (json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                  json.dumps(asset_uri, ensure_ascii=False, separators=(",", ":"))))
    html = html.replace("</head>",
                        head + "\n<style>\n" + css_all + "\n</style>\n</head>", 1)
    html = html.replace("</body>",
                        pathmap_js + "\n" + audio_js + "\n" + assets_js + "\n" + data_js +
                        "\n<script>\n" + js_all + "\n</script>\n</body>", 1)

    os.makedirs(OUTDIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)

    # ---- Web App Manifest：从主屏图标启动时以独立模式运行（没有浏览器地址栏）----
    # 里面的图标路径必须是**带内容哈希的产物路径**，所以这份文件由构建生成，不能写死在源里。
    if SPLIT and icons is not None:
        manifest = {
            "name": "墨墨的洋馆",
            "short_name": "墨墨的洋馆",
            "start_url": ".",
            "scope": ".",
            "display": "standalone",          # 去地址栏、留状态栏（用户选的档）
            "orientation": "landscape",       # 安卓上从主屏启动会直接横屏
            "background_color": "#150e0a",
            "theme_color": "#2a1c14",
            "icons": icons,
        }
        with open(os.path.join(OUTDIR, "manifest.webmanifest"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("   清单: manifest.webmanifest（独立模式，%d 个图标）" % len(icons))

    # ---- Service Worker：原样拷到产物根目录 ----
    # 它必须是一个真文件（不能被内联、不能带内容哈希）：浏览器靠重新抓这个地址
    # 比对字节来判断「SW 有没有更新」。
    if SPLIT:
        shutil.copyfile(SRC_SW, os.path.join(OUTDIR, "sw.js"))
        print("   离线: sw.js + 首屏搬运清单 %d 项 %.1f MB（首次进游戏一次性搬到本地）"
              % (len(pairs), total_bytes / 1048576))

    # ---- 回收 assets 里本次没产出的文件 ----
    # 源图被删掉或改名之后，老产物不能一直躺在 dist 里（也就替换掉了原来「整目录重建」的语义）
    stale = []
    if SPLIT:
        have = set(n for n in os.listdir(ASSETS_DIR) if not n.startswith("."))
        keep = set(r[len(ASSET_URL_PREFIX):] for r in PRODUCED
                   if r.startswith(ASSET_URL_PREFIX))
        stale = sorted(have - keep)
        for n in stale:
            os.remove(os.path.join(ASSETS_DIR, n))

    # 存回编码缓存，给下一次构建省掉 PNG 重压的那一分多钟
    try:
        with open(ENC_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(ENC, f, ensure_ascii=False, separators=(",", ":"))
    except Exception as e:
        print("   [提示] 编码缓存没写成功（不影响产物）：%s" % e)

    # ---- 报告 ----
    size = os.path.getsize(OUT)
    print("\n== 完成 ==")
    print("   出图方式: %s"
          % ("拆分（发站用）" if SPLIT else "单文件内联（发人用）"))
    print("   页面: %s   %.2f MB" % (OUT, size / 1048576))
    print("   图片: %d 张（重压 %d / 命中编码缓存 %d / 复用旧产物 %d），原始 %.1f MB → 产出 %.1f MB"
          % (report["ok"], report["ok"] - report["reused"] - report["cached"],
             report["cached"], report["reused"],
             report["before"] / 1048576, report["after"] / 1048576))
    if stale:
        print("   回收陈旧图 %d 张（源里已删/改名）" % len(stale))
    if report["after"]:
        print("   压缩率: %.1f%%" % (report["after"] / report["before"] * 100))
    if SPLIT:
        print("   图片目录: %s" % ASSETS_DIR)
        print("   合计 %.2f MB —— index.html 与 assets/ 少一个都不行" % ((size + report["after"]) / 1048576))
        print("   缓存策略: %s（图一年强缓存 / index.html 每次回源）" % write_headers())
    if ZIP:
        if SPLIT:
            make_zip()
        else:
            print("   注: --zip 只对拆分产物有意义（单文件直接发那个 HTML 就行）")
    elif os.path.isdir(ASSETS_DIR) and not SPLIT:
        print("   注: %s 是上次拆分留下的，单文件模式用不到，可以删" % ASSETS_DIR)
    if report["missing"]:
        print("\n   [缺素材] %d 处引用找不到文件（会显示为缺失）：" % len(report["missing"]))
        for m in sorted(report["missing"]):
            print("     - %s" % m)
    if report["failed"]:
        print("\n   [转换失败] %d 张：" % len(report["failed"]))
        for m in report["failed"]:
            print("     - %s" % m)
    return 0


if __name__ == "__main__":
    sys.exit(main())