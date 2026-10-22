# -*- coding: utf-8 -*-
"""
墨墨 · 学习面板资产构建

两件事：

  1) CSS 作用域化 —— 从「V3 学习组件集」的组件里抽样式
     这几块面板共用同一套「羊皮纸棕金」kit —— `:root` 令牌、`*{}`、`body{}`、
     `.cell`、`.panel`、`.corner`、`.show-*` 在各文件里同名同形。直接拼接会互相
     覆盖，所以这里按规则解析（含 @media 递归），把每条选择器前缀成
     `.learn-panel[data-learn="xx"]`：
        `body{}`        → 面板自身（组件靠它铺那层深棕羊皮纸底）
        `*{}`           → 面板自身 + 全部后代
        `:root{}`       → 面板自身（19 个设计令牌就地生效、随面板继承下去）
        `.panel{}`      → `.learn-panel[data-learn="xx"] .panel{}`
     于是各块面板各吃各的 Kit，互不串味。顺带把 Google Fonts 取不到的
     Cinzel / Noto Serif SC 换成本地方正小标宋，断网也不掉字。

  2) 面板骨架注入 —— 把 UI还原/learn/panels.html 写进 index.html 的 LEARN 区间
     骨架是**人工维护**的：类名沿用上面的 kit，文字全部留空槽位 data-f，
     由 game/js/learn.js 从词库 / 语法库里填 —— 面板是活的，不是写死的样例。

用法：  python3 _tools/build_learn_assets.py
产出：  UI还原/css/learn.css            （生成物，勿手改）
        UI还原/index.html 的 LEARN 区间  （生成物，勿手改）
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "UI还原")
SRC = os.path.join(ROOT, "_tools", "learn_src")
PANELS = os.path.join(UI, "learn", "panels.html")
OUT_CSS = os.path.join(UI, "css", "learn.css")

# key → (取样式的源组件, 面板名)
#   wc/nb/gr/mk = 「V3 学习组件集」的四块组件（保持原样，不动）
#   sd（背单词）  = 「V5 学习组件集」新增的那一块，日语按课选卡组
#   qz（练习）    = 自建：错题集要有真实错题，就必须先有答题；样式直接吃 wc 那套 kit
# 顺序 = 顶部标签页顺序：两块识记挨着，然后是词表、语法、错题、练习。
PARTS = [
    ("wc", "单词卡片.html", "单词卡片"),
    ("sd", "背单词模式.html", "背单词"),
    ("nb", "记词本.html", "记词本"),
    ("gr", "语法页.html", "语法页"),
    ("mk", "错题集.html", "错题集"),
    ("qz", "单词卡片.html", "练习"),
]

# 项目本地字族（见 common.css 的 .btn-label / .attr-value）
# 组件原本从 Google Fonts 取 Cinzel / EB Garamond / Noto Serif SC，单文件离线打开时
# 取不到、会掉成系统默认衬线，所以三个字体令牌全部换成本地字族。
FONT_EN = '\'Cinzel\', "FZXiaoBiaoSong-B05S", "方正小标宋简体", "Songti SC", serif'
FONT_ZH = '"FZXiaoBiaoSong-B05S", "方正小标宋简体", "Songti SC", "SimSun", serif'
FONT_WORD = ('\'EB Garamond\', \'Cinzel\', "FZXiaoBiaoSong-B05S", '
             '"方正小标宋简体", "Songti SC", serif')
FONT_TOKENS = {"--serif-en": FONT_EN, "--serif-zh": FONT_ZH, "--serif-word": FONT_WORD}

# 这几个 at-rule 的块里还是普通规则，要递归作用域化；其余（@keyframes/@font-face）原样保留
NESTED_AT = ("media", "supports", "layer", "container", "document", "scope")


# ---------------------------------------------------------------- 源码切分

def read_css(fn):
    """只取组件的 <style> —— 面板文字已由 panels.html + learn.js 接管"""
    raw = open(os.path.join(SRC, fn), encoding="utf-8").read()
    return re.search(r"<style[^>]*>(.*?)</style>", raw, re.S).group(1)


# ---------------------------------------------------------------- CSS 解析

def _iter_blocks(css):
    """按顶层扫出 (kind, prelude, body)：kind ∈ raw / block"""
    i, n = 0, len(css)
    while i < n:
        if css.startswith("/*", i):
            j = css.find("*/", i + 2)
            j = n if j < 0 else j + 2
            yield ("raw", css[i:j], None)
            i = j
            continue
        m = re.match(r"\s+", css[i:])
        if m:
            yield ("raw", m.group(0), None)
            i += m.end()
            continue

        # 扫 prelude，直到深度 0 处的 '{' 或 ';'
        j, depth, instr, esc = i, 0, None, False
        while j < n:
            c = css[j]
            if instr:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == instr:
                    instr = None
            elif c in "\"'":
                instr = c
            elif c in "([":
                depth += 1
            elif c in ")]":
                depth -= 1
            elif depth == 0 and c in "{};":
                break
            j += 1

        if j >= n:                                   # 收尾残渣，原样吐出去
            yield ("raw", css[i:], None)
            return
        if css[j] == ";":
            yield ("raw", css[i:j + 1], None)
            i = j + 1
            continue

        # 配对的花括号
        k, depth, instr, esc = j + 1, 1, None, False
        while k < n and depth:
            c = css[k]
            if instr:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == instr:
                    instr = None
            elif c in "\"'":
                instr = c
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            k += 1
        yield ("block", css[i:j], css[j + 1:k - 1])
        i = k


def _split_commas(sel):
    """按顶层逗号切选择器列表（不碰 :is(...) / [attr="a,b"] 里的逗号）"""
    out, cur, depth, instr = [], "", 0, None
    for c in sel:
        if instr:
            cur += c
            if c == instr:
                instr = None
            continue
        if c in "\"'":
            instr = c
            cur += c
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += c
    out.append(cur)
    return out


def scope_selector(sel, scope):
    """把一条选择器（可能是逗号列表）挂到作用域根上"""
    parts = []
    for p in _split_commas(sel):
        p = p.strip()
        if not p:
            continue
        if p in (":root", "html", "body", ":host"):
            parts.append(scope)                      # 面板自身
        elif p == "*":
            parts.append(scope)                      # 面板自身也要重置盒模型
            parts.append(scope + " *")
        else:
            parts.append(scope + " " + p)
    return ", ".join(parts)


def scope_css(css, scope):
    out = []
    for kind, prelude, body in _iter_blocks(css):
        if kind == "raw":
            out.append(prelude)
            continue
        pre = prelude.strip()
        if pre.startswith("@"):
            name = (re.match(r"@([\w-]+)", pre) or [None, ""])[1].lower()
            if name in NESTED_AT:
                out.append("%s{%s}" % (prelude, scope_css(body, scope)))
            else:
                out.append("%s{%s}" % (prelude, body))   # @keyframes / @font-face 原样
        else:
            out.append("%s{%s}" % (scope_selector(pre, scope), body))
    return "".join(out)


# ---------------------------------------------------------------- 组装

def build_css():
    chunks = [
        "/* 墨墨 · 学习面板样式 —— 生成物，请勿手改。\n"
        "   改组件请改 _tools/learn_src/*.html，再跑 _tools/build_learn_assets.py。\n"
        "   这里把组件的同名 Kit（:root 令牌 / *{} / body{} / .cell / .panel …）\n"
        "   各自作用域到 .learn-panel[data-learn=\"xx\"]，各块面板互不串味。 */\n"
    ]
    for key, fn, name in PARTS:
        css = read_css(fn)
        for var, value in FONT_TOKENS.items():
            css = re.sub(r"%s:\s*[^;]+;" % re.escape(var), "%s: %s;" % (var, value), css)
        # 字体令牌少换一个，那一处的文字就会在离线单文件里掉成系统默认衬线
        for var in FONT_TOKENS:
            if var in css:
                assert ("%s: %s;" % (var, FONT_TOKENS[var])) in css, \
                    "%s：%s 没换成功" % (fn, var)
        chunks.append("\n/* ===== %s（基于 %s）===== */\n" % (name, fn))
        chunks.append(scope_css(css, '.learn-panel[data-learn="%s"]' % key))
    return "".join(chunks)


def build_fragments():
    """读人工维护的面板骨架，做一致性检查后缩进注入。"""
    raw = open(PANELS, encoding="utf-8").read()

    # 骨架是死 DOM，id 撞车会让 getElementById 抓错面板 —— 必须挡住。
    ids = re.findall(r'\bid="([^"]+)"', raw)
    dup = sorted({i for i in ids if ids.count(i) > 1})
    assert not dup, "panels.html 里 id 撞车：%s" % dup

    # 骨架里的面板必须与 PARTS 一一对上（PARTS 决定生成哪些 CSS 作用域，
    # 骨架决定实际有哪些 DOM；两边脱钩会出现「有 DOM 没样式」或反之）。
    keys = re.findall(r'class="learn-panel"\s+data-learn="([^"]+)"', raw)
    want = [k for k, _, _ in PARTS]
    assert sorted(keys) == sorted(want), \
        "panels.html 的 data-learn=%s 与 PARTS=%s 不一致" % (keys, want)

    # data-f 是渲染层的取值槽位（learn.js 用 querySelector 在面板内找），
    # 同一块面板里重名就会静默填错地方 —— 分块查重。
    for m in re.finditer(r'<div class="learn-panel"\s+data-learn="([^"]+)"(.*?)(?=<div class="learn-panel"|$)',
                         raw, re.S):
        f = re.findall(r'data-f="([^"]+)"', m.group(2))
        dupf = sorted({x for x in f if f.count(x) > 1})
        assert not dupf, "panels.html 面板 %s 里 data-f 重名：%s" % (m.group(1), dupf)

    return "\n".join((" " * 6 + ln) if ln.strip() else "" for ln in raw.split("\n"))


def patch_index(frag):
    path = os.path.join(UI, "index.html")
    src = open(path, encoding="utf-8").read()
    pat = re.compile(r"(<!--LEARN:BEGIN[^>]*-->)(.*?)(<!--LEARN:END-->)", re.S)
    assert pat.search(src), "index.html 缺少 <!--LEARN:BEGIN--> / <!--LEARN:END--> 标记"
    out = pat.sub(lambda m: "%s\n%s\n      %s" % (m.group(1), frag, m.group(3)), src, count=1)
    open(path, "w", encoding="utf-8").write(out)


def main():
    for p in (SRC, PANELS):
        if not os.path.exists(p):
            print("找不到: %s" % p)
            return 1
    frag = build_fragments()
    css = build_css()
    with open(OUT_CSS, "w", encoding="utf-8") as f:
        f.write(css)
    patch_index(frag)
    print("== 完成 ==")
    print("   learn.css      %d 字节" % os.path.getsize(OUT_CSS))
    print("   index.html 骨架 %d 字节 / %d 个面板" % (len(frag), len(PARTS)))
    for key, fn, name in PARTS:
        print("     - %-4s %-12s → .learn-panel[data-learn=\"%s\"]" % (key, name, key))
    return 0


if __name__ == "__main__":
    sys.exit(main())