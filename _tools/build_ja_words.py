#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨 · 日语词库生成（《新版 中日交流标准日本语 初级上》）

数据源：`_tools/ja_words_src.txt` —— 课本「每课新出単語」表的纯文本导出
（`textutil -convert txt` 自 Word 源），每课一段，条目形如：

    中国人/ちゅうごくじん/名/中国人      ← 汉字/假名/词性/释义
    かばん/名/包,公文包                   ← 无汉字时省略汉字段

产物：`_tools/learn_content/ja_l01_03.json` …（按课段分批），再由
      `_tools/merge_learn_content.py` 合并成 `game/content/words_ja.json`。

例句是**自造**的，单独放在 `_tools/ja_examples.json`（id → {t, zh}），
本脚本只负责把课本词形、读音、词性、释义原样搬进来 —— 词表部分零改写。

用法：  python3 _tools/build_ja_words.py
"""

import json
import os
import re
import sys
import collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "_tools", "ja_words_src.txt")
EXAMPLES_DIR = os.path.join(ROOT, "_tools", "ja_examples")
BATCH = os.path.join(ROOT, "_tools", "learn_content")

# 课本词性 → 词库 POS 白名单（与 verify_content.py 对齐）
POS_KEEP = {"名", "代", "副", "叹", "专", "疑", "连体", "连", "短语",
            "动1", "动2", "动3", "形1", "形2", "助", "接", "惯"}
# 源文件里 なまえ/名前/姓名 这类字段错位：第 2 段不是词性而是汉字
POS_TAGS = {
    "名": "noun", "代": "pron", "副": "adv", "叹": "interj", "专": "name",
    "疑": "question", "连体": "adj", "连": "conj", "短语": "phrase",
    "动1": "verb", "动2": "verb", "动3": "verb", "形1": "adj", "形2": "adj",
    "助": "particle", "接": "conj", "惯": "phrase",
}

# 源文件缺释义（接尾語/助数詞）时手工补的短释义
MEANING_FIX = {
    "～様": "敬称（接在人名后）", "～用": "用于…；…专用", "～中": "…之中；整个…",
    "～中（ちゅう）": "正在…中；…之内", "～年間": "…年之间", "～中に": "在…期间内",
    "～たち": "…们（表复数）", "～過ぎ": "超过…；…过头",
    "～さん": "…先生／女士（敬称）", "～君": "…君（对平辈、晚辈的称呼）",
    "何～": "几…（接量词）", "～歳": "…岁", "お～": "敬语接头辞（美化语）",
    "～階": "…层（楼层的量词）", "～円": "…日元", "～曜日": "星期…",
    "～時": "…点（时刻）", "～分": "…分（分钟）", "～半": "…点半",
    "～月": "…月（月份）", "～日": "…日（日期）", "～年": "…年",
    "～ごろ": "…左右（大致时间）", "～冊": "…本（书、笔记本的量词）",
    "～回": "…次（次数）", "～枚": "…张／枚（薄物的量词）", "～個": "…个（量词）",
    "～杯": "…杯（容器、杯数的量词）", "～人": "…人（人数的量词）",
    "～台": "…台（机器、车辆的量词）", "～本": "…根／瓶（细长物的量词）",
    "～頭": "…头（大型动物的量词）", "～匹": "…只（小型动物的量词）",
    "～つ": "…个（泛指事物的量词）", "～着": "…套（衣服的量词）",
    "～羽": "…只（鸟、兔的量词）", "～番": "…号（顺序）",
    "～足": "…双（鞋袜的量词）", "～度": "…度（次数、温度、角度）",
    "～キロメートル": "…公里", "～皿": "…盘（菜肴的量词）",
    "～時間": "…小时", "～週間": "…周", "～か月": "…个月",
    "～製": "…制造", "～料": "…费；材料费", "～費": "…费用", "～代": "…费",
    "～以外": "…以外；除了…", "～方": "…的方法（动词ます形＋方）",
    "～によって": "根据…；因…而不同", "～によります": "要看…而定",
    "～について": "关于…", "少々": "稍微；一点",
}

# ---------------------------------------------------------------- 假名→罗马字

_KATA2HIRA = {chr(0x30A1 + i): chr(0x3041 + i) for i in range(0x30F6 - 0x30A1 + 1)}
_KATA2HIRA["ヵ"] = "ゕ"
_KATA2HIRA["ヶ"] = "ゖ"

_MONO = {
    "あ": "a", "い": "i", "う": "u", "え": "e", "お": "o",
    "か": "ka", "き": "ki", "く": "ku", "け": "ke", "こ": "ko",
    "が": "ga", "ぎ": "gi", "ぐ": "gu", "げ": "ge", "ご": "go",
    "さ": "sa", "し": "shi", "す": "su", "せ": "se", "そ": "so",
    "ざ": "za", "じ": "ji", "ず": "zu", "ぜ": "ze", "ぞ": "zo",
    "た": "ta", "ち": "chi", "つ": "tsu", "て": "te", "と": "to",
    "だ": "da", "ぢ": "ji", "づ": "zu", "で": "de", "ど": "do",
    "な": "na", "に": "ni", "ぬ": "nu", "ね": "ne", "の": "no",
    "は": "ha", "ひ": "hi", "ふ": "fu", "へ": "he", "ほ": "ho",
    "ば": "ba", "び": "bi", "ぶ": "bu", "べ": "be", "ぼ": "bo",
    "ぱ": "pa", "ぴ": "pi", "ぷ": "pu", "ぺ": "pe", "ぽ": "po",
    "ま": "ma", "み": "mi", "む": "mu", "め": "me", "も": "mo",
    "や": "ya", "ゆ": "yu", "よ": "yo",
    "ら": "ra", "り": "ri", "る": "ru", "れ": "re", "ろ": "ro",
    "わ": "wa", "ゐ": "i", "ゑ": "e", "を": "o", "ん": "n", "ゔ": "vu",
    "ゕ": "ka", "ゖ": "ke",
}
_DIGRAPH = {
    "きゃ": "kya", "きゅ": "kyu", "きょ": "kyo",
    "ぎゃ": "gya", "ぎゅ": "gyu", "ぎょ": "gyo",
    "しゃ": "sha", "しゅ": "shu", "しょ": "sho",
    "じゃ": "ja", "じゅ": "ju", "じょ": "jo",
    "ちゃ": "cha", "ちゅ": "chu", "ちょ": "cho",
    "ぢゃ": "ja", "ぢゅ": "ju", "ぢょ": "jo",
    "にゃ": "nya", "にゅ": "nyu", "にょ": "nyo",
    "ひゃ": "hya", "ひゅ": "hyu", "ひょ": "hyo",
    "びゃ": "bya", "びゅ": "byu", "びょ": "byo",
    "ぴゃ": "pya", "ぴゅ": "pyu", "ぴょ": "pyo",
    "みゃ": "mya", "みゅ": "myu", "みょ": "myo",
    "りゃ": "rya", "りゅ": "ryu", "りょ": "ryo",
    "ふぁ": "fa", "ふぃ": "fi", "ふぇ": "fe", "ふぉ": "fo",
    "てぃ": "ti", "でぃ": "di", "とぅ": "tu", "どぅ": "du",
    "うぃ": "wi", "うぇ": "we", "うぉ": "wo",
    "しぇ": "she", "じぇ": "je", "ちぇ": "che",
    "つぁ": "tsa", "つぃ": "tsi", "つぇ": "tse", "つぉ": "tso",
    "ゔぁ": "va", "ゔぃ": "vi", "ゔぇ": "ve", "ゔぉ": "vo",
}
_VOWELS = set("aiueo")


def to_hiragana(s):
    return "".join(_KATA2HIRA.get(c, c) for c in s)


def romaji(kana):
    """平文式罗马字（促音、拨音、长音都按读写习惯处理）"""
    s = to_hiragana(kana)
    out, i, n = [], 0, len(s)
    while i < n:
        two = s[i:i + 2]
        if two in _DIGRAPH:
            out.append(_DIGRAPH[two]); i += 2; continue
        c = s[i]
        if c == "っ":                        # 促音：重复后一个辅音
            nxt = None
            if s[i + 1:i + 3] in _DIGRAPH:
                nxt = _DIGRAPH[s[i + 1:i + 3]]
            elif s[i + 1:i + 2] in _MONO:
                nxt = _MONO[s[i + 1:i + 2]]
            if nxt:
                out.append("t" if nxt.startswith("ch") else nxt[0])
            i += 1; continue
        if c == "ー":                        # 长音：拉长前一个元音
            if out:
                prev = out[-1]
                for v in reversed(prev):
                    if v in _VOWELS:
                        out.append(v); break
            i += 1; continue
        if c == "ん":                        # 拨音：元音/ya 行前加 '
            nxt = s[i + 1:i + 2]
            nx2 = s[i + 1:i + 3]
            if (nxt in ("や", "ゆ", "よ", "あ", "い", "う", "え", "お")
                    or nx2 in ("にゃ", "にゅ", "にょ")):
                out.append("n'")
            else:
                out.append("n")
            i += 1; continue
        if c in _MONO:
            out.append(_MONO[c]); i += 1; continue
        i += 1                               # 未知字符（～ 等）直接跳过
    return "".join(out)


# ------------------------------------------------------------------ 解析源文本

def parse_source():
    """→ [{lesson, kanji, kana, pos, zh}]，保持课本原始顺序"""
    rows, lesson, skipped = [], None, []
    with open(SRC, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            m = re.match(r"^第(\d{1,2})课$", line)
            if m:
                lesson = int(m.group(1)); continue
            if lesson is None:
                skipped.append(line); continue
            parts = [p.strip() for p in line.split("/")]
            got = []
            if len(parts) == 4:
                got = [(parts[0], parts[1], parts[2], parts[3])]
            elif len(parts) == 3:
                if parts[1] in POS_KEEP:                       # 假名/词性/释义
                    got = [("", parts[0], parts[1], parts[2])]
                else:                                          # 字段错位：假名/汉字/释义
                    got = [("", parts[0], "名", parts[2])]
                    print("   [字段错位] %r → 汉字=%s 假名=%s" % (line, parts[1], parts[0]))
                    if parts[1]:
                        got = [(parts[1], parts[0], "名", parts[2])]
            elif len(parts) >= 6 and len(parts) % 2 == 0 and parts[-2] in POS_KEEP:
                half = (len(parts) - 2) // 2                        # 一行塞了多个词形
                forms, kanas = parts[:half], parts[half:2 * half]
                got = [(f, k, parts[-2], parts[-1]) for f, k in zip(forms, kanas)
                       if f and k]
            else:
                skipped.append(line); continue
            for kanji, kana, pos, zh in got:
                if not kana:
                    skipped.append(line); continue
                rows.append({"lesson": lesson, "kanji": kanji, "kana": kana,
                             "pos": pos, "zh": zh})
    return rows, skipped


# 源 .doc 里的明显错形，按课本正确写法回正（汇报时会列出）
KANA_FIX = {"トィレ": "トイレ"}
LEMMA_FIX = {"バーゲンかいじょう会場": "バーゲン会場"}
# 上面两处改 id 后，例句表里的旧 key 仍要能取到
EX_ALIAS = {"ja_トイレ": "ja_トィレ", "ja_バーゲン会場": "ja_バーゲンかいじょう会場"}

_HIRA = re.compile(r"^[\u3041-\u309f\u30fc]+$")


def build():
    rows, skipped = parse_source()
    examples = {}
    if os.path.isdir(EXAMPLES_DIR):
        for name in sorted(os.listdir(EXAMPLES_DIR)):
            if not name.endswith(".json"):
                continue
            got = json.load(open(os.path.join(EXAMPLES_DIR, name), encoding="utf-8"))
            dup = set(got) & set(examples)
            if dup:
                print("   [例句重复] %s：%s" % (name, sorted(dup)[:5]))
            examples.update(got)
        print("   已载入例句 %d 条（%s/*.json）" % (len(examples), EXAMPLES_DIR))

    used_lemma, entries = {}, []
    for r in rows:
        kanji, kana, pos, zh = r["kanji"], r["kana"], r["pos"], r["zh"]
        kanji = LEMMA_FIX.get(kanji, kanji)
        kana = KANA_FIX.get(kana, kana)
        if "～" in kana:                          # 接尾語的「何～/なん～」，把占位记号去掉
            kana = kana.replace("～", "") or kana
        syn = None
        if kanji and kana and kanji != kana and _HIRA.match(kanji) and _HIRA.match(kana):
            # 源文件把「近义词」写进了假名段（じゃあ/では、とても/たいへん…）
            syn, kana, kanji = [kana], kanji, ""
        lemma = kanji or kana
        if lemma in ("～ちゅん",):                 # 源文件讹字，无此词
            print("   [丢弃·源文件讹字] %s" % lemma)
            continue
        if zh in ("", None):
            zh = MEANING_FIX.get(lemma) or MEANING_FIX.get(lemma + "（%s）" % kana) or ""
        if lemma in used_lemma:                    # 同形不同读（降ります/～中）
            lemma = "%s（%s）" % (lemma, kana)
        used_lemma[lemma] = r["lesson"]
        rid = "ja_" + lemma
        w = {
            "id": rid, "lang": "ja",
            "tier": 1 if r["lesson"] <= 12 else 2,
            "lesson": r["lesson"],
            "lemma": lemma,
            "kana": kana,
            "kanji": kanji or None,
            "romaji": romaji(kana),
            "pos": pos,
            "pron": "[%s]" % romaji(kana),
            "meaning_zh": zh,
            "audio": "audio/ja/%s.ogg" % rid,
            "tags": ["core", POS_TAGS.get(pos, "word")],
        }
        if syn:
            w["syn"] = syn
        entries.append(w)

    # 干扰项：同课、同词性优先，取 3 个；不够再向邻课借
    by_lesson = collections.defaultdict(list)
    for e in entries:
        by_lesson[e["lesson"]].append(e)
    allf = [(e["id"], e["kanji"] or e["kana"], e["pos"], e["lesson"]) for e in entries]
    for i, e in enumerate(entries):
        my = e["kanji"] or e["kana"]
        same = [x for x in allf if x[3] == e["lesson"] and x[1] != my]
        same_pos = [x for x in same if x[2] == e["pos"]]
        near = [x for x in allf if abs(x[3] - e["lesson"]) <= 2 and x[1] != my]
        cand, seen = [], set()
        for x in same_pos + same + near:
            if x[1] not in seen:
                seen.add(x[1]); cand.append(x[1])
            if len(cand) >= 3:
                break
        start = i % max(1, len(cand)) if cand else 0
        e["distractors"] = (cand[start:] + cand[:start])[:3]

    # 例句（自造，单独维护）
    missing = []
    for e in entries:
        ex = examples.get(e["id"]) or examples.get(EX_ALIAS.get(e["id"], ""))
        if ex and str(ex.get("t", "")).strip() and str(ex.get("zh", "")).strip():
            e["example"] = {"t": ex["t"], "zh": ex["zh"]}
        else:
            missing.append(e["id"])
            e["example"] = {"t": "", "zh": ""}

    # 分批写出（沿用 merge 已登记的批文件名，按课段覆盖）
    groups = {"ja_l01_03": (1, 3), "ja_l04_06": (4, 6), "ja_l07_09": (7, 9),
              "ja_l10_12": (10, 12), "ja_l13_15": (13, 15), "ja_l16_18": (16, 18),
              "ja_l19_21": (19, 21), "ja_l22_24": (22, 24)}
    for name, (lo, hi) in groups.items():
        sub = [e for e in entries if lo <= e["lesson"] <= hi]
        sub.sort(key=lambda e: (e["lesson"], e["id"]))
        with open(os.path.join(BATCH, name + ".json"), "w", encoding="utf-8") as f:
            json.dump(sub, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("   %-16s %d 条" % (name + ".json", len(sub)))
    with open(os.path.join(BATCH, "ja_l01_24_extra.json"), "w", encoding="utf-8") as f:
        json.dump([], f, ensure_ascii=False)
        f.write("\n")

    # lessons.json 引用的历史词（id 必须保留，取课本里同 id 的条目）
    ref_ids = ["ja_学生", "ja_先生", "ja_学校", "ja_友達", "ja_水", "ja_花", "ja_車",
               "ja_家族", "ja_電車", "ja_リンゴ", "ja_天気", "ja_時間", "ja_仕事",
               "ja_お金", "ja_病院", "ja_音楽", "ja_駅", "ja_映画", "ja_電話",
               "ja_夜", "ja_食べ物", "ja_家"]
    byid = {e["id"]: e for e in entries}
    base = [byid[i] for i in ref_ids if i in byid]
    miss_ref = [i for i in ref_ids if i not in byid]
    with open(os.path.join(BATCH, "_base_words_ja.json"), "w", encoding="utf-8") as f:
        json.dump(base, f, ensure_ascii=False, indent=1)
        f.write("\n")

    print("\n== 生成完毕 ==")
    print("   词条      %d" % len(entries))
    print("   课数      %d" % len({e["lesson"] for e in entries}))
    print("   每课词数  %s" % dict(sorted(collections.Counter(
        e["lesson"] for e in entries).items())))
    print("   跳过行    %d" % len(skipped))
    print("   基线词    %d（lessons.json 引用）%s" % (len(base), miss_ref or ""))
    print("   缺例句    %d" % len(missing))
    if missing:
        with open("/tmp/ja_missing_examples.txt", "w", encoding="utf-8") as f:
            for m in missing:
                f.write(m + "\n")
        print("            清单 → /tmp/ja_missing_examples.txt")


if __name__ == "__main__":
    sys.exit(build())