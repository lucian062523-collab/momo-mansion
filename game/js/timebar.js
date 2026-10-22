/* 墨墨 · 主画面「头像 + 现实时间条」
   底图（UI还原/assets/头像时间条底图.png）里已经画好头像、头像框和「点击头像查看墨墨状态」
   两行提示，这里只负责三个动态文字槽，全部读真实系统时间：
     星期X / YYYY年M月D日 / HH:MM:SS（每秒刷新）
   落位与尺寸在 common.css 的 #scr-主画面 .timebar 里，这里不碰坐标。 */
(function () {
  "use strict";
  var WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  var weekEl = null, dateEl = null, clockEl = null;

  function bind() {
    var scr = document.querySelector('[data-screen="主画面"]');
    if (!scr) return false;
    weekEl = scr.querySelector(".timebar-week");
    dateEl = scr.querySelector(".timebar-date");
    clockEl = scr.querySelector(".timebar-clock");
    return !!(weekEl && dateEl && clockEl);
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function tick() {
    if (!weekEl) return;
    var d = new Date();
    weekEl.textContent = WEEK[d.getDay()];
    dateEl.textContent = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    clockEl.textContent = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  function start() {
    if (!bind()) return false;
    tick();
    clearInterval(start._t);
    start._t = setInterval(tick, 1000);
    /* 后台标签页的 setInterval 会被浏览器节流，切回前台先立刻补一次，
       免得玩家看到的是几分钟前的旧时间 */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) tick();
    });
    return true;
  }

  /* 脚本在 body 末尾，DOM 已解析完，直接初始化即可 ——
     不要挂在 DOMContentLoaded 上：那会晚一拍，任何在同一轮解析里就读它的代码
     （比如自动化验证）会拿到空值。万一以后脚本挪进 head，再兜底重试一次。 */
  if (!start()) document.addEventListener("DOMContentLoaded", start);

  /* 供自动化验证用 */
  window.MomoTimebar = {
    read: function () {
      return {
        week: weekEl ? weekEl.textContent : null,
        date: dateEl ? dateEl.textContent : null,
        clock: clockEl ? clockEl.textContent : null
      };
    }
  };
})();