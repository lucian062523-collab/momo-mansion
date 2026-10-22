# -*- coding: utf-8 -*-
"""墨墨 · 送礼回话合并（《送出物品后返回主界面触发对应回复》→ dialogues.json）

docx 的结构很好认：

    一、文房·工具类          ← 分类（只用来读，不进数据）
    01 鎏金墨水台            ← 道具标题
    墨墨：台词【惊讶】        ← 墨墨说的话，行尾【】是这一句的表情
    旁白：（三分钟后）        ← 旁白（剧情提示，或末尾那段词源/历史科普）

解出来的形状，key 是 items.json 里的道具 id：

    "送礼回话": {
      "use_inkstand": [
        { "who": "momo", "text": "鎏金……你是bourgeois！", "expr": "惊讶" },
        { "who": "narr", "text": "鎏金（Gilding）工艺源自中国错金银……" }
      ]
    }

道具按**名字**对上 items.json 的 id（只有「樱饼 / 桜餅」一处不同，见 ALIAS）。
用户定：末尾那段科普也一起演；同一件反复送每次都演 —— 都由 gift-talk.js 决定，
这里只负责把文案原样搬进来。

用法：  python3 _tools/merge_gift_lines.py            # 写进 dialogues.json
        python3 _tools/merge_gift_lines.py --dry      # 只看解析结果，不写文件
"""

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "game", "content")
DEFAULT_DOC = os.path.join(ROOT, "文案", "送出物品后返回主界面触发对应回复.docx")

# 文案里的名字 → items.json 的 id：只有这一处对不上
ALIAS = {"樱饼": "桜餅"}

RE_ITEM = re.compile(r"^(\d{2})\s+(.+?)\s*$")
RE_SECTION = re.compile(r"^[一二三四五六七八九十]+、")
RE_SAY = re.compile(r"^墨墨：(.*)$")
RE_NAR = re.compile(r"^旁白：(.*)$")
RE_TAG = re.compile(r"【([^】]+)】\s*$")


def read_docx(path):
    """docx 正文 → 一行一段的字符串列表（只取 w:t，够用且不引依赖）"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    out = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
        txt = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S))
        out.append(re.sub(r"<[^>]+>", "", txt).strip())
    return out


def parse(lines, name2id, alias=None):
    """alias：表情别名（expressions.json 的 aliases）。同一种表情在不同套里文件名不一样，
       统一按主名落库 —— 两边用同一张表，才不会出现「文案写难过、立绘只有悲伤」。"""
    alias = alias or {}
    items, cur, unknown = {}, None, []
    for ln in lines:
        if not ln:
            continue
        m = RE_ITEM.match(ln)
        if m and not RE_SECTION.match(ln) and not ln.startswith("旁白") \
                and not ln.startswith("墨墨"):
            cur = m.group(2).strip()
            items[cur] = []
            continue
        if cur is None:
            continue
        m = RE_SAY.match(ln)
        if m:
            body = m.group(1).strip()
            expr = None
            t = RE_TAG.search(body)
            if t:
                expr = t.group(1).strip()
                expr = alias.get(expr, expr)
                body = body[:t.start()].strip()
            node = {"who": "momo", "text": body}
            if expr:
                node["expr"] = expr
            items[cur].append(node)
            continue
        m = RE_NAR.match(ln)
        if m:
            body = m.group(1).strip()
            # 行尾的 * 是作者标的脚注记号，不是台词的一部分
            body = re.sub(r"\*+$", "", body).strip()
            items[cur].append({"who": "narr", "text": body})
    # 道具名 → id
    out = {}
    for name, nodes in items.items():
        key = ALIAS.get(name, name)
        hit = name2id.get(key)
        if not hit:
            unknown.append(name)
            continue
        if nodes:
            out[hit] = nodes
    return out, unknown


def main():
    dry = "--dry" in sys.argv
    doc = DEFAULT_DOC
    for a in sys.argv[1:]:
        if not a.startswith("--"):
            doc = a
    items_json = json.load(open(os.path.join(CONTENT, "items.json"), encoding="utf-8"))
    name2id = {it["name"]: it["id"] for it in items_json["items"]}

    exp = json.load(open(os.path.join(CONTENT, "expressions.json"), encoding="utf-8"))
    lines = read_docx(doc)
    lines = [l for l in lines if not l.startswith("<w:")]      # 防御：清掉漏网的标记
    talked, unknown = parse(lines, name2id, exp.get("aliases"))

    # 表情名核对：文案里用了、但立绘里根本没有的，会退回该套默认立绘
    known = set()
    for m in exp["sets"].values():
        known.update(m.keys())
    # 「默认」不是某张表情图，是「回该套默认立绘」的哨兵值（见 expressions.json 的 default）
    known.add(exp.get("default", "默认"))
    used = set()
    for nodes in talked.values():
        for n in nodes:
            if n.get("expr"):
                used.add(n["expr"])

    total = sum(len(v) for v in talked.values())
    print("解析：%d 件道具 / %d 行（其中旁白 %d 行）"
          % (len(talked), total,
             sum(1 for v in talked.values() for n in v if n["who"] == "narr")))
    print("道具 id：%s" % "、".join(sorted(talked)))
    if unknown:
        print("!! 对不上 items.json 的标题 %d 个：%s" % (len(unknown), "、".join(unknown)))
    miss = sorted(x for x in used if x not in known)
    print("文案用到的表情 %d 种：%s" % (len(used), "、".join(sorted(used))))
    if miss:
        print("!! 立绘里没有这些表情（会退回默认立绘）：%s" % "、".join(miss))
    extra = sorted(x for x in known if x in used)
    print("（立绘有、文案没用到的：%s）"
          % "、".join(sorted(known - used)))
    if dry:
        for k in sorted(talked)[:2]:
            print("\n--- %s ---" % k)
            for n in talked[k]:
                print("   ", json.dumps(n, ensure_ascii=False))
        return 0

    path = os.path.join(CONTENT, "dialogues.json")
    data = json.load(open(path, encoding="utf-8"))
    data["送礼回话"] = {
        "note": "用户《送出物品后返回主界面触发对应回复》：把道具送出去、回到主画面，"
                "她就这件事说一段话。key = items.json 的道具 id；who=momo 是台词"
                "（expr 不写＝回默认立绘，text 为空＝只做一个表情停顿），who=narr 是旁白"
                "（含末尾那段词源/历史科普）。由 gift-talk.js 组装成临时脚本交给 director 演。"
                "生成物风格的维护方式：改文案改 docx，再跑 _tools/merge_gift_lines.py。",
        **{k: talked[k] for k in sorted(talked)},
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("\n已写入 %s（送礼回话 %d 件）" % (path, len(talked)))
    return 0


if __name__ == "__main__":
    sys.exit(main())