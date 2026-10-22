/* 墨墨 · 临时 NPC 摆位修改器（作者自用）
   打开方式：?test=ch1&edit=1 或 ?edit=1
   拖动立绘 / 滑杆改大小 / 自动存 localStorage: momo.npc.solo.v1
   正常包（不带 edit=1）不加载任何 UI，不影响玩家。 */
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  if (q.get("edit") !== "1") return;
  var KEY = "momo.npc.solo.v1";
  var NAMES = ["月见", "千春", "池田", "茶终", "樱井", "小野", "幸子"];
  var cur = "月见";
  var panel, slider, note, jsonBox;

  function stage() { return document.querySelector('#scr-主画面 .stage'); }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  function soloEl() { return document.querySelector('.party-npc.solo[data-npc="' + cur + '"]'); }
  function refresh() {
    var el = soloEl();
    if (!el) return;
    slider.value = Math.round(el.getBoundingClientRect().width / (stage().getBoundingClientRect().width || 1920) * 100);
    note.textContent = cur + " · 拖动立绘 / 滑杆大小 · 自动保存";
    bind(el);
  }
  function persist() {
    var el = soloEl(); if (!el) return;
    var sr = stage().getBoundingClientRect(), r = el.getBoundingClientRect();
    var o = load();
    o[cur] = {
      cx: (r.left + r.width / 2 - sr.left) / sr.width,
      top: (r.top - sr.top) / sr.height,
      w: r.width / sr.width
    };
    save(o);
    jsonBox.value = JSON.stringify(o, null, 2);
  }
  function bind(el) {
    if (el.__npcEditBound) return;
    el.__npcEditBound = true;
    el.style.pointerEvents = "auto";
    el.style.cursor = "move";
    el.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      var sr = stage().getBoundingClientRect(), r = el.getBoundingClientRect();
      var dx = e.clientX - r.left, dy = e.clientY - r.top;
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      function move(ev) {
        el.style.left = (ev.clientX - dx - sr.left) + "px";
        if (ev.clientY - dy - sr.top < -el.offsetHeight * 0.4) return;
        el.style.top = (ev.clientY - dy - sr.top) + "px";
        persist();
      }
      function up() {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        persist();
      }
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    }, true);
    el.addEventListener("wheel", function (e) {
      e.preventDefault(); e.stopPropagation();
      var sr = stage().getBoundingClientRect();
      var w = el.getBoundingClientRect().width * (e.deltaY > 0 ? 0.98 : 1.02);
      el.style.width = Math.max(80, Math.min(sr.width * 1.6, w)) + "px";
      refresh(); persist();
    }, { passive: false });
  }
  function preview(who) {
    cur = who;
    if (window.MomoParty && MomoParty.stage) MomoParty.stage({ who: who, solo: true });
    setTimeout(function () {
      refresh();
      var el = soloEl();
      if (el) { el.style.pointerEvents = "auto"; }
    }, 120);
  }
  function build() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "npc-editor";
    panel.style.cssText = "position:fixed;right:18px;top:18px;z-index:999999;width:280px;padding:12px 12px 10px;background:linear-gradient(180deg,rgba(28,22,17,.97),rgba(18,14,11,.97));border:1.5px solid #c9a86a;border-radius:10px;color:#f2e6cf;font:13px/1.5 -apple-system,'PingFang SC',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6)";
    var head = document.createElement("div");
    head.textContent = "NPC 摆位修改器（临时）";
    head.style.cssText = "color:#ffd98c;letter-spacing:1px;margin-bottom:8px";
    panel.appendChild(head);
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px";
    NAMES.forEach(function (n) {
      var b = document.createElement("button");
      b.textContent = n; b.style.cssText = "padding:3px 6px;border:1px solid #7a5c38;border-radius:5px;background:#2a2118;color:#e8d7ba;cursor:pointer;font-size:12px";
      b.onclick = function () { preview(n); [].forEach.call(row.children, function (x) { x.style.background = "#2a2118"; }); b.style.background = "#6d4f2b"; };
      row.appendChild(b);
    });
    panel.appendChild(row);
    slider = document.createElement("input");
    slider.type = "range"; slider.min = "30"; slider.max = "160"; slider.value = "90";
    slider.style.cssText = "width:100%;margin:4px 0";
    slider.oninput = function () {
      var el = soloEl(); if (!el) return;
      var sr = stage().getBoundingClientRect();
      el.style.width = (Number(slider.value) / 100 * sr.width) + "px";
      persist();
    };
    panel.appendChild(slider);
    note = document.createElement("div");
    note.style.cssText = "color:#c8b392;margin:2px 0 8px";
    panel.appendChild(note);
    var btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
    function mk(t, fn) {
      var b = document.createElement("button");
      b.textContent = t; b.style.cssText = "padding:4px 8px;border:1px solid #7a5c38;border-radius:5px;background:#33281c;color:#f0dfc2;cursor:pointer;font-size:12px";
      b.onclick = fn; btns.appendChild(b);
    }
    mk("复制坐标", function () {
      persist();
      if (navigator.clipboard) navigator.clipboard.writeText(jsonBox.value).catch(function () {});
      note.textContent = "已复制 " + cur + " 的坐标";
    });
    mk("重置当前", function () {
      var o = load(); delete o[cur]; save(o);
      jsonBox.value = JSON.stringify(o, null, 2);
      if (window.MomoParty) MomoParty.stage({ who: cur, solo: true });
      setTimeout(refresh, 120);
    });
    mk("墨墨参考", function () {
      var m = document.querySelector('#scr-主画面 [data-costume]');
      if (!m) return;
      if (m.classList.contains('sprite-out')) { m.classList.remove('sprite-out'); m.style.opacity = ".35"; }
      else { m.style.opacity = ""; m.classList.add('sprite-out'); }
    });
    mk("关闭", function () { panel.style.display = "none"; });
    panel.appendChild(btns);
    jsonBox = document.createElement("textarea");
    jsonBox.style.cssText = "width:100%;height:92px;margin-top:8px;background:#120e0a;color:#d9c7a6;border:1px solid #5a452e;border-radius:5px;font:11px/1.4 monospace;padding:5px";
    jsonBox.value = JSON.stringify(load(), null, 2);
    panel.appendChild(jsonBox);
    document.body.appendChild(panel);
    preview(cur);
    // 切到下一句时 director 会重建单人立绘：自动重新绑定当前角色
    var mo = new MutationObserver(function () {
      var el = soloEl();
      if (el && !el.__npcEditBound) { bind(el); refresh(); }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
