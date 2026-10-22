#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时工具：只把「学习界面」单独拼成一页，用来快速验证渲染层。
   正式产物仍然是 _tools/build_dist.py 的 dist/index.html。"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, "UI还原")
# 预览页必须放在 css/ 下：common.css / screens.css 里的图片是 '../UI组件/x.png'，
# 内联进 <style> 之后这些相对路径按**文档地址**解析，放在 UI还原/ 根目录就会全 404。
OUT = os.path.join(UI, "css", "_preview.html")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def main():
    src = read(os.path.join(UI, "index.html"))
    # 面板骨架里也有 <section>（记词本/错题集的外层 cell），所以不能用
    # 非贪婪的 </section> 收尾 —— 要按「下一个顶层 section 的开头」来切。
    key = '<section class="screen" id="scr-学习界面"'
    a = src.index(key)
    b = src.index('\n  <section class="screen"', a + len(key))
    section = src[a:b].replace('class="screen"', 'class="screen active"', 1)

    css = "\n".join(read(os.path.join(UI, "css", f))
                    for f in ("common.css", "screens.css", "learn.css"))
    js = "\n".join(read(os.path.join(ROOT, "game", "js", f))
                   for f in ("store.js", "srs.js", "quiz.js", "learn.js"))

    data = {}
    for name, fn in (("words_en", "words_en.json"), ("words_ja", "words_ja.json"),
                     ("grammar_en", "grammar_en.json"), ("grammar_ja", "grammar_ja.json")):
        p = os.path.join(ROOT, "game", "content", fn)
        if os.path.exists(p):
            data[name] = json.load(open(p, encoding="utf-8"))

    # --fixture：语法库还没产出时，用一份临时样本先把「语法页」的排版验证掉
    if "--fixture" in sys.argv:
        for lang, key in (("en", "grammar_en"), ("ja", "grammar_ja")):
            if data.get(key):
                continue
            chs, pts = [], []
            for c in range(1, 13):
                cid = "%s_l%02d" % (lang, c)
                chs.append({"id": cid, "title": "第%d課" % c if lang == "ja" else "第 %d 章" % c,
                            "sub": "LESSON %d" % c, "kicker": "样本 · 第%d課" % c})
                for k in (1, 2):
                    pts.append({
                        "id": "%s_g_l%02d_%d" % (lang, c, k), "lang": lang, "chapter": cid,
                        "kicker": "样本 · 第%d課" % c,
                        "title": "语法点 %d-%d" % (c, k),
                        "title_sub": ("PRESENT PERFECT" if lang == "en" else "テ形 %d" % k),
                        "formula_label": "句 式 公 式",
                        "formula": [{"t": "have / has" if lang == "en" else "～は",
                                     "zh": False},
                                    {"t": "＋", "zh": True},
                                    {"t": "过去分词" if lang == "en" else "～です",
                                     "zh": True}],
                        "examples": [{"t": "I have finished my work." if lang == "en"
                                      else "私は学生です。",
                                      "hl": "have finished" if lang == "en" else "学生",
                                      "zh": "我已经完成了我的工作。" if lang == "en"
                                            else "我是学生。"},
                                     {"t": "She has lived here since 2020." if lang == "en"
                                      else "ここは学校です。",
                                      "hl": "has lived" if lang == "en" else "学校",
                                      "zh": "自 2020 年起她就住在这里。" if lang == "en"
                                            else "这里是学校。"}],
                        "note_label": "辨析 · 与一般过去时",
                        "note": "一般过去时强调<b>过去某时发生</b>；现在完成时强调<b>对现在的影响</b>。",
                        "page": c * 4 + k, "foot": "样本章"
                    })
            data[key] = {"version": 1, "lang": lang, "chapters": chs, "points": pts}

    probe = r"""
<script>
window.__ERR = [];
window.onerror = function (m, s, l, c) { window.__ERR.push(m + " @" + l + ":" + c); };
(function () {
  function q(s, r) { return (r || document).querySelector(s); }
  function qa(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  var TABS = ["wc", "sd", "nb", "gr", "mk", "qz"];
  function box(k) {
    var p = q('#scr-学习界面 .learn-panel[data-learn="' + k + '"]');
    var b = p && p.querySelector(".panel");
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             top: Math.round(r.top), bottom: Math.round(r.bottom),
             right: Math.round(r.right) };
  }
  function go(k) { var t = q('#scr-学习界面 .learn-tab[data-learn="' + k + '"]'); if (t) t.click(); }
  function lang(k) { var t = q('#scr-学习界面 .learn-lang[data-lang="' + k + '"]'); if (t) t.click(); }
  var R = { perTab: {}, jsErrors: window.__ERR };
  try {
    R.momoLearn = !!window.MomoLearn;
    if (!R.momoLearn) { throw new Error("learn.js 没起来"); }
    var st = window.MomoLearn.state();
    R.counts = st.counts;
    R.panels = st.panels; R.tabs = st.tabs.length; R.langs = st.langs.length;
    R.visible = st.visible;

    /* 每块面板都真的点开一次：量盒子 + 收状态 */
    TABS.forEach(function (k) {
      go(k);
      var s = window.MomoLearn.state();
      R.perTab[k] = { box: box(k), state: s };
    });

    /* 练习：答错一题 → 看错题集真的收到 */
    go("qz");
    var a = window.MomoLearn.answer();
    var pick = a === 0 ? 1 : 0;
    var ch = qa('#scr-学习界面 .dr-choice');
    if (ch[pick]) ch[pick].click();
    R.qzWrong = window.MomoLearn.state().qz;
    R.qzFeedback = (q('#scr-学习界面 .dr-fb') || {}).textContent || "";
    go("mk");
    R.mkAfterWrong = window.MomoLearn.state().mk;
    R.mkBox = box("mk");

    /* 背单词：翻面 + 认识/不认识，看 SRS 有没有落档 */
    go("sd");
    var sd1 = window.MomoLearn.state();
    R.sd1 = { running: sd1.sd.running, total: sd1.sd.total, cards: sd1.sd.cards,
              stacks: sd1.sd.stacks, dots: sd1.sd.dots, deck: sd1.sd.deck,
              word: sd1.sd.word, expect: sd1.sdExpect };
    R.sdFromData = !!sd1.sd.word && sd1.sd.word === sd1.sdExpect;
    var card = q('#scr-学习界面 .sd-stage .sd-card');
    if (card) card.click();
    R.sdRevealed = window.MomoLearn.state().sd.revealed;
    var sdWordId = (function () {
      var L = window.MomoStore.state.learn.learned;
      return Object.keys(L).length;
    })();
    q('#scr-学习界面 .sd-btn.ok').click();
    R.sdAfterHit = window.MomoLearn.state().sd;
    R.sdSrsGrew = Object.keys(window.MomoStore.state.learn.learned).length > sdWordId;
    R.sdBox = box("sd");

    /* 记词本筛选：行数应当等于待复习条数（复现 verify 里那条断言） */
    go("nb");
    var nbA = window.MomoLearn.state().nb;
    q('#scr-学习界面 .nb-tab[data-filter="wait"]').click();
    var nbB = window.MomoLearn.state().nb;
    q('#scr-学习界面 .nb-tab[data-filter="all"]').click();
    R.nbProbe = { a: { filter: nbA.filter, rows: nbA.rows, srs: nbA.srs, stat: nbA.stat },
                  b: { filter: nbB.filter, rows: nbB.rows, srs: nbB.srs } };

    /* 日语那一套 */
    lang("ja"); go("wc");
    var sj = window.MomoLearn.state();
    R.ja = { word: sj.wcWord, expect: sj.wcExpect, level: sj.wcLevel, lang: sj.lang };
    go("nb"); R.jaNb = window.MomoLearn.state().nb;
    go("gr"); R.jaGr = window.MomoLearn.state().gr;
    R.jaBoxes = { wc: box("wc"), nb: box("nb"), gr: box("gr") };
    lang("en");

    /* 回到 hash 指定的面板（支持 "ja:sd" 这种「先切语种再看面板」），方便截图 */
    var want = (location.hash || "#wc").slice(1).split(":");
    if (want.length > 1) { lang(want[0]); want = [want[1]]; }
    go(TABS.indexOf(want[0]) >= 0 ? want[0] : "wc");
    R.shownTab = window.MomoLearn.state().tab;
  } catch (e) { R.err = String(e && e.stack || e); }
  R.jsErrors = window.__ERR;
  var d = document.createElement('div'); d.id = '__pv';
  d.textContent = 'PV:' + JSON.stringify(R);
  document.body.appendChild(d);
})();
</script>
"""

    html = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">"
            "<title>学习界面 · 预览</title><style>" + css + "</style>"
            "<script>try{localStorage.setItem('momo.profile',JSON.stringify({name:'\u963f\u58a8'}));}"
            "catch(e){}</script></head><body>"
            + section +
            "<script>window.MOMO_DATA=" + json.dumps(data, ensure_ascii=False) + ";</script>"
            "<script>" + js + "</script>" + probe + "</body></html>")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("写出", OUT, len(html), "字节")

    if "--shot" in sys.argv:
        CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        tabs = sys.argv[sys.argv.index("--shot") + 1:] or ["wc"]
        for t in tabs:
            png = os.path.join(UI, "_preview_%s.png" % t)
            subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                            "--window-size=1920,1080", "--hide-scrollbars",
                            "--virtual-time-budget=15000", "--screenshot=" + png,
                            "file://" + OUT + "#" + t], capture_output=True, timeout=180)
            print("截图", png)
        return 0

    CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    p = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                        "--window-size=1920,1080", "--virtual-time-budget=12000",
                        "--dump-dom", "file://" + OUT], capture_output=True, timeout=180)
    dom = p.stdout.decode("utf-8", "replace")
    mm = re.search(r'<div id="__pv">(.*?)</div>', dom, re.S)
    if not mm:
        print("没拿到探针结果；stderr:", p.stderr.decode("utf-8", "replace")[-500:])
        return 1
    import html as _h
    obj = json.loads(_h.unescape(mm.group(1))[3:])
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())