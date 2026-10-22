#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨 · 学习内容合并

`_tools/learn_content/` 里的分批产出 → `game/content/` 的正式数据。

为什么要分两步：内容量大，是多个批次分别产出的；直接把批次拼进正式文件，
之后想修某一批就得手工 diff。这里做**幂等合并**：

  · 第一次运行会把当时的正式文件原样备份成 `_base_words_en.json` /
    `_base_words_ja.json`（底下那 60 词是 M1 的历史内容，是教案 lessons.json
    的引用对象，id 绝不能变）。
  · 之后每次都从**不变的基线** + 全部批次重新算一遍 —— 所以改了某个批次，
    重跑就会生效，不会像「就地追加」那样被旧结果挡掉。

去重规则：id 与 lemma 都不允许重复（同形异义的词在选择题里会互相干扰）。

用法：  python3 _tools/merge_learn_content.py
产出：  game/content/words_en.json / words_ja.json
        game/content/grammar_en.json / grammar_ja.json
"""

import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BATCH = os.path.join(ROOT, "_tools", "learn_content")
CONTENT = os.path.join(ROOT, "game", "content")

# 语言 → (正式文件, 基线备份, 批次文件名前缀)
WORDS = {
    "en": ("words_en.json", "_base_words_en.json", ("en_",)),
    "ja": ("words_ja.json", "_base_words_ja.json", ("ja_l",)),
}
GRAMMAR = {
    # 注意前缀别写成 "gram_" —— 那会把 gram_ja_* 也匹配进英语语法库里
    "en": ("grammar_en.json", ("gram_en",)),
    "ja": ("grammar_ja.json", ("gram_ja",)),
}
# 给基线日语词补 lesson 等字段的补充表（不改 id / lemma）
PATCH = "ja_existing_lesson.json"


def load(fp):
    with open(fp, encoding="utf-8") as f:
        return json.load(f)


def dump(fp, obj):
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")


def batch_files(prefixes):
    out = []
    for p in sorted(glob.glob(os.path.join(BATCH, "*.json"))):
        name = os.path.basename(p)
        if name.startswith("_") or name == PATCH:
            continue
        if name.startswith(prefixes):
            out.append(p)
    return out


def merge_words(lang, stats):
    fn, base_fn, prefixes = WORDS[lang]
    formal = os.path.join(CONTENT, fn)
    backup = os.path.join(BATCH, base_fn)

    # 首次运行：把当时的正式文件留成基线
    if not os.path.exists(backup):
        if not os.path.exists(formal):
            print("   [跳过] 找不到 %s，无法建立基线" % fn)
            return
        dump(backup, load(formal))
        print("   已建立基线 %s（%d 条）" % (base_fn, len(load(formal))))

    base = load(backup)

    # 补字段表（baseline 里的日语词缺 lesson）
    patch = {}
    pp = os.path.join(BATCH, PATCH)
    if lang == "ja" and os.path.exists(pp):
        patch = load(pp)

    entries, seen_id, seen_lemma = [], set(), set()
    dup_id, dup_lemma = [], []

    def take(w, src):
        wid, lem = w.get("id"), str(w.get("lemma") or "").strip()
        if not wid or not lem:
            return
        if wid in seen_id or lem in seen_lemma:
            (dup_id if wid in seen_id else dup_lemma).append("%s(%s)" % (lem, src))
            return
        seen_id.add(wid)
        seen_lemma.add(lem)
        entries.append(w)

    for w in base:
        w = dict(w)
        if w["id"] in patch:
            w.update(patch[w["id"]])
            stats["%s 补字段" % fn] = stats.get("%s 补字段" % fn, 0) + 1
        take(w, "base")

    n_base = len(entries)
    added = 0
    for p in batch_files(prefixes):
        try:
            arr = load(p)
        except Exception as e:
            print("   [跳过] %s 解析失败：%s" % (os.path.basename(p), e))
            continue
        if not isinstance(arr, list):
            print("   [跳过] %s 不是数组" % os.path.basename(p))
            continue
        before = len(entries)
        for w in arr:
            if isinstance(w, dict):
                take(w, os.path.basename(p))
        added += len(entries) - before
        print("   %-24s +%d" % (os.path.basename(p), len(entries) - before))

    # 排序：英语按首字母 A→Z、日语按课次，同组内按 id —— 词形相邻，翻卡片更顺
    if lang == "en":
        entries.sort(key=lambda w: (str(w["lemma"]).lower(), w["id"]))
    else:
        entries.sort(key=lambda w: (w.get("lesson", 0), w["id"]))

    dump(os.path.join(CONTENT, fn), entries)
    stats["%s 基线" % fn] = n_base
    stats["%s 新增" % fn] = added
    stats["%s 合计" % fn] = len(entries)
    if dup_id:
        print("   [被去重·id 重复] %d 条（前几个：%s）" % (len(dup_id), dup_id[:5]))
    if dup_lemma:
        print("   [被去重·lemma 重复] %d 条（前几个：%s）" % (len(dup_lemma), dup_lemma[:5]))


def merge_grammar(lang, stats):
    fn, prefixes = GRAMMAR[lang]
    files = batch_files(prefixes)
    if not files:
        print("   [跳过] %s：还没有批次" % fn)
        return
    chapters, points, cid, pid = [], [], set(), set()
    for p in files:
        try:
            g = load(p)
        except Exception as e:
            print("   [跳过] %s 解析失败：%s" % (os.path.basename(p), e))
            continue
        if not isinstance(g, dict):
            continue
        nc = np_ = 0
        for c in g.get("chapters") or []:
            if c.get("id") and c["id"] not in cid:
                cid.add(c["id"])
                chapters.append(c)
                nc += 1
        for q in g.get("points") or []:
            if q.get("id") and q["id"] not in pid:
                pid.add(q["id"])
                points.append(q)
                np_ += 1
        print("   %-24s 章节 +%d / 语法点 +%d" % (os.path.basename(p), nc, np_))

    out = {"version": 1, "lang": lang, "chapters": chapters, "points": points}
    dump(os.path.join(CONTENT, fn), out)
    stats["%s 章节" % fn] = len(chapters)
    stats["%s 语法点" % fn] = len(points)


def main():
    if not os.path.isdir(BATCH):
        print("找不到批次目录: %s" % BATCH)
        return 1
    stats = {}
    print("== 词库 ==")
    for lang in ("en", "ja"):
        print(" [%s]" % lang)
        merge_words(lang, stats)
    print("== 语法库 ==")
    for lang in ("en", "ja"):
        print(" [%s]" % lang)
        merge_grammar(lang, stats)

    print("\n== 完成 ==")
    for k, v in stats.items():
        print("   %-18s %s" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())