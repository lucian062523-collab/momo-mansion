#!/usr/bin/env python3
"""Generate the restored UI system: index.html + css + js from layout2_*.json.

- 1920x1080 absolute-positioned stage, scaled to fit window
- every layer = a div at its PSD place rect; UI组件/asset as background
- PSD text layers -> real CSS text with extracted font/effect params
- clipped layers nest inside their base layer (overflow:hidden)
- interactions: screen navigation, state variants, sliders
"""
import json
import os
import glob
import html
import math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "UI还原", "data")
OUT = os.path.join(ROOT, "UI还原")

SCREEN_ORDER = ["开屏", "主画面", "存:读档界面", "CG界面", "商城界面", "服装",
                "送礼:物品界面", "人物", "回放界面", "设置界面", "音量:阅读模式界面"]

# font PS name -> css font-family stack
FONT_STACK = {
    "FZXBSJW--GB1-0": '"FZXiaoBiaoSong-B05S","方正小标宋简体","FZXBSJW--GB1-0",STSong,serif',
}

# interactions: (screen, layer name, occurrence index) -> behavior
GOTO = {
    ("开屏", "新的开始"): "主画面",
    ("开屏", "继续旅程"): "主画面",     # 2026-10-12 同步：HTML 早改成主画面（进度本来就一直在存），表里还是旧值
    ("开屏", "CG鉴赏"): "CG界面",
    ("开屏", "关于作者"): "人物",
    ("主画面", "设置"): "设置界面",
    ("人物", "跳转商城"): "商城界面",
    ("设置界面", "保存档案"): "存:读档界面",
    ("设置界面", "读取存档"): "存:读档界面",
    ("设置界面", "剧情回放"): "回放界面",
    ("设置界面", "环境设置"): "音量:阅读模式界面",
    ("设置界面", "墨墨状态"): "人物",
    ("设置界面", "返回标题"): "开屏",     # 2026-10-12 修：原来是「主画面」，返回标题应当回开屏
}
# 按键（已点击） 拷贝 pair in 人物 跳转换装-送礼 group -> by occurrence order
GOTO_OCC = [
    ("人物", "按键（已点击） 拷贝", 0, "服装"),
    ("人物", "按键（已点击） 拷贝", 1, "送礼:物品界面"),
]

# state-variant pairs (component name -> alternate component)
# 仅保留画布尺寸完全一致的配对（几何兼容，悬停/点击换图不错位）
VARIANTS = {
    "小条（未点击）.png": "小条（点击）.png",
    "小条（点击）.png": "小条（未点击）.png",
    "按键A.png": "按键B.png",   # 未点击 悬停显示已点击
    "按键B.png": "按键A.png",   # 已点击 悬停显示未点击
    "短小条B.png": "短小条A.png",
}

# sliders in 音量 screen: (slider bar layer name, knob layer name)
SLIDERS = [
    ("滑动条1", "滑动按键3"),
    ("滑动条（米白色）", "滑动按键2"),
    ("滑动条2", "滑动按键1"),
]

# 空白按键文字标签（PSD 无文字层，按界面语义补字）
# (screen, 图层名, occ序号或None=全部, 文字或按occ取字的列表, 样式)
# 样式: c=lt(浅色字,深底)/dk(深色字,浅底)  s=字号  x,y,w,h=标签框相对按键的百分比
from label_config import LABELS  # 1:1 复刻《放文字示例.psd》，配置见 label_config.py


CSS_BLEND = {
    "BlendMode.MULTIPLY": "multiply",
    "BlendMode.SCREEN": "screen",
    "BlendMode.OVERLAY": "overlay",
    "BlendMode.SOFT_LIGHT": "soft-light",
    "BlendMode.LINEAR_DODGE": "plus-lighter",
    "BlendMode.COLOR_BURN": "color-burn",
    "BlendMode.LINEAR_BURN": "multiply",
    "BlendMode.VIVID_LIGHT": "hard-light",
    "BlendMode.NORMAL": None,
}


def esc(s):
    return html.escape(str(s), quote=True)


def css_px(v):
    return "%gpx" % (round(v * 100) / 100.0)


def screen_key(screen):
    return screen.replace(":", "_").replace(" ", "_")


def layer_cls(e):
    return "l%s" % e["id"]


def shadow_css(e):
    """CSS text-shadow / filter strings from extracted effects."""
    shadows = []
    filters = []
    for eff in (e.get("json", {}).get("effects") or []):
        if not eff.get("enabled", True):
            continue
        t = eff.get("type")
        # dedupe legacy vs effects2 duplicates (same params)
        if t in ("DropShadow", "dropShadow"):
            key = "ds"
        elif t in ("OuterGlow", "outerGlow"):
            key = "og"
        else:
            continue
        if key in [k for k, *_ in shadows]:
            continue
        color = eff.get("color", "rgb(0,0,0)")
        # parse rgb() -> rgba with opacity
        r, g, b = [int(x) for x in color[color.index("(") + 1:color.index(")")].split(",")]
        op = eff.get("opacity_pct", 100.0) / 100.0
        blur = eff.get("blur_px", 0)
        if key == "ds":
            # PS 光源角: 90°=光从上方(阴影向下), 120°=光左上(阴影右下)
            # 阴影方向 = 光源角+180 => dx=D·sin(A-90°), dy=D·cos(A-90°)
            ang = math.radians(eff.get("angle_deg", 90) - 90.0)
            dist = eff.get("distance_px", 0)
            dx = dist * math.sin(ang)
            dy = dist * math.cos(ang)
            shadows.append((key, "%gpx %gpx %gpx rgba(%d,%d,%d,%.3g)" % (
                round(dx, 2), round(dy, 2), blur, r, g, b, op)))
            filters.append((key, "drop-shadow(%gpx %gpx %gpx rgba(%d,%d,%d,%.3g))" % (
                round(dx, 2), round(dy, 2), blur, r, g, b, op)))
        else:
            shadows.append((key, "0 0 %gpx rgba(%d,%d,%d,%.3g)" % (blur, r, g, b, op)))
            filters.append((key, "drop-shadow(0 0 %gpx rgba(%d,%d,%d,%.3g))" % (blur, r, g, b, op)))
    return shadows, filters


def text_css(e):
    """CSS declarations for a PSD type layer."""
    jt = e.get("json", {}).get("type") or {}
    decls = []
    runs = jt.get("runs") or []
    if runs:
        r0 = runs[0]
        font = FONT_STACK.get(r0["font"].strip("'"), "serif")
        size = r0["font_size_pt"] * jt.get("scale", 1.0)
        decls.append("font-family:%s" % font)
        decls.append("font-size:%gpx" % (round(size * 100) / 100.0))
        if r0.get("tracking"):
            decls.append("letter-spacing:%gpx" % (round(r0["tracking"] / 1000.0 * size * 100) / 100.0))
        decls.append("color:%s" % r0.get("fill_color", "#fff"))
        if r0.get("fake_bold"):
            decls.append("font-weight:bold")
        if r0.get("fake_italic"):
            decls.append("font-style:italic")
    para = (jt.get("paragraphs") or [{}])[0]
    b = e["bbox"]
    h = max(b["height"], 1)
    decls.append("line-height:%gpx" % (round(h * 100) / 100.0))
    align = para.get("align", "left")
    if align == "center":
        decls.append("text-align:center")
    elif align == "right":
        decls.append("text-align:right")
    shadows, _ = shadow_css(e)
    if shadows:
        decls.append("text-shadow:" + ", ".join(s for _, s in shadows))
    return decls


def css_url(url):
    """Asset URL relative to css/ directory (screens.css lives in UI还原/css/)."""
    if url.startswith("../UI组件/"):
        return "../../UI组件/" + url[len("../UI组件/"):]
    if url.startswith("assets/"):
        return "../" + url
    return url


def place_of(e):
    a = e.get("asset") or {}
    return a.get("place") or e["bbox"]


def gen_screen(d, occurrence):
    """Returns (html_str, css_str) for one screen."""
    screen = d["screen"]
    key = screen_key(screen)
    by = {e["id"]: e for e in d["layers"]}
    css_lines = []
    stage_extra = []   # top=True 的文字标签：stage 顶层绝对定位

    def css_for(e, relative_to=None):
        rules = ["position:absolute"]
        pl = place_of(e)
        left = pl["left"] if relative_to is None else pl["left"] - relative_to["left"]
        top = pl["top"] if relative_to is None else pl["top"] - relative_to["top"]
        rules.append("left:%s" % css_px(left))
        rules.append("top:%s" % css_px(top))
        rules.append("width:%s" % css_px(max(pl["width"], 1)))
        rules.append("height:%s" % css_px(max(pl["height"], 1)))
        a = e.get("asset") or {}
        if a.get("url"):
            rules.append("background-image:url('%s')" % css_url(a["url"]))
            rules.append("background-size:100% 100%")
            rules.append("background-repeat:no-repeat")
        if a.get("flip_h"):
            rules.append("transform:scaleX(-1)")
        if e["opacity"] < 1:
            rules.append("opacity:%g" % e["opacity"])
        bm = CSS_BLEND.get(e["blend_mode"])
        if bm and e["kind"] not in ("group", "type"):
            rules.append("mix-blend-mode:%s" % bm)
        if e["kind"] == "type":
            rules.extend(text_css(e))
        sel = "#scr-%s .%s" % (key, layer_cls(e))
        if e["kind"] == "group":
            css_lines.append("%s{position:absolute;left:0;top:0;width:1920px;height:1080px;pointer-events:none}" % sel)
        else:
            css_lines.append("%s{%s}" % (sel, ";".join(rules)))
        # effects: drop-shadow / outer-glow -> CSS filter (single layers AND groups)
        if e["kind"] != "type":
            _, filters = shadow_css(e)
            if filters:
                if e["kind"] == "group" or (e.get("asset") or {}).get("url"):
                    css_lines.append("%s{--fx:%s}" % (sel, " ".join(f for _, f in filters)))

    def attr_interactive(e):
        """data-* attributes for interactions."""
        attrs = []
        a = e.get("asset") or {}
        comp = a.get("component")
        name = e["name"]
        occ = e.get("_occ", 0)
        var = None
        if comp and comp in VARIANTS:
            var = VARIANTS[comp]
        if var:
            attrs.append('data-variant="%s"' % esc("../UI组件/" + var))
        if (screen, name) in GOTO:
            attrs.append('data-goto="%s"' % esc(GOTO[(screen, name)]))
        for sname, lname, i, target in GOTO_OCC:
            if screen == sname and name == lname and occ == i:
                attrs.append('data-goto="%s"' % esc(target))
        if screen != "开屏" and name == "BACK按钮":
            attrs.append('data-goto="开屏"')   # 用户后加决定：所有 BACK 返回开屏
        # 主画面两条浅色选择条：互斥选中（对话选项）
        if screen == "主画面" and name in ("对话组件-选择条（未选中）", "对话组件-选择条（选中）"):
            attrs.append('data-glow="choice"')
        # 各界面可选中按钮组（互斥发光，data-glow=组名）
        SELECT_RULES = [
            ("存:读档界面", "存档条", "saves"),              # 存档槽位
            ("商城界面", "商城组件-", "shop"),               # 商城条目（前缀匹配）
            ("送礼:物品界面", "小圆圈（点击）", "cats"),        # 分类圆圈
            ("送礼:物品界面", "物品格子", "items"),            # 物品格子
            ("服装", "白框", "cards"),                      # 服装卡片
            ("服装", "分类", "wcats"),                      # 分类签（前缀匹配）
        ]
        for sname, lname, group in SELECT_RULES:
            if screen == sname and (name == lname or name.startswith(lname)):
                attrs.append('data-glow="%s"' % group)
                break
        # 页码数字（1-6）与左右翻页
        PAGES_SCREENS = ("存:读档界面", "CG界面", "送礼:物品界面")
        if screen in PAGES_SCREENS:
            if name in ("1", "2", "3", "4", "5", "6"):
                attrs.append('data-glow="pages"')
            elif name == "左":
                attrs.append('data-page="prev"')
            elif name == "右":
                attrs.append('data-page="next"')
        # 人物属性条：加/减 步进按钮（脉冲反馈）
        if screen == "人物":
            if name == "加":
                attrs.append('data-step="5"')
                attrs.append('data-pulse="1"')
            elif name == "减":
                attrs.append('data-step="-5"')
                attrs.append('data-pulse="1"')
        # sliders
        if screen == "音量:阅读模式界面":
            for bar, knob in SLIDERS:
                if name == knob:
                    attrs.append('data-knob="1"')
                if name == bar:
                    attrs.append('data-bar="1"')
        return attrs

    def build(e, clipped_stack):
        if e.get("skip"):
            return ""
        css_for(e, relative_to=clipped_stack)
        cls = [layer_cls(e), "layer", e["kind"]]
        if e["kind"] == "group":
            cls.append("grp")
        if not e["visible"]:
            cls.append("is-hidden")
        style = ""
        attrs = attr_interactive(e)
        if attrs:
            cls.append("btn")
        if e.get("clip_base"):
            # rendered inside base; handled by caller
            pass
        content = ""
        if e["kind"] == "type":
            content = esc(e.get("json", {}).get("type", {}).get("text", ""))
        # 人物属性条：数值显示（叠加在条右侧数值格）
        if screen == "人物" and e["name"] == "属性_副本":
            content = '<span class="attr-value" data-value="50">50</span>'
        # 按键文字标签（1:1 复刻《放文字示例.psd》，配置见 label_config.py）
        # top=True 的标签提升到 stage 顶层（绝对像素坐标），避免被后画的图层盖住
        if e["kind"] != "type":
            for sname, lname, locc, ltext, lstyle in LABELS:
                if screen == sname and e["name"] == lname and (locc is None or locc == e.get("_occ", 0)):
                    if locc is None and lstyle.get("skip") == e.get("_occ", 0):
                        continue
                    text = ltext[e.get("_occ", 0)] if isinstance(ltext, list) else ltext
                    st = dict(lstyle)
                    if st.get("lh"):
                        nowrap = "line-height:%gpx;white-space:pre-line" % st['lh']
                    else:
                        nowrap = "white-space:nowrap"
                    align = ("justify-content:flex-start;text-align:left" if st.get('al') == 'l'
                             else "justify-content:center;text-align:center")
                    base_css = ["font-size:%gpx" % st.get('s', 28),
                                "color:%s" % st.get('c', '#4c382d'),
                                "letter-spacing:%gpx" % st['ls'] if st.get('ls') else "",
                                align, nowrap]
                    base_css = [c for c in base_css if c]
                    if st.get('top'):
                        # 绝对像素坐标 = 宿主 place 矩形 + 百分比偏移
                        pl = place_of(e)
                        L = pl["left"] + st.get('x', 0) / 100.0 * pl["width"]
                        T = pl["top"] + st.get('y', 0) / 100.0 * pl["height"]
                        W = st.get('w', 100) / 100.0 * pl["width"]
                        H = st.get('h', 100) / 100.0 * pl["height"]
                        css = ["left:%gpx" % L, "top:%gpx" % T,
                               "width:%gpx" % W, "height:%gpx" % H] + base_css
                        stage_extra.append(
                            '<span class="btn-label" data-kind="%s" style="%s">%s</span>' % (
                                st.get('k', 'fixed'), ";".join(css), esc(text)))
                    else:
                        css = ["left:%g%%" % st.get('x', 0), "top:%g%%" % st.get('y', 0),
                               "width:%g%%" % st.get('w', 100), "height:%g%%" % st.get('h', 100)] + base_css
                        content += ('<span class="btn-label" data-kind="%s" style="%s">%s</span>' % (
                            st.get('k', 'fixed'), ";".join(css), esc(text)))
                    continue
        kids = e.get("children") or []
        kid_html = []
        # children in document order; clipped ones attach to their base layer div
        base_divs = {}  # base id -> [clipped divs]
        for cid in kids:
            c = by[cid]
            base_id = c.get("clip_base")
            base_ok = base_id and base_id in kids and not by[base_id].get("skip")
            if c.get("skip"):
                kid_html.append("")  # placeholder keeps index alignment for injection
            elif base_ok:
                # nest into a visible base sibling
                base = by[base_id]
                rel = place_of(base)
                css_for(c, relative_to=rel)
                ccls = [layer_cls(c), "layer", c["kind"], "clip"]
                if not c["visible"]:
                    ccls.append("is-hidden")
                cattributes = attr_interactive(c)
                if cattributes:
                    ccls.append("btn")
                ccontent = ""
                if c["kind"] == "type":
                    ccontent = esc(c.get("json", {}).get("type", {}).get("text", ""))
                base_divs.setdefault(base_id, []).append(
                    '<div class="%s" data-name="%s"%s>%s</div>' % (
                        " ".join(ccls), esc(c["name"]),
                        "".join(" %s" % a for a in cattributes), ccontent))
            else:
                kid_html.append(build(c, None))
        # mark clip bases + inject clipped divs before each base's closing tag
        for bid, divs in base_divs.items():
            pos = next((i for i, cid in enumerate(kids) if cid == bid), None)
            if pos is None:
                continue
            if kid_html[pos]:
                kid_html[pos] = kid_html[pos].replace('class="', 'class="clipbase ', 1)
                kid_html[pos] = kid_html[pos].rsplit("</div>", 1)[0] + "".join(divs) + "</div>"
            else:
                # base was skipped: emit clipped layers standalone (absolute coords)
                kid_html[pos] = "".join(divs)
        return ('<div class="%s" data-name="%s"%s>%s%s</div>' % (
            " ".join(cls), esc(e["name"]), "".join(" %s" % a for a in attrs),
            content, "".join(kid_html)))

    parts = []
    for e in d["layers"]:
        if e["parent"] is None:
            parts.append(build(e, None))
    body = "\n      ".join(parts + stage_extra)
    css = "\n".join(css_lines)
    return body, css


def main():
    occ_counter = {}
    screens_html = []
    all_css = []
    files = {os.path.basename(f)[len("layout2_"):-len(".json")]: f
             for f in glob.glob(os.path.join(DATA, "layout2_*.json"))}
    for screen in SCREEN_ORDER:
        f = files.get(screen)
        if not f:
            continue
        d = json.load(open(f, encoding="utf-8"))
        occ = {}
        for e in d["layers"]:
            occ[e["name"]] = occ.get(e["name"], 0)
            e["_occ"] = occ[e["name"]]
            occ[e["name"]] += 1
        body, css = gen_screen(d, occ)
        screens_html.append(
            '  <section class="screen" id="scr-%s" data-screen="%s">\n'
            '    <div class="stage">\n      %s\n    </div>\n  </section>'
            % (screen_key(screen), esc(screen), body))
        all_css.append("/* ====== %s ====== */\n%s" % (screen, css))

    nav = "\n".join(
        '    <a href="#%s" data-nav="%s">%s</a>' % (screen_key(s), esc(s), esc(s))
        for s in SCREEN_ORDER if s in files)

    import time
    ver = str(int(time.time()))
    index = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<!-- 页面标题是给玩家的（浏览器标签 / 加到主屏 / 分享出来的链接都显示它），
         不是开发用的图层统计 —— 唯一的标题定义在 UI还原/index.html，
         这个生成器只负责复现它，别再写回“UI 1:1 还原 · N 图层”。 -->
<title>墨墨的洋馆</title>
<link rel="icon" type="image/png" sizes="512x512" href="assets/墨墨-图标.png">
<link rel="apple-touch-icon" sizes="180x180" href="assets/墨墨-图标-180.png">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#2a1c14">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="墨墨的洋馆">
<link rel="stylesheet" href="css/common.css?v=%(ver)s">
<link rel="stylesheet" href="css/screens.css?v=%(ver)s">
<link rel="stylesheet" href="css/editor.css?v=%(ver)s">
</head>
<body>
<!-- 首屏「搬运美术资产」层：790 张图约 125MB，第一次进来由 game/js/preload.js
     一次性搬进本地缓存。默认可见 —— 它得在脚本跑起来之前先把屏幕占住。 -->
<div id="boot">
  <div class="boot-inner">
    <p class="boot-title">正 在 搬 运 美 术 资 产</p>
    <div class="boot-bar"><b id="boot-fill"></b></div>
    <p class="boot-num"><span id="boot-num">0 / 0 张</span><em id="boot-pct">0 MB · 0%</em></p>
    <p class="boot-tip">第一次进来要把全部插画存到本地（共 <b id="boot-total">—</b>）。<br>
      存好之后每次打开都是秒开，断网也能玩。</p>
    <p class="boot-err" id="boot-err" hidden></p>
    <div class="boot-acts" hidden id="boot-acts">
      <button class="boot-retry" id="boot-retry" type="button">重 试</button>
      <button class="boot-skip" id="boot-skip" type="button">先 进 去</button>
    </div>
  </div>
</div>
<nav id="nav">
%(nav)s
  <button id="edit-toggle" title="进入/退出 UI 编辑器 (E)">🛠 编辑</button>
  <span class="hint">按 BACK/菜单可跳转 · 点击按钮切换状态 · 音量滑条可拖动 · E=编辑器</span>
</nav>
<div id="screens">
%(screens)s
</div>
<script src="js/ui.js?v=%(ver)s"></script>
<script src="js/editor.js?v=%(ver)s"></script>
</body>
</html>
""" % {"nav": nav, "screens": "\n".join(screens_html), "total": 0, "ver": ver}

    os.makedirs(os.path.join(OUT, "css"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "js"), exist_ok=True)
    with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(index)
    with open(os.path.join(OUT, "css", "screens.css"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(all_css))
    print("index.html + screens.css written")


if __name__ == "__main__":
    main()
