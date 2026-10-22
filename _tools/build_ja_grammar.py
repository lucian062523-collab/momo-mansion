#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨 · 日语语法库生成（《新版 中日交流标准日本语 初级上》）

数据源：`_tools/ja_grammar_src.json` —— 语法速查 PDF 的结构化抽取结果：
  · lessons[]   第1課～第24課，每课若干行「语法/句型 | 意思 | 例句 | 首见课」
  · particles[] 文末「格助词总表」，每个助词的每种用法一行

抽取这一步需要 pymupdf，单独用 `--extract` 跑一次（产物已入库，日常构建不需要）：

    /tmp/pdfenv/bin/python _tools/build_ja_grammar.py --extract \
        "/path/to/语法速查.pdf"

产物：`_tools/learn_content/gram_ja_1.json` / `gram_ja_2.json`，再由
      `_tools/merge_learn_content.py` 合成 `game/content/grammar_ja.json`。

PDF 每行只给 1 条例句，词库契约要求每个语法点 2~3 条 —— 补的那条写在
`_tools/ja_grammar_extra_examples.json`（id → {t, zh}，同样是自造的）。

用法：  python3 _tools/build_ja_grammar.py
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "_tools", "ja_grammar_src.json")
EXTRA_DIR = os.path.join(ROOT, "_tools", "ja_grammar_examples")
BATCH = os.path.join(ROOT, "_tools", "learn_content")

WM = ("汐中月", "红书")
_RE_WM = re.compile(r"@?汐中月[^　 ]*|红书）")


def _clean(s):
    s = _RE_WM.sub("", s).strip()
    return "" if s in ("@", "）", ")", "-18") else s


def _page_rows(page, bounds):
    """把一页切成「视觉行 × 列」。必须按**字符**分列 —— pymupdf 的 word
    会把「意思」和「例句」两格的文字黏成一个块，只有字符坐标才切得开。"""
    chars = []
    for blk in page.get_text("rawdict")["blocks"]:
        for ln in blk.get("lines", []):
            for sp in ln["spans"]:
                t = "".join(c["c"] for c in sp["chars"])
                if "汐中月" in t or "红书" in t:      # 水印文字
                    continue
                if sp.get("size", 0) >= 15:           # 斜排大号水印（正文 8.4~12.5）
                    continue
                for ch in sp["chars"]:
                    chars.append((ch["bbox"][0], ch["bbox"][1], ch["c"]))
    if not chars:
        return []
    ys = sorted({c[1] for c in chars})
    groups, cur = [], []
    for y in ys:                                  # 相邻 4.5pt 内算同一视觉行
        if cur and y - cur[-1] > 4.5:
            groups.append((cur[0], cur[-1])); cur = []
        cur.append(y)
    if cur:
        groups.append((cur[0], cur[-1]))

    def gid(y):
        lo, hi = 0, len(groups) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if y < groups[mid][0]:
                hi = mid - 1
            elif y > groups[mid][1]:
                lo = mid + 1
            else:
                return mid
        return None

    rows = {}
    for x, y, t in chars:
        g = gid(y)
        if g is None:
            continue
        buf = rows.setdefault(g, [""] * len(bounds))
        for i, b in enumerate(bounds):
            if x < b:
                buf[i] += t
                break
        else:
            buf[-1] += t
    return [(k, [_clean(c) for c in v]) for k, v in sorted(rows.items())]


def extract(pdf_path):
    import fitz
    doc = fitz.open(pdf_path)
    B1 = [180, 295, 500, 10 ** 9]
    B2 = [85, 175, 205, 335, 10 ** 9]
    rows, part2, lesson, stop = [], False, None, False
    for pno in range(doc.page_count):
        page = doc[pno]
        lines1 = _page_rows(page, B1)
        if any(v[0].startswith("第二部分") for _, v in lines1):
            part2 = True                          # 格助词总表都在后几页
        for k, v in (_page_rows(page, B2) if part2 else lines1):
            if not part2:
                c1, c2, c3, c4 = v
                head = (c1 + c2).strip()          # 课标题会横跨前两列
                m = re.match(r"^第(\d{1,2})課\s*(.*)$", head)
                if m:
                    lesson = {"no": int(m.group(1)), "title": m.group(2).strip(),
                              "intro": "", "rows": []}
                    rows.append(lesson)
                    continue
                if "语法" in c1 and "句型" in c1:
                    continue
                if not lesson:
                    continue
                if c1 and c4 and re.match(r"^L\d+$", c4):
                    lesson["rows"].append({"pattern": c1, "meaning": c2,
                                           "ex": c3, "first": c4, "_g": k})
                elif lesson["rows"] and k - lesson["rows"][-1]["_g"] <= 2:
                    r = lesson["rows"][-1]        # 换行续写：接回上一行
                    r["meaning"] += c2
                    r["ex"] += c3
                    r["_g"] = k
                elif c1 and not c3 and not c4:
                    lesson["intro"] += head
                continue
            cA, cB, cC, cD, cE = v                # ---- 格助词总表 ----
            if (cA + cB).startswith("第三部分"):    # 后面是「小词/变形总表」，不在范围内
                stop = True
                break
            if cA and cC and re.match(r"^L\d+$", cC):
                rows.append({"_particle": True, "particle": cA, "usage": cB,
                             "first": cC, "explain": cD, "ex": cE, "_g": k})
            elif (rows and rows[-1].get("_particle")
                  and k - rows[-1]["_g"] <= 2):   # 只在紧邻的续行里补
                t = rows[-1]
                if not cA and not cC:
                    t["explain"] += cD
                    t["ex"] += cE
                    if cB:
                        t["usage"] += cB
                    t["_g"] = k
        if stop:
            break
    lessons = [r for r in rows if not r.get("_particle")]
    particles = [r for r in rows if r.get("_particle")]
    for l in lessons:
        for r in l["rows"]:
            r.pop("_g", None)
    for p in particles:
        p.pop("_particle", None)
        p.pop("_g", None)
    data = {"lessons": lessons, "particles": particles}
    with open(SRC, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print("抽取完成：%d 课 / %d 个语法行 / %d 个助词用法 → %s"
          % (len(lessons), sum(len(l["rows"]) for l in lessons),
             len(particles), SRC))


# ------------------------------------------------------------------ 生成词条

def split_ex(s):
    """'李さんは中国人です。 小李是中国人。' → (日, 中)；
    有些行是词组不是整句（'広い国 幅员辽阔的国家'），按空格切。"""
    s = s.strip()
    m = re.match(r"^(.*?[。？！])\s*(.*)$", s)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.match(r"^(\S+)\s+(.*)$", s)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return s, ""


def formula_of(pattern):
    out = []
    for tok in re.split(r"(＋|／)", pattern):
        if not tok:
            continue
        out.append({"t": tok, "zh": tok in ("＋", "／")})
    return out or [{"t": pattern, "zh": False}]


def build():
    if not os.path.exists(SRC):
        print("缺少 %s，请先跑 --extract" % SRC)
        return 1
    src = json.load(open(SRC, encoding="utf-8"))
    extra = {}
    if os.path.isdir(EXTRA_DIR):
        for name in sorted(os.listdir(EXTRA_DIR)):
            if name.endswith(".json"):
                extra.update(json.load(open(os.path.join(EXTRA_DIR, name),
                                            encoding="utf-8")))
        print("   已载入补充例句 %d 条（%s/*.json）" % (len(extra), EXTRA_DIR))

    chapters, points = [], []
    for l in src["lessons"]:
        no = l["no"]
        chapters.append({"id": "ja_l%02d" % no, "title": "第%d課" % no,
                         "sub": "LESSON %d" % no, "kicker": "标日 · 第%d課" % no})
    chapters.append({"id": "ja_g_particles", "title": "格助词总表",
                     "sub": "PARTICLES", "kicker": "标日 · 格助词总表"})

    for l in src["lessons"]:
        no = l["no"]
        cid = "ja_l%02d" % no
        for i, r in enumerate(l["rows"], 1):
            pid = "ja_g_l%02d_%02d" % (no, i)
            jp, zh = split_ex(r["ex"])
            exs = []
            if jp:
                exs.append({"t": jp, "hl": "", "zh": zh})
            e = extra.get(pid)
            if e and e.get("t") and e.get("zh"):
                exs.append({"t": e["t"], "hl": "", "zh": e["zh"]})
            points.append({
                "id": pid, "lang": "ja", "chapter": cid,
                "kicker": "标日 · 第%d課" % no,
                "title": r["pattern"], "title_sub": r["meaning"] or r["pattern"],
                "formula_label": "句 式 公 式", "formula": formula_of(r["pattern"]),
                "examples": exs, "note_label": "意思 · 怎么用",
                "note": r["meaning"], "page": no,
                "foot": "初级上 · 第%d課" % no,
                "_intro": l["intro"], "_first": r["first"],
            })
            if len(exs) < 2:
                points[-1]["_need_example"] = True

    for i, p in enumerate(src["particles"], 1):
        pid = "ja_g_particle_%02d" % i
        jp, zh = split_ex(p["ex"])
        exs = []
        if jp:
            exs.append({"t": jp, "hl": "", "zh": zh})
        e = extra.get(pid)
        if e and e.get("t") and e.get("zh"):
            exs.append({"t": e["t"], "hl": "", "zh": e["zh"]})
        first = int(re.sub(r"\D", "", p["first"]) or 1)
        points.append({
            "id": pid, "lang": "ja", "chapter": "ja_g_particles",
            "kicker": "标日 · 格助词总表",
            "title": "%s — %s" % (p["particle"], p["usage"]),
            "title_sub": p["usage"],
            "formula_label": "句 式 公 式",
            "formula": [{"t": p["particle"] + "＋" + p["usage"], "zh": False}],
            "examples": exs, "note_label": "意思 · 怎么用",
            "note": p["explain"], "page": first,
            "foot": "初级上 · 格助词总表",
            "_first": p["first"],
        })
        if len(exs) < 2:
            points[-1]["_need_example"] = True

    need = [p["id"] for p in points if p.get("_need_example")]
    half = len(points) // 2
    for name, chunk in (("gram_ja_1", points[:half]), ("gram_ja_2", points[half:])):
        for p in chunk:
            for k in ("_intro", "_first", "_need_example"):
                p.pop(k, None)
        with open(os.path.join(BATCH, name + ".json"), "w", encoding="utf-8") as f:
            json.dump({"chapters": chapters if name == "gram_ja_1" else [],
                       "points": chunk}, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("   %s.json  语法点 %d" % (name, len(chunk)))
    with open("/tmp/ja_grammar_need_example.json", "w", encoding="utf-8") as f:
        json.dump(need, f, ensure_ascii=False, indent=1)
    print("\n== 完成 ==  章节 %d / 语法点 %d / 待补例句 %d"
          % (len(chapters), len(points), len(need)))
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--extract":
        extract(sys.argv[2])
        sys.exit(0)
    sys.exit(build())