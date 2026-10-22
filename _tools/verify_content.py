#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨 · 学习内容校验（词库 / 语法库）

**这是内容生产的契约** —— 生成内容的人或 AI 都必须满足这里全部规则，
`python3 _tools/verify_content.py` 通过才算数。

约定：`_tools/learn_content/*.json` 是分批产出的**增量**，合并进
`game/content/` 之前先过这里；合并脚本见 `_tools/merge_learn_content.py`。

────────────────────────────────────────────────────────────────────────
## words_en.json / words_ja.json —— 数组，每项：

{
  "id": "en_abandon",         # 唯一；前缀必须与 lang 一致（en_ / ja_）
  "lang": "en",               # "en" | "ja"
  "tier": 4,                  # en: 1=雅思6.0 · 2=6.5 · 3=7.0 · 4=7.5+
                              # ja: 1=N5 · 2=N4
  "lesson": null,             # ja 必填 1..24（《标日初级上》第N課）；en 恒为 null
  "lemma": "abandon",         # en=词形；ja=书写形（优先汉字，无汉字用假名）
  "kana": null,               # ja 必填：全假名写法；en 恒为 null
  "kanji": null,              # ja：汉字写法；无通用汉字（如「りんご」）时留 null
                              # en 恒为 null
  "romaji": null,             # ja 必填：平文式罗马字；en 恒为 null
  "pos": "v.",                # en: n./v./adj./adv./prep./conj./phr.
                              # ja: 照抄《标日》课本的词性标注 —— 名/代/专/疑/
                              #     副/叹/连/连体/助/接/慣/短语/动1/动2/动3/形1/形2
  "pron": "/əˈbændən/",       # en=IPA 音标（带 / /）；ja=[gakusei]
  "meaning_zh": "放弃；抛弃",  # 中文释义，多义用「；」分隔
  "syn": ["desert"],          # 可选：同义/近义（en）或类义（ja）
  "ant": ["retain"],          # 可选：反义
  "colloc": ["abandon hope"], # 可选：固定搭配；ja 写助词搭配如「～を食べる」
  "example": {"t": "...", "zh": "..."},   # 目标语例句 + 中文翻译
  "audio": "audio/en/en_abandon.ogg",     # 按 id 照抄：audio/<lang>/<id>.ogg
  "distractors": ["a", "b", "c"],         # 恰好 3 个，互不相同
  "tags": ["core", "writing"]             # ≥1 个
}

## grammar_en.json / grammar_ja.json —— 对象：

{
  "version": 1,
  "lang": "en",
  "chapters": [
    { "id": "en_g_tense", "title": "时态 · 完成与进行", "sub": "TENSES",
      "kicker": "语法书 · 时态篇" }        # en: sub 是英文小题；ja: 可留空字符串
  ],
  "points": [
    {
      "id": "en_g_present_perfect",        # 唯一；前缀必须与 lang 一致
      "lang": "en",
      "chapter": "en_g_tense",             # 必须命中 chapters[].id
      "kicker": "语法书 · 时态篇",
      "title": "现在完成时",
      "title_sub": "PRESENT PERFECT",      # 标题下方的小字（en 英文 / ja 可写读音）
      "formula_label": "句 式 公 式",
      "formula": [ { "t": "have / has", "zh": false },
                   { "t": "＋", "zh": true },
                   { "t": "主语过去分词", "zh": true } ],   # zh=true → 中文块配色
      "examples": [                        # 2~3 条
        { "t": "I have finished my work.", "hl": "have finished",
          "zh": "我已经完成了我的工作。（强调结果）" }      # hl 会在 t 里加粗，可留空
      ],
      "note_label": "辨析 · 与一般过去时",
      "note": "……允许 <b> <i> <em> <strong> 四种内联标签……",
      "page": 12,                          # 页眉用；ja 可写课次页
      "foot": "时态章"                      # 页脚尾注
    }
  ]
}
────────────────────────────────────────────────────────────────────────
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "game", "content")

WORD_FILES = [("en", "words_en.json"), ("ja", "words_ja.json")]
GRAMMAR_FILES = [("en", "grammar_en.json"), ("ja", "grammar_ja.json")]

POS_EN = {"n.", "v.", "adj.", "adv.", "prep.", "conj.", "phr.", "pron.", "num."}
# 日语词性照抄《标日初级上》课本的标注体系（动1/动2/动3、形1/形2 是课本自己的叫法）
POS_JA = {"名", "代", "专", "疑", "副", "叹", "连", "连体", "助", "接", "慣",
          "短语", "动1", "动2", "动3", "形1", "形2",
          "動", "形", "形動"}                 # 后三个保留，兼容旧数据
TIER_RANGE = {"en": (1, 4), "ja": (1, 2)}

_RE_INLINE = re.compile(r"</?(?:b|i|em|strong)>")
_RE_TAGOK = re.compile(r"^\s*</?(?:b|i|em|strong)>\s*$")


def _plain(s):
    return _RE_INLINE.sub("", str(s))


def _inline_ok(s):
    """只允许 b/i/em/strong 四种内联标签，且必须成对"""
    s = str(s)
    stripped = _RE_INLINE.sub("", s)
    if "<" in stripped or ">" in stripped:
        return False
    for tag in ("b", "i", "em", "strong"):
        opens = len(re.findall(r"<%s>" % tag, s))
        closes = len(re.findall(r"</%s>" % tag, s))
        if opens != closes:
            return False
        # 不允许嵌套自己
        if re.search(r"<%s>[^<]*<%s>" % (tag, tag), s):
            return False
    return True


# ------------------------------------------------------------------ 词库

def check_words(lang, fn, errs, stats):
    path = os.path.join(CONTENT, fn)
    if not os.path.exists(path):
        errs.append("%s：文件不存在" % fn)
        return set()
    data = json.load(open(path, encoding="utf-8"))
    if not isinstance(data, list):
        errs.append("%s：顶层必须是数组" % fn)
        return set()

    ids, lemmas = {}, {}
    tier_lo, tier_hi = TIER_RANGE[lang]
    for i, w in enumerate(data):
        at = "%s[%d]" % (fn, i)
        wid = w.get("id")
        if not wid:
            errs.append("%s：缺 id" % at)
            continue
        at = "%s(%s)" % (fn, wid)
        if wid in ids:
            errs.append("%s：id 与 %s 重复" % (at, ids[wid]))
        ids[wid] = at
        if not wid.startswith(lang + "_"):
            errs.append("%s：id 前缀必须与 lang 一致（%s_）" % (at, lang))
        if w.get("lang") != lang:
            errs.append("%s：lang 字段必须是 %s" % (at, lang))

        tier = w.get("tier")
        if not isinstance(tier, int) or not (tier_lo <= tier <= tier_hi):
            errs.append("%s：tier=%r 越界（%s 允许 %d..%d）"
                        % (at, tier, lang, tier_lo, tier_hi))

        lemma = w.get("lemma")
        if not lemma or not str(lemma).strip():
            errs.append("%s：lemma 为空" % at)
        else:
            key = str(lemma).strip()
            if key in lemmas:
                errs.append("%s：lemma「%s」与 %s 重复" % (at, key, lemmas[key]))
            lemmas[key] = at

        # pos 允许写多个词性（兼类词，如「自由 = 名；形」「wish = n. / v.」）——
        # 拆开写反而失真。分隔符中英各用各的习惯（中文「；」/「、」，英文「/」），
        # 所以统一按这三种切，逐段校验，任一段非法才算错。
        pos = w.get("pos")
        allowed = POS_EN if lang == "en" else POS_JA
        parts = [p.strip() for p in re.split(r"[；、/]", str(pos or "")) if p.strip()]
        if not parts:
            errs.append("%s：pos 为空" % at)
        else:
            bad = [p for p in parts if p not in allowed]
            if bad:
                errs.append("%s：pos=%r 非法（%s 只允许 %s）"
                            % (at, pos, "英语" if lang == "en" else "日语", sorted(allowed)))

        if not str(w.get("pron") or "").strip():
            errs.append("%s：pron 为空" % at)
        if not str(w.get("meaning_zh") or "").strip():
            errs.append("%s：meaning_zh 为空" % at)

        ex = w.get("example") or {}
        if not str(ex.get("t") or "").strip() or not str(ex.get("zh") or "").strip():
            errs.append("%s：example.t / example.zh 不能为空" % at)
        if lang == "ja":
            # kanji 允许为空 —— 「りんご」这类词本来就没有通用汉字写法，
            # 这时 lemma 直接写假名即可。kana / romaji 必须齐。
            for k in ("kana", "romaji"):
                if not str(w.get(k) or "").strip():
                    errs.append("%s：日语词缺 %s" % (at, k))
            # lesson 可以**不写**：剧情 / 章节词（月见茶会那一批）不属于任何一课，
            # 写成 null 是对的。learn.js 也认这种（w.lesson 为假就不进任何课的分组，
            # 但仍能在「全部」和检索里找到）。写了就必须是 1..24。
            les = w.get("lesson")
            if les is not None and (not isinstance(les, int) or not (1 <= les <= 24)):
                errs.append("%s：lesson=%r 必须是 1..24，或留空（剧情词）" % (at, les))
            if not re.fullmatch(r"[\u3040-\u30ff\u30fc\u3005]+", str(w.get("kana") or "")):
                errs.append("%s：kana 必须全是假名：%r" % (at, w.get("kana")))
        else:
            for k in ("kana", "kanji", "romaji", "lesson"):
                if w.get(k) not in (None, "", 0):
                    errs.append("%s：英语词的 %s 必须为 null" % (at, k))
            if not re.fullmatch(r"/.+/", str(w.get("pron") or "")):
                errs.append("%s：英语 pron 必须写成 /…/：%r" % (at, w.get("pron")))

        if w.get("audio") != "audio/%s/%s.ogg" % (lang, wid):
            errs.append("%s：audio 路径不对，应为 audio/%s/%s.ogg" % (at, lang, wid))

        d = w.get("distractors")
        if not isinstance(d, list) or len(d) != 3:
            errs.append("%s：distractors 必须恰好 3 个" % at)
        else:
            if len(set(map(str, d))) != 3:
                errs.append("%s：distractors 内部重复" % at)
            if str(lemma) in [str(x) for x in d]:
                errs.append("%s：distractors 里出现了本词" % at)

        tags = w.get("tags")
        if not isinstance(tags, list) or not tags:
            errs.append("%s：tags 至少 1 个" % at)
        for k in ("syn", "ant", "colloc"):
            if k in w and w[k] is not None and not isinstance(w[k], list):
                errs.append("%s：%s 必须是数组" % (at, k))

    # 每档都必须有词（否则周目开到那一档会空转）
    tiers = {}
    for w in data:
        tiers[w.get("tier")] = tiers.get(w.get("tier"), 0) + 1
    for t in range(tier_lo, tier_hi + 1):
        if not tiers.get(t):
            errs.append("%s：tier %d 一个词都没有" % (fn, t))

    stats["%s 词数" % fn] = len(data)
    stats["%s 分档" % fn] = {k: tiers[k] for k in sorted(tiers)}
    return set(ids)


# ---------------------------------------------------------------- 语法库

def check_grammar(lang, fn, errs, stats):
    path = os.path.join(CONTENT, fn)
    if not os.path.exists(path):
        errs.append("%s：文件不存在" % fn)
        return 0
    g = json.load(open(path, encoding="utf-8"))
    if not isinstance(g, dict):
        errs.append("%s：顶层必须是对象" % fn)
        return 0
    if g.get("lang") != lang:
        errs.append("%s：lang 字段必须是 %s" % (fn, lang))

    chap_ids = set()
    for i, c in enumerate(g.get("chapters") or []):
        at = "%s.chapters[%d]" % (fn, i)
        cid = c.get("id")
        if not cid:
            errs.append("%s：缺 id" % at)
            continue
        if cid in chap_ids:
            errs.append("%s：章节 id 重复：%s" % (at, cid))
        chap_ids.add(cid)
        if not cid.startswith(lang + "_"):
            errs.append("%s：章节 id 前缀必须是 %s_" % (at, lang))
        if not str(c.get("title") or "").strip():
            errs.append("%s：缺 title" % at)

    pt_ids, used = set(), {}
    points = g.get("points") or []
    for i, p in enumerate(points):
        at = "%s.points[%d]" % (fn, i)
        pid = p.get("id")
        if not pid:
            errs.append("%s：缺 id" % at)
            continue
        at = "%s(%s)" % (fn, pid)
        if pid in pt_ids:
            errs.append("%s：语法点 id 重复" % at)
        pt_ids.add(pid)
        if not pid.startswith(lang + "_"):
            errs.append("%s：id 前缀必须与 lang 一致" % at)
        if p.get("lang") != lang:
            errs.append("%s：lang 字段必须是 %s" % (at, lang))
        ch = p.get("chapter")
        if ch not in chap_ids:
            errs.append("%s：chapter=%r 不在 chapters 里" % (at, ch))
        else:
            used.setdefault(ch, 0)
            used[ch] += 1
        for k in ("kicker", "title", "title_sub", "formula_label", "note_label", "foot"):
            if not str(p.get(k) or "").strip():
                errs.append("%s：%s 为空" % (at, k))
        if not isinstance(p.get("page"), int):
            errs.append("%s：page 必须是整数" % at)

        f = p.get("formula")
        if not isinstance(f, list) or not f:
            errs.append("%s：formula 至少 1 块" % at)
        else:
            for j, seg in enumerate(f):
                if not str(seg.get("t") or "").strip():
                    errs.append("%s：formula[%d].t 为空" % (at, j))
                if not isinstance(seg.get("zh"), bool):
                    errs.append("%s：formula[%d].zh 必须是 true/false" % (at, j))

        exs = p.get("examples")
        if not isinstance(exs, list) or not (2 <= len(exs) <= 3):
            errs.append("%s：examples 必须 2~3 条" % at)
        else:
            for j, e in enumerate(exs):
                t, zh, hl = e.get("t"), e.get("zh"), e.get("hl")
                if not str(t or "").strip() or not str(zh or "").strip():
                    errs.append("%s：examples[%d] 的 t / zh 不能为空" % (at, j))
                if hl and str(hl) not in str(t):
                    errs.append("%s：examples[%d].hl=%r 不是 t 的子串" % (at, j, hl))
                if str(t).count("<") or str(zh).count("<"):
                    errs.append("%s：examples[%d] 不要内联标签，加粗用 hl 字段" % (at, j))

        if not _inline_ok(p.get("note") or ""):
            errs.append("%s：note 只允许成对的 <b> <i> <em> <strong>" % at)

    for cid in sorted(chap_ids - set(used)):
        errs.append("%s：章节 %s 没有任何语法点（空章节）" % (fn, cid))

    stats["%s 章节" % fn] = len(chap_ids)
    stats["%s 语法点" % fn] = len(points)
    return len(points)


# ------------------------------------------------------- 教案引用零断链

def check_lessons(errs, word_ids, stats):
    path = os.path.join(CONTENT, "lessons.json")
    if not os.path.exists(path):
        return
    obj = json.load(open(path, encoding="utf-8"))
    refs = []

    def walk(x):
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ("word", "id") and isinstance(v, str) and "_" in v:
                    refs.append(v)
                else:
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str) and re.fullmatch(r"(en|ja)_\S+", x):
            refs.append(x)

    walk(obj.get("days"))
    walk(obj.get("next"))
    broken = sorted({r for r in refs if r not in word_ids})
    if broken:
        errs.append("lessons.json 引用了不存在的词：%s" % broken[:10])
    stats["lessons 引用词"] = len(set(refs))


# ------------------------------------------------------------ 地点小游戏

def check_minigames(errs, stats):
    """minigames.json 是「几套内核 × 每个地点一套关卡」的数据契约。
    关卡键必须是地图上真实存在的「楼层:房间」—— 写错了那个地点会静默变成
    「小游戏还在做」，不报错就更难查。"""
    path = os.path.join(CONTENT, "minigames.json")
    if not os.path.exists(path):
        errs.append("minigames.json：文件不存在")
        return
    g = json.load(open(path, encoding="utf-8"))
    cores = g.get("cores") or {}
    levels = g.get("levels") or {}
    if not cores:
        errs.append("minigames.json：cores 为空")
    if not levels:
        errs.append("minigames.json：levels 为空")

    # 地图上的真实地点；楼梯是换楼层的，不该挂玩法
    places, stairs = set(), set()
    mp = os.path.join(CONTENT, "map.json")
    if os.path.exists(mp):
        M = json.load(open(mp, encoding="utf-8"))
        for fk in M.get("order") or []:
            rooms = ((M.get("floors") or {}).get(fk) or {}).get("rooms") or []
            for r in rooms:
                k = fk + ":" + str(r.get("label") or "")
                (stairs if r.get("kind") == "stair" else places).add(k)

    # 可用的表情名（台词里写错表情名不会报错，只会静默回默认立绘）
    exprs = set()
    ep = os.path.join(CONTENT, "expressions.json")
    if os.path.exists(ep):
        E = json.load(open(ep, encoding="utf-8"))
        exprs.add(E.get("default") or "默认")
        for mp_ in (E.get("sets") or {}).values():
            exprs |= set(mp_.keys())
        exprs |= set(E.get("aliases") or {})

    # 「运行时真的实现了哪些内核」以 minigame.js 的 RUNNERS 注册表为准。
    # 不能拿 minigames.json 的 cores 段当全集：那一段只放**需要默认参数**的内核，
    # 例如 order / hunt 的参数全部写在关卡自己的 params 里，不进 cores 也完全能跑。
    # 内核名字写错（比如 "rushh"）在运行时会被 RUNNERS[x] || skim 静默兜成打水漂，
    # 玩家玩到的就是另一回事 —— 所以这条必须对着注册表卡。
    cores_impl = set()
    mg = os.path.join(ROOT, "game", "js", "minigame.js")
    if os.path.exists(mg):
        src = open(mg, encoding="utf-8").read()
        mm = re.search(r"var RUNNERS\s*=\s*\{([^}]*)\}", src)
        if mm:
            cores_impl = set(re.findall(r"(\w+)\s*:", mm.group(1)))
    if not cores_impl:
        errs.append("读不到 minigame.js 的 RUNNERS 注册表（校验没法确认内核是否存在）")
    stats["minigame_cores"] = sorted(cores_impl)

    for key, L in sorted(levels.items()):
        at = "minigames.json(%s)" % key
        if places and key not in places:
            errs.append("%s：地图上没有这个地点（键要写「楼层:房间」）" % at)
        if key in stairs:
            errs.append("%s：楼梯只负责换楼层，不该做玩法" % at)
        if cores_impl and L.get("core") not in cores_impl:
            errs.append("%s：core=%r 运行时没实现（已实现：%s）"
                        % (at, L.get("core"), "、".join(sorted(cores_impl))))
        if not str(L.get("title") or "").strip():
            errs.append("%s：缺 title" % at)
        if not isinstance(L.get("params") or {}, dict):
            errs.append("%s：params 必须是对象" % at)
        e = L.get("earn")
        if not isinstance(e, list) or len(e) != 4:
            errs.append("%s：earn 必须是 4 个数（S/A/B/C）" % at)
        elif not all(e[i] > e[i + 1] for i in range(3)):
            errs.append("%s：earn 要从 S 到 C 递减：%r" % (at, e))
        lines = L.get("lines") or {}
        # 按内核查必填参数：缺了不是「还没做」，是进屏就跑不起来
        p = L.get("params") or {}
        if L.get("core") == "skim":
            if not isinstance(p.get("shots"), int) or not (3 <= p["shots"] <= 10):
                errs.append("%s：skim 的 shots 必须是 3..10 的整数" % at)
        if L.get("core") == "rush":
            menu = p.get("menu") or []
            recipes = p.get("recipes") or []
            if len(menu) < 4:
                errs.append("%s：rush 的 menu 至少 4 格" % at)
            if not recipes:
                errs.append("%s：rush 缺 recipes" % at)
            for j, rec in enumerate(recipes):
                if not isinstance(rec, list) or len(rec) < 2:
                    errs.append("%s：recipes[%d] 至少两步" % (at, j))
                    continue
                for st in rec:
                    if st not in menu:
                        errs.append("%s：recipes[%d] 里的「%s」不在 menu 里（这一单永远做不完）"
                                    % (at, j, st))
            t = p.get("target")
            if not (isinstance(t, list) and len(t) == 3 and t[0] > t[1] > t[2]):
                errs.append("%s：rush 的 target 必须是递减的 3 个数 [S,A,B]" % at)
        for kind in ("start", "win", "lose"):
            if kind not in lines:
                errs.append("%s：lines 缺 %s" % (at, kind))
        for kind, arr in lines.items():
            if not isinstance(arr, list):
                errs.append("%s：lines.%s 必须是数组" % (at, kind))
                continue
            for i, ln in enumerate(arr):
                if not isinstance(ln, dict):
                    errs.append("%s：lines.%s[%d] 必须是对象" % (at, kind, i))
                    continue
                ex = ln.get("expr")
                if ex and exprs and ex not in exprs:
                    errs.append("%s：lines.%s[%d] 的表情 %r 不存在" % (at, kind, i, ex))
                if not str(ln.get("text") or "").strip() and not ex:
                    errs.append("%s：lines.%s[%d] 既没台词也没表情" % (at, kind, i))

    stats["minigames 内核"] = len(cores)
    stats["minigames 关卡"] = len(levels)


def main():
    errs, stats = [], {}
    word_ids = set()
    for lang, fn in WORD_FILES:
        word_ids |= check_words(lang, fn, errs, stats)
    np_ = 0
    for lang, fn in GRAMMAR_FILES:
        np_ += check_grammar(lang, fn, errs, stats)
    check_lessons(errs, word_ids, stats)
    check_minigames(errs, stats)

    print("== 学习内容校验 ==")
    for k, v in stats.items():
        print("   %-16s %s" % (k, v))
    if errs:
        print("\n[不合格] %d 项：" % len(errs))
        for e in errs[:60]:
            print("   - %s" % e)
        if len(errs) > 60:
            print("   … 还有 %d 项" % (len(errs) - 60))
        print("\nRESULT: FAIL")
        return 1
    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())