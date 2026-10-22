#!/usr/bin/env python3
"""Chrome headless 验证：CG 鉴赏页 + 赠送＝购买（扣费/拦截/实时余额/提示）+ 换装同步。

用法：  python3 _tools/verify_items.py
产出：  终端打印每项断言结果，末尾 RESULT: PASS / FAIL
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist", "index.html")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP_HTML = os.path.join(ROOT, "dist", "_verify_page.html")

# 「老玩家存档」回归：模拟用户浏览器里已存在一份旧存档 ——
# cg.unlocked 只有最早的 16 条 id，没有后加的 7 张新 CG。
# 新 CG 必须能被自动补进解锁列表，否则鉴赏页会把它们渲染成占位框（???）。
OLD_CG_IDS = ["shaoyao", "xiazhe", "jinhai", "xianglu", "woli", "shangwu",
              "shuihua", "qiucao", "wangqiu", "nongquan", "yeting", "yuting",
              "xiaokan", "hongxie", "shuihuaer", "kuangquan"]
# 服装侧同样给一个「只有 3 套」的老存档。这 3 套都在免费名单里（每分类前 2 套之一），
# 所以换了「收费解锁」模型之后它们必须还在 —— 购买来的套装不会被退回。
OLD_WARDROBE_IDS = ["life_senxi", "school_initial", "work_lifu"]

SEED_JS = ("<script>try{localStorage.setItem('momo.save.main',JSON.stringify("
           "{version:1,"
           "wardrobe:{worn:'school_initial',unlocked:%s},"
           "cg:{unlocked:%s,viewed:[]},"
           "currency:1000,supplies:60,mood:50,affection:0}));}catch(e){}</script>"
           % (json.dumps(OLD_WARDROBE_IDS, ensure_ascii=False),
              json.dumps(OLD_CG_IDS, ensure_ascii=False)))

TEST_JS = r"""
<script>
(function(){
  function q(s,r){return (r||document).querySelector(s);}
  function qa(s,r){return [].slice.call((r||document).querySelectorAll(s));}
  function lab(el){var l=el.querySelector(".btn-label");return l?l.textContent.replace(/\s+/g,""):"";}
  function goNav(n){var a=q('#nav a[data-nav="'+n+'"]'); if(a)a.click(); return !!a;}
  /* ---- 打字机（2026-10-12 新增）给测试带来的两件事 ----
     演出一行字时现在是逐字显示的，而**演出中的点击语义变了**：
     第一下先把整句补全，第二下才推进到下一句。
     所以凡是「读当前这句的字」或「点一下推进」的地方都得配合它，否则：
       · 刚开演就读文字 → 读到空串（还没打出来）；
       · 点一下想推进 → 只把整句补全了，少走一格。
     两个小工具把这件事收在一处，不散落到几十处断言里。 */
  function settleTyping(){                     /* 只是把当前这句补全，不推进 */
    var D=window.MomoDirector;
    if(D && D.state().typing) q('#scr-主画面').click();
    return !!(D && !D.state().typing);
  }
  function tapAdvance(){                       /* 像玩家那样点：补全（若在打字）+ 推进 */
    settleTyping();
    q('#scr-主画面').click();
  }
  /* 命中测试：程序化 .click() 会绕过 hit-testing，量不到"真鼠标点不到"的 bug
     （之前 .timebar-set 漏了 position:absolute，.click() 全绿、真点却没反应）。
     所以凡热区一律用 elementFromPoint 复核：它必须真的盖在要盖的视觉位置上。 */
  function atPoint(el,x,y){return !!el && document.elementFromPoint(x,y)===el;}
  function atCenter(el){var r=el&&el.getBoundingClientRect();
                        return !!r && atPoint(el,r.left+r.width/2,r.top+r.height/2);}
  /* 图片引用的两种合法形态：单文件模式 = base64 data URI；拆分模式 = assets/ 下的文件。
     断言不该写死其中一种。至于「路径写错 / 文件没拷过去」这类问题，全量核对放在
     下面的 Python 侧（读 dist/index.html 逐个对文件），浏览器里只抽样探几张验真。
     —— 这层分工是这次拆图之后必须补上的：原来的断言只认 data URI，拆分后全变红，
     而它们其实想问的是「图引用得对不对」。 */
  function isRef(u){
    u=u||"";
    if(/^data:image\/webp;base64,/.test(u)) return true;
    /* 注意：getComputedStyle 给的是**解析后的绝对地址**（file:///…/assets/x.webp），
       所以匹配路径里的 /assets/ 而不是开头的 assets/ —— 单文件模式下 data URI
       解析前后一模一样，这个坑一直藏着，拆图之后才露出来。 */
    return /(^|\/)assets\/[^\/]+$/.test(u);
  }
  var PROBE={ok:0,err:0,total:0,bad:[],names:{}};
  function probe(name){
    if(!name || PROBE.names[name]) return;
    PROBE.names[name]=1;
    var u=(window.ASSET_URI||{})[name];
    if(!u){ PROBE.err++; PROBE.bad.push(name+"(无引用)"); return; }
    PROBE.total++;
    var im=new Image();
    im.onload=function(){ PROBE.ok++; };
    im.onerror=function(){ PROBE.err++; PROBE.bad.push(name); };
    im.src=u;
  }
  /* 从内容数据里随便抓一个图片名出来（数据是分类嵌套的，形状各不相同） */
  function firstImg(o){
    var r=null;
    (function w(x){
      if(r||x==null) return;
      if(typeof x==="string"){ if(/\.(webp|png|jpe?g|gif)$/i.test(x)) r=x; return; }
      if(typeof x==="object") for(var k in x){ w(x[k]); if(r) return; }
    })(o);
    return r;
  }
  var R={syncPass:false,openingPass:false,replayPass:false};
  try{
    /* 进主画面会自动播「开场」引入剧情 —— 下面这些断言都要在「没在演出」的常态下量，
       所以先把自动播关掉；开场本身留到文件末尾单独整段跑一遍。 */
    if(window.MomoDirector) window.MomoDirector.setAuto(false);
    /* ================= 姓名录入（开局之前唯一一次）=================
       弹窗是全屏遮罩，会挡住其它所有点击，所以必须先录名字再做后面的断言。 */
    R.nameModalOnLoad=!!document.getElementById("momo-name-mask");
    R.nameEmptyBefore=window.MomoName.get()==="";
    window.MomoName.set("阿墨");
    R.nameStored=window.MomoName.get()==="阿墨";
    R.nameModalClosed=!document.getElementById("momo-name-mask");
    R.namePersistedInProfile=(function(){
      try{ return JSON.parse(localStorage.getItem("momo.profile")).name==="阿墨"; }catch(e){ return false; }
    })();
    var dlg0=q('#scr-主画面 .lL006 .btn-label');
    R.nameInterpolated=!!dlg0 && dlg0.textContent.indexOf("阿墨")>=0 &&
                       dlg0.textContent.indexOf("{{name}}")<0;

    /* ================= CG 鉴赏 ================= */
    var NEW=["shangxuelu","xiawucha","jiaoshibian","ziluolan","lushuiguqin","kuihuahai","jiandie"];
    var cgs=(window.MOMO_DATA.cg||{}).cgs||[];
    R.cgCount=cgs.length;
    var byId={}; cgs.forEach(function(c){byId[c.id]=c;});
    R.newCgMissing=NEW.filter(function(id){return !byId[id];});
    R.newCgRef=NEW.every(function(id){
      var c=byId[id]; return c && isRef(window.ASSET_URI[c.img]);
    });
    probe(byId["jiaoshibian"].img);              /* CG 图探一张 */
    probe(firstImg((window.MOMO_DATA||{}).scenes));     /* 场景图 */
    probe(firstImg((window.MOMO_DATA||{}).wardrobe));   /* 立绘换装 */
    probe(firstImg((window.MOMO_DATA||{}).qmomo));      /* Q 版陪读 */
    probe(firstImg((window.MOMO_DATA||{}).items));      /* 物品图 */
    probe(firstImg((window.MOMO_DATA||{}).expressions));/* 表情图 */
    probe(firstImg((window.MOMO_DATA||{}).cg));         /* CG 数据表 */
    goNav("CG界面");
    var pg=q('#scr-CG界面 [data-glow="pages"][data-name="4"]');
    R.hasPage4=!!pg;
    if(pg) pg.click();
    var frames=[".lL022",".lL024",".lL025",".lL027",".lL028",".lL029"].map(function(c){return q('#scr-CG界面 '+c);});
    var firstArt=frames[0]&&frames[0].querySelector(".cg-art");
    R.cgPage4ArtOk=!!(firstArt && firstArt.style.backgroundImage==='url("'+(window.ASSET_URI[byId["jiaoshibian"].img])+'")');
    var viewBtn=q('#scr-CG界面 .lL031');
    R.viewBtnLabel=viewBtn?lab(viewBtn):"";
    if(viewBtn) viewBtn.click();
    var v=q("#momo-cg-viewer");
    R.viewerName=v?((v.querySelector(".cgv-bar span:nth-child(2)")||{}).textContent||""):"";
    R.viewerOk=!!(v && v.style.display!=="none") && R.viewerName==="教室床边";
    if(v) v.style.display="none";

    /* ================= 赠送 = 购买 ================= */
    var items=(window.MOMO_DATA.items||{}).items||[];
    R.itemCount=items.length;
    R.allHavePrice=items.every(function(i){return typeof i.price==="number"&&i.price>0;});
    goNav("送礼:物品界面");
    var st=window.MomoItems.state();
    R.initCurrency=st.currency;
    R.slotCount=qa('#scr-送礼_物品界面 [data-glow="items"]').length;

    var slots=qa('#scr-送礼_物品界面 [data-glow="items"]');
    slots[0].click();
    var labels=qa("#scr-送礼_物品界面 .lL039 .btn-label").map(function(e){return e.textContent;});
    R.cardDesc=labels[1]||"";
    R.cardHasEffect=/效果/.test(R.cardDesc);
    R.cardHasPrice=/单价/.test(R.cardDesc) && /合计/.test(R.cardDesc);
    R.hasQtyPlaque=/^[1-9]$/.test((labels[2]||"").trim());
    R.hasGiveBtn=!!q("#scr-送礼_物品界面 .card-hit--give");
    R.hasPlus=!!q("#scr-送礼_物品界面 .card-hit--plus");
    R.hasMinus=!!q("#scr-送礼_物品界面 .card-hit--minus");
    /* −／＋：美术原按钮必须保留可见（遮板已撤），热区可点，且不得再叠重复符号 */
    R.covers=qa("#scr-送礼_物品界面 .card-cover").length;
    R.plusHitClickable=getComputedStyle(q("#scr-送礼_物品界面 .card-hit--plus")).pointerEvents==="auto";
    R.minusHitClickable=getComputedStyle(q("#scr-送礼_物品界面 .card-hit--minus")).pointerEvents==="auto";
    R.noDuplicateGlyph=!q("#scr-送礼_物品界面 .card-hit--plus .btn-label") &&
                       !q("#scr-送礼_物品界面 .card-hit--minus .btn-label");
    /* 卡片三个热区也必须真的能被鼠标点到（命中测试，不是程序化 click） */
    R.cardHitsClickable=["minus","plus","give"].every(function(k){
      return atCenter(q("#scr-送礼_物品界面 .card-hit--"+k));
    });
    /* 赠送按钮文字：居中 + 字距收紧 */
    var gl=q("#scr-送礼_物品界面 .card-hit--give .btn-label");
    var gls=gl?getComputedStyle(gl):null;
    R.giveText=gl?gl.textContent:"";
    R.giveCentered=!!gls && gls.justifyContent==="center" && gls.textAlign==="center";
    R.giveLetterSpacing=gls?gls.letterSpacing:"";
    R.giveSpacingTight=!!gls && parseFloat(gls.letterSpacing)<=3;
    /* 赠送按钮热区要正对美术里那块深色牌（实测中心在卡片高度的 85.1%） */
    var cardEl=q("#scr-送礼_物品界面 .lL039");
    var cr=cardEl.getBoundingClientRect();
    var gr=q("#scr-送礼_物品界面 .card-hit--give").getBoundingClientRect();
    R.giveCenterPct=Math.round(((gr.top+gr.height/2)-cr.top)/cr.height*1000)/10;
    R.giveVertCentered=Math.abs(R.giveCenterPct-85.1)<1.5;
    /* 描述文字左右不出框 */
    var descEl=cardEl.querySelectorAll(".btn-label")[1];
    var dr=descEl.getBoundingClientRect();
    R.descLeftPct=Math.round((dr.left-cr.left)/cr.width*1000)/10;
    R.descRightPct=Math.round((dr.right-cr.left)/cr.width*1000)/10;
    R.descFits=R.descLeftPct>=0 && R.descRightPct<=100;
    /* 描述三行：行高要等于卡片相邻横线间距(37px)，且顶对齐（否则离线） */
    R.descLineHeight=descEl.style.lineHeight;
    R.descTopAlign=descEl.style.alignItems==="flex-start";
    R.descWrapped=descEl.getBoundingClientRect().height < 200;  /* 只占 3 行，不会撑高 */
    /* 格子名居中（覆盖 PSD 写死的左对齐） */
    var sl=q('#scr-送礼_物品界面 [data-glow="items"] .btn-label');
    var sls=sl?getComputedStyle(sl):null;
    R.slotNameCentered=!!sls && sls.justifyContent==="center" && sls.textAlign==="center";

    /* 数量步进 + 赠送成功 */
    q("#scr-送礼_物品界面 .card-hit--plus").click();
    q("#scr-送礼_物品界面 .card-hit--plus").click();
    var st3=window.MomoItems.state();
    R.qtyAfterPlus=st3.qty;
    R.costIsUnitTimesQty=st3.cost===st3.price*3;
    var before=JSON.parse(JSON.stringify(window.MomoStore.state));
    q("#scr-送礼_物品界面 .card-hit--give").click();
    var after=window.MomoStore.state;
    R.deductOk=(before.currency-after.currency)===st3.cost;
    R.toastOk=(q("#momo-toast")||{}).className||"";
    R.curReadoutOk=((q("#scr-送礼_物品界面 .item-currency")||{}).textContent||"")
                   .indexOf(String(after.currency))>=0;

    /* 余额不足 → 拦截 */
    window.MomoStore.apply({currency:-999999});
    var low=JSON.parse(JSON.stringify(window.MomoStore.state));
    slots[0].click();
    q("#scr-送礼_物品界面 .card-hit--give").click();
    var lowAfter=window.MomoStore.state;
    R.toastErr=(q("#momo-toast")||{}).className||"";
    R.blockedCurrency=lowAfter.currency===low.currency;
    R.blockedMood=lowAfter.mood===low.mood;
    R.giveDimmed=q("#scr-送礼_物品界面 .card-hit--give").style.opacity==="0.5";

    /* ================= 状态变体按钮：未悬停时的文字色 =================
       全屏扫一遍：每个 .layer.btn[data-variant] 的文字色必须跟着「当前底图」的深浅走 ——
       深色底（按键B / 小条（点击）…）配米白字，浅色底配深棕字。
       这条是盯「拆分产物里中文文件名被百分号编码、syncDark 认不出底图」那个坑的：
       一旦认不出，所有深色底按钮都会挂深棕字（设置屏/音量屏/服装屏撤销 同时出问题）。 */
    R.variantLabelOk=(function(){
      var DARK=/按键B|短小条A|小条（点击）/;
      function nm(bg){
        var m=/url\(["']?(.*?)["']?\)/.exec(bg||""), k=m?m[1]:(bg||""), tb=window.ASSET_PATH_OF||{};
        if(tb[k]) return tb[k];
        try{k=decodeURIComponent(k);}catch(e){}
        return tb[k]||k;
      }
      var bad=[], n=0;
      [].slice.call(document.querySelectorAll(".layer.btn[data-variant]")).forEach(function(t){
        var l=t.querySelector(":scope > .btn-label"); if(!l) return;
        var img=getComputedStyle(t).backgroundImage;
        if(!img||img==="none") return;
        n++;
        var dark=DARK.test(nm(img));
        var col=getComputedStyle(l).color.replace(/\s/g,"");
        if(dark !== (col==="rgb(249,241,233)"))
          bad.push((t.dataset.name||"?")+" 底图深浅="+dark+" 字色="+col);
      });
      R.variantChecked=n; R.variantBad=bad.slice(0,6);
      return n>=10 && bad.length===0;})();

    /* ================= 送礼回话（新文案）+ 新表情立绘 =================
       上面那次赠送（st3.selected）应该已经留了「话头」；回主画面就该把这段演出来。
       演完手动收掉，否则后面几段断言要在「演出中」的常态下量，会被这段挡住。 */
    var giftId=st3.selected;
    var GBOOK=(window.MOMO_DATA.dialogues||{})["送礼回话"]||{};
    var GKEYS=Object.keys(GBOOK).filter(function(k){return k!=="note";});
    R.giftCount=GKEYS.length;
    R.giftLinesTotal=GKEYS.reduce(function(n,k){return n+GBOOK[k].length;},0);
    R.giftEveryItemExists=(function(){
      var ids={}; ((window.MOMO_DATA.items||{}).items||[]).forEach(function(i){ids[i.id]=1;});
      return GKEYS.length>0 && GKEYS.every(function(k){return !!ids[k];});})();
    /* 文案里用到的每个表情都必须在立绘里有 —— 否则那一句会退回默认立绘 */
    R.giftExprsKnown=(function(){
      var EX=(window.MOMO_DATA.expressions||{}).sets||{}, known={"默认":1}, used={};
      Object.keys(EX).forEach(function(k){
        Object.keys(EX[k]).forEach(function(e){known[e]=1;});});
      GKEYS.forEach(function(k){
        GBOOK[k].forEach(function(l){ if(l.expr) used[l.expr]=1; });});
      return Object.keys(used).length>=6 &&
             Object.keys(used).every(function(e){return !!known[e];});})();
    R.giftTodo=window.MomoGiftTalk.ids().length;
    R.giftPendingAfterGive=window.MomoGiftTalk.pending()===giftId;
    /* 节点拼装：只标了表情、没说话的那条要变成一次停顿，不能弹空对话框 */
    R.giftNodes=(function(){
      var n=window.MomoGiftTalk.nodes("food_diet")||[];
      var t=n.map(function(x){return x.type;});
      return t.indexOf("expr")>=0 && t.indexOf("say")>=0 &&
             t.indexOf("narration")>=0 && t[t.length-1]==="end";})();
    R.giftGiftNodeOrder=(function(){
      var n=window.MomoGiftTalk.nodes("use_seal")||[];
      return n[0].type==="say" && n[0].expr==="惊讶" && n[1].type==="narration";})();
    /* 真的演：回到主画面 → 演出开始，第一句就是这件道具的台词 */
    goNav("主画面");
    R.giftPlays=window.MomoDirector.state().playing===true &&
                window.MomoDirector.state().state==="say";
    settleTyping();                       /* 打字机：先让整句落定，再比对文字 */
    var gs=window.MomoDirector.state();
    R.giftFirstLine=(function(){
      var B=GBOOK[giftId]||[];
      R.giftFirstLineId=giftId;
      R.giftFirstLineWant=(B[0]||{}).text;
      R.giftFirstLineGot=gs.dlgText;
      return B.length>0 && gs.dlgText===B[0].text;})();
    R.giftPendingCleared=window.MomoGiftTalk.pending()===null;
    window.MomoDirector.stop();
    R.giftStops=window.MomoDirector.isPlaying()===false;

    /* 新表情：**每一套**立绘都要有 疑惑 / 低头落寞，而且真的画得出来。
       不写死套数 —— 以后再加套装，这条会自己跟着长。 */
    R.exprSets=(function(){
      var EX=(window.MOMO_DATA.expressions||{}).sets||{};
      var sets=((window.MOMO_DATA.wardrobe||{}).sets||[]);
      var U=window.ASSET_URI||{};
      R.exprSetCount=Object.keys(EX).length;
      R.wardrobeSetCount=sets.length;
      R.exprCoversAll=sets.length>=30 && sets.every(function(s){ return !!EX[s.img]; });
      R.exprNewEvery=R.exprCoversAll && sets.every(function(s){
        var m=EX[s.img]; return !!m["疑惑"] && !!m["低头落寞"];});
      R.exprNewRefs=R.exprCoversAll && sets.every(function(s){
        var m=EX[s.img]; return !!U[m["疑惑"]] && !!U[m["低头落寞"]];});
      R.exprSetsBad=sets.filter(function(s){return !EX[s.img];}).slice(0,5)
                        .map(function(s){return s.id;});
      return R.exprSetCount;})();
    /* 《墨墨的新装》两批都必须在衣柜数据里、默认立绘有引用、按名单免/收费。
       套数**不写死** —— 下限由「老 19 + 两批新装的条数」算出来，以后再上批次跟着自己长。 */
    R.newSetsOk=(function(){
      var W=window.MOMO_DATA.wardrobe||{}, U=window.ASSET_URI||{};
      var P=(W.pricing||{}).by_set||{}, F=(W.pricing||{}).free_sets||[];
      var batch1=["life_maoni","life_lengdong","life_lanhua","school_susu","school_yan",
                  "work_qiuli","work_baijiahei","work_yanjingshe","hanfu_susu","hanfu_mimi",
                  "hanfu_heizhen","hanfu_hongsu","hanfu_jiuyu","hanfu_moteng"];
      var batch2=["life_lanzhi","life_dongqing","life_kekoukele","life_zhou","life_songta",
                  "life_haibei","life_baixiang","life_zhu","life_hongque",
                  "school_shuangyan","school_tanjin","school_gangqinjia",
                  "work_waimao","work_shan","work_gelv","work_youqi","work_baijin",
                  "work_zhigeng","work_cangrui",
                  "hanfu_sisi","hanfu_moyu","hanfu_zijing","hanfu_jinhuan","hanfu_zongshi"];
      var m={}; (W.sets||[]).forEach(function(s){m[s.id]=s;});
      var bad=function(ids){ return ids.filter(function(id){
        var s=m[id];
        return !s || !U[s.img] || (F.indexOf(id)<0 && !(P[id]>0)); }); };
      R.newSetsMissing=bad(batch1);
      R.batch2Missing=bad(batch2);
      R.newSetsCount=(W.sets||[]).length;
      R.newSetsFloor=19+batch1.length+batch2.length;
      R.freeSetCount=F.length;
      /* 免费名额 = 每分类免费数 × 分类数（现在 3×4=12），也跟着数据走 */
      R.freeSetWant=(W.pricing&&W.pricing.free_per_category||0)*((W.categories||[]).length);
      R.wardrobeNoDup=(function(){ var seen={},n=0;
        (W.sets||[]).forEach(function(s){ if(seen[s.id]) n++; seen[s.id]=1; }); return n; })()===0;
      /* 每套要么在免费名单里、要么有明确价格 —— 不允许「既不免也不标价」的幽灵套装 */
      R.wardrobeAllPriced=(W.sets||[]).every(function(s){
        return F.indexOf(s.id)>=0 || P[s.id]>0; });
      return R.newSetsMissing.length===0 && R.batch2Missing.length===0 &&
             R.newSetsCount>=R.newSetsFloor && R.freeSetCount===R.freeSetWant &&
             R.wardrobeNoDup && R.wardrobeAllPriced; })();
    /* 别名：同一张「难过脸」，多数套文件名叫 悲伤、简装那套叫 难过 —— 要折到主名上 */
    R.exprAliasOk=(function(){
      var E=window.MOMO_DATA.expressions||{}, j=E.sets&&E.sets["墨墨-简装.webp"];
      return (E.aliases||{})["难过"]==="悲伤" && !!j && j["悲伤"]==="简装-难过.webp";})();
    /* 换上新表情，主画面的立绘真的跟着换图（不只是改了个名字） */
    R.exprRenders=(function(){
      var EX=(window.MOMO_DATA.expressions||{}).sets||{}, U=window.ASSET_URI||{};
      var st0=window.MomoStore.state, img=null;
      ((window.MOMO_DATA.wardrobe||{}).sets||[]).forEach(function(s){
        if(s.id===st0.wardrobe.worn) img=s.img;});
      var want=EX[img]&&EX[img]["疑惑"];
      if(!want||!U[want]) return false;
      window.MomoExpr.set("疑惑");
      var el=q('#scr-主画面 [data-costume]');
      var ok=!!el && el.style.backgroundImage.indexOf(U[want])>=0;
      window.MomoExpr.set("默认");
      return ok;})();
    R.giftPass=!!(R.giftCount===43 && R.giftEveryItemExists && R.giftExprsKnown &&
      R.giftPendingAfterGive && R.giftNodes && R.giftGiftNodeOrder && R.giftPlays &&
      R.giftFirstLine && R.giftPendingCleared && R.giftStops &&
      R.exprCoversAll && R.exprNewEvery && R.exprNewRefs && R.newSetsOk &&
      R.exprAliasOk && R.exprRenders);

    /* 人物屏属性条同步 */
    goNav("人物");
    var byLabel={};
    qa('#scr-人物 [data-value]').forEach(function(v){
      var g=v.closest(".grp"), l=g&&g.querySelector(".btn-label");
      if(l) byLabel[l.textContent.replace(/\s+/g,"")]=v.textContent;
    });
    R.attrsSynced=String(lowAfter.mood)===String(byLabel["心情"]) &&
                  String(lowAfter.supplies)===String(byLabel["物资"]);

    /* 老存档回归：新 CG 必须被自动并入解锁表；服装则相反 ——
       换成「每分类免费前 2 套、其余按价购买」之后，全解锁时代攒下的那 19 套要退回免费名单，
       否则购买流程形同虚设。免费名单里的老套装必须留着（不能连送带买的一起抹掉）。 */
    R.unlockedCg=window.MomoStore.state.cg.unlocked.length;
    R.unlockedWardrobe=window.MomoStore.state.wardrobe.unlocked.length;
    R.freeWardrobeCount=(((window.MOMO_DATA||{}).wardrobe||{}).pricing||{}).free_sets.length;
    R.oldSaveMergedCG=R.unlockedCg>=23;
    /* 这个数组必须跟 Python 侧的 OLD_WARDROBE_IDS 一致（存档里预置的那 3 套） */
    R.oldSaveKeepsFree=["life_senxi","school_initial","work_lifu"].every(function(id){
      return window.MomoStore.state.wardrobe.unlocked.indexOf(id)>=0; });
    R.oldSaveMergedWardrobe=R.unlockedWardrobe===R.freeWardrobeCount && R.oldSaveKeepsFree;

    /* ================= 主画面 · 头像 + 时间条 ================= */
    goNav("主画面");
    /* 对话框文字：左右留白必须对称、且不能越出对话框边框。
       （常态下对话框是收起的，量之前先把它亮出来，否则量到的是 0 比 0 的假绿） */
    R.dlgGeometry=(function(){
      var b=q('#scr-主画面 .lL006'), l=q('#scr-主画面 .lL006 .btn-label');
      if(!b||!l) return false;
      var h=b.classList.contains("is-hidden");
      b.classList.remove("is-hidden");
      var br=b.getBoundingClientRect(), lr=l.getBoundingClientRect();
      R.dlgLeftPad=Math.round(lr.left-br.left);
      R.dlgRightPad=Math.round(br.right-lr.right);
      var ok=br.width>0 && lr.width>0 &&
             Math.abs(R.dlgLeftPad-R.dlgRightPad)<=2 && lr.right<=br.right+1 && lr.left>=br.left-1;
      if(h) b.classList.add("is-hidden");
      return ok;
    })();
    var tb=q('#scr-主画面 .timebar');
    /* 立绘的呼吸：跟学习面板 Q 版同一套起伏，但方向必须**向下** ——
       这张立绘 alpha 从 y=0 起、头顶正好压在画面顶边，上浮会立刻裁掉一块头发。
       这里干脆把它冻在动画最高点量头顶，确认没跑出舞台。 */
    R.mainSpriteBreathe=(function(){
      var el=q('#scr-主画面 [data-costume]'), st=q('#scr-主画面 .stage');
      if(!el||!st) return false;
      var cs=getComputedStyle(el);
      R.mainSpriteAnim=cs.animationName+" "+cs.animationDuration;
      R.mainSpriteBobY=cs.getPropertyValue('--bob-y').trim();
      var prev=el.style.cssText;
      el.style.animationDelay="-1.7s"; el.style.animationPlayState="paused";
      var top=el.getBoundingClientRect().top-st.getBoundingClientRect().top;
      el.style.cssText=prev;
      R.mainSpriteTopAtPeak=Math.round(top*10)/10;
      return cs.animationName!=="none" && parseFloat(cs.animationDuration)>0 &&
             R.mainSpriteBobY.charAt(0)!=="-" && top>=-1;
    })();
    R.hasTimebar=!!tb;
    /* 时钟表上边要和「地」字地图块上边齐平 */
    R.tbTopAlignsMapBtn=(function(){
      var b=q('#scr-主画面 .map-entry'); if(!b||!tb) return false;
      var t=tb.getBoundingClientRect(), m=b.getBoundingClientRect();
      R.tbTopGap=Math.round(t.top-m.top);
      return Math.abs(t.top-m.top)<=1.5;
    })();
    if(tb){
      var tr=tb.getBoundingClientRect(), sr=q('#scr-主画面 .stage').getBoundingClientRect();
      R.tbLeftPct=Math.round((tr.left-sr.left)/sr.width*1000)/10;
      R.tbTopPct=Math.round((tr.top-sr.top)/sr.height*1000)/10;
      R.tbAspect=Math.round(tr.width/tr.height*1000)/1000;
      R.tbArtRef=isRef(
        getComputedStyle(tb).backgroundImage.replace(/^url\(["']?/,"").replace(/["']?\)$/,""));
      probe("头像时间条底图.png");
    }
    R.tbAspectOk=Math.abs((R.tbAspect||0)-3.193)<0.02;
    var T=window.MomoTimebar?window.MomoTimebar.read():{};
    var dd=new Date(), WK=["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
    R.tbWeek=T.week; R.tbDate=T.date; R.tbClock=T.clock;
    R.tbWeekOk=T.week===WK[dd.getDay()];
    R.tbDateOk=T.date===(dd.getFullYear()+"年"+(dd.getMonth()+1)+"月"+dd.getDate()+"日");
    R.tbClockOk=/^\d{2}:\d{2}:\d{2}$/.test(T.clock||"") &&
                Math.abs(parseInt((T.clock||"0").slice(0,2),10)-dd.getHours())<1;
    /* 热区命中测试：头像热区要盖在头像上、星星热区要盖在星星竖条上，且都要落在部件矩形内 */
    var profile=q('#scr-主画面 .timebar-profile'), setHit0=q('#scr-主画面 .timebar-set');
    var tr2=tb?tb.getBoundingClientRect():null;
    if(tr2){
      R.tbProfileHitAtAvatar=atPoint(profile, tr2.left+0.13*tr2.width, tr2.top+0.49*tr2.height);
      R.tbSetHitAtStar=atPoint(setHit0, tr2.left+0.9415*tr2.width, tr2.top+0.49*tr2.height);
    }
    R.tbHitsInsideWidget=(function(){
      if(!tr2) return false;
      function inside(r){return r.left>=tr2.left-1 && r.right<=tr2.right+1 &&
                                r.top>=tr2.top-1 && r.bottom<=tr2.bottom+1;}
      return inside(profile.getBoundingClientRect()) && inside(setHit0.getBoundingClientRect());
    })();
    /* 点头像热区应跳人物屏 */
    profile.click();
    R.tbProfileToPeople=q('[data-screen="人物"]').classList.contains("active");

    /* 右上角原先那个「设置」圆圈按钮 → 已改造为「地图」入口（设置走时间条的小星星） */
    R.setBtnRemoved=qa('#scr-主画面 [data-name="设置"]').length===0;
    R.mapBtnTookOver=(function(){ var b=q('#scr-主画面 .map-entry');
      return !!b && b.dataset.goto==='地图界面'; })();
    var setHit=q('#scr-主画面 .timebar-set');
    R.setHitExists=!!setHit;
    R.setHitGoto=setHit?setHit.dataset.goto:null;
    if(setHit) setHit.click();
    R.setHitToSettings=q('[data-screen="设置界面"]').classList.contains("active");

    /* ================= 主画面 · 对话选择条（默认隐藏，按需弹出） ================= */
    goNav("主画面");
    var cbox=q('#scr-主画面 .lL002');
    R.choiceHiddenByDefault=!!cbox && cbox.classList.contains("is-hidden") &&
                            cbox.getBoundingClientRect().height===0;
    var picked=-1;
    window.MomoChoice.show(["选项甲","选项乙"], function(i){picked=i;});
    var cs=window.MomoChoice.state();
    R.choiceShown=cs.visible && cbox.getBoundingClientRect().height>0;
    R.choiceTextsSet=cs.texts[0]==="选项甲" && cs.texts[1]==="选项乙";
    qa('#scr-主画面 [data-glow="choice"]')[1].click();
    R.choicePickIndex=picked;
    R.choiceHiddenAfterPick=window.MomoChoice.state().visible===false;
    R.choiceGlowCleared=cbox.querySelectorAll(".glowing").length===0;

    /* 存读档屏结构完整性（这次改 index.html 差点误删它的 stage/merged-bg，加一条护栏） */
    R.saveScreenOk=(function(){
      var s=q('[data-screen="存:读档界面"]');
      return !!s && !!s.querySelector(".stage") && !!s.querySelector(".merged-bg") &&
             s.querySelectorAll('[data-glow="saves"]').length===6;
    })();

    /* 换装同步（回归） */
    var COST=qa('[data-costume]').length;
    R.costumeLayers=COST;

    /* ================= 存读档界面（30 档，真数据） ================= */
    goNav("存:读档界面");
    var svSlots=qa('[data-screen="存:读档界面"] [data-glow="saves"]');
    R.saveSlots=svSlots.length;
    R.savePages=qa('[data-screen="存:读档界面"] [data-glow="pages"]').length;
    R.saveEmptyLabel=svSlots[0].querySelectorAll(".btn-label")[0].textContent;
    window.MomoSave.setMode("save");
    svSlots[0].click();
    var rec=JSON.parse(localStorage.getItem("momo.save.slot.0")||"null");
    R.saveWritten=!!rec;
    R.saveNameIsPlayer=!!rec && rec.name==="阿墨";
    R.saveDateShown=/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(
      svSlots[0].querySelectorAll(".btn-label")[1].textContent);
    /* 改数值 → 读档应还原 */
    window.MomoStore.apply({currency:-250});
    var curNow=Math.round(window.MomoStore.state.currency);
    window.MomoSave.setMode("load");
    svSlots[0].click();
    R.loadRestored=Math.round(window.MomoStore.state.currency)===
                   Math.round(rec.data.currency);
    R.loadChanged=curNow!==Math.round(window.MomoStore.state.currency);
    /* 空档：拦下并红字提示，不动数值 */
    var before1=Math.round(window.MomoStore.state.currency);
    svSlots[1].click();
    R.emptySlotBlocked=Math.round(window.MomoStore.state.currency)===before1 &&
                       (q("#momo-toast")||{}).className==="toast-err";
    /* 翻页 */
    q('[data-screen="存:读档界面"] .lL017').click();
    R.savePageTurned=window.MomoSave.state().page===1;

    /* ================= 地图系统 ================= */
    goNav("主画面");
    var mb=q('#scr-主画面 .map-entry');
    R.mapBtnExists=!!mb && mb.getAttribute('data-goto')==='地图界面';
    R.mapBtnVisible=!!mb && mb.offsetParent!==null && mb.getBoundingClientRect().width>0;
    R.mapBtnHitAtCenter=(function(){
      if(!mb) return false;
      var b=mb.getBoundingClientRect();
      var t=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
      return !!t && (t===mb || mb.contains(t));
    })();
    R.starToSettings=(function(){ var s=q('#scr-主画面 .timebar-set');
      return !!s && s.getAttribute('data-goto')==='设置界面'; })();
    /* 「地图」二字要米白（深色圆底上深棕字看不见）；按钮整体缩小一圈 */
    R.mapBtnLabelCream=(function(){ var l=q('#scr-主画面 .map-entry .btn-label');
      if(!l) return false;
      return getComputedStyle(l).color.replace(/\s/g,'')==='rgb(247,243,238)'; })();
    R.mapBtnShrunk=!!mb && mb.offsetWidth<150;
    /* 手工重设计：方形圆角 + 细金边 + 单个「地」字 */
    R.mapBtnLabelText=(function(){ var l=q('#scr-主画面 .map-entry .btn-label');
      return l ? l.textContent.replace(/\s+/g,'') : ''; })()==='地';
    R.mapBtnSquare=(function(){ var b=q('#scr-主画面 .map-entry'); if(!b) return false;
      var cs=getComputedStyle(b);
      return Math.abs(b.offsetWidth-b.offsetHeight)<=1 &&
             parseFloat(cs.borderTopLeftRadius)>=12; })();
    R.mapBtnGoldBorder=(function(){ var b=q('#scr-主画面 .map-entry'); if(!b) return false;
      return getComputedStyle(b).borderTopColor.replace(/\s/g,'')==='rgb(201,168,106)'; })();
    /* 时段判定（真实时钟） */
    R.periodMorning=window.MomoScene.period(new Date(2026,0,1,7,0))==='早晨';
    R.periodNoon=window.MomoScene.period(new Date(2026,0,1,14,0))==='傍晚';
    R.periodNight=window.MomoScene.period(new Date(2026,0,1,22,0))==='夜晚';
    R.periodLateNight=window.MomoScene.period(new Date(2026,0,1,3,0))==='夜晚';
    /* 场景注册表：每个房间在三个时段都要能出图 */
    var S=window.MOMO_DATA.scenes.scenes, rooms=Object.keys(S);
    R.sceneRoomCount=rooms.length;
    R.sceneAllResolvable=rooms.every(function(k){
      return window.MomoScene.periods.every(function(p){ return !!window.MomoScene.resolve([k],p); });
    });
    /* 命名不一致的别名要兜住 */
    R.aliasAmuse=String(window.MomoScene.resolve(['游乐园','游乐场'],'夜晚')).indexOf('游乐场-夜晚')>=0;
    R.aliasObs=String(window.MomoScene.resolve(['观星台','观星室'],'夜晚')).indexOf('观星室-夜晚')>=0;
    /* 地图界面 */
    /* 地图界面不在开发导航栏里（它的真实入口是主界面那个「地图」按钮），
       所以这里走真实路径：点按钮进地图。 */
    function openMap(){ var b=q('#scr-主画面 .map-entry'); if(b) b.click(); return !!b; }
    R.mapOpenByButton=openMap() && q('#scr-地图界面').classList.contains('active');
    var ms=window.MomoMap.state();
    R.mapShown=ms.shown;
    R.mapHotspots=ms.hotspots;
    R.mapTabs=ms.tabs.length;
    R.mapTabOn=ms.tabs.filter(function(t){return t.on;}).length===1;
    R.mapHitOk=ms.hitOk;
    /* 标签页切换 */
    q('#scr-地图界面 .map-tab[data-floor="OUT"]').click();
    var ms2=window.MomoMap.state();
    R.mapTabSwitch=ms2.shown==='OUT' && ms2.hotspots===15;
    /* 楼梯：F1→F2 循环 */
    q('#scr-地图界面 .map-tab[data-floor="F1"]').click();
    q('#scr-地图界面 .map-hit--stair').click();
    R.mapStairF1toF2=window.MomoMap.state().shown==='F2';
    /* 点房间 → 记下房间/楼层 + 回主画面 + 主画面出图 */
    q('#scr-地图界面 .map-tab[data-floor="F3"]').click();
    var hit=q('#scr-地图界面 .map-hit[data-room="茶歇间"]');
    R.mapRoomHitExists=!!hit;
    if(hit) hit.click();
    R.mapRoomStored=window.MomoStore.state.room==='茶歇间' && window.MomoStore.state.floor==='F3';
    R.mapBackToMain=q('#scr-主画面').classList.contains('active');
    var sc=window.MomoScene.state();
    R.sceneApplied=String(sc.url)===String(window.MomoScene.resolve(['茶歇间'], sc.period));
    R.sceneOneLayer=sc.layers.a!==sc.layers.b;      /* 交叉淡入淡出：恰好一层点亮 */
    /* 切场景的四拍（用户定死的顺序）：场景图 → 旁白（点一下走一句）→ 立绘淡入 →
       有概率她说一句（点一下收起）→ 收起一切。顺序先照节点表断一遍（不靠概率碰运气），
       再把真跑的过程量下来。 */
    R.sceneInScript=(function(){
      var k=window.MomoIdle.sceneNodes("茶歇间").map(function(n){return n.type;});
      var k2=window.MomoIdle.sceneNodes("玄关").map(function(n){return n.type;});
      R.sceneInKinds=k; R.sceneInKinds2=k2;
      var iRev=k.indexOf("reveal"), iSay=k.indexOf("say");
      return k[0]==="narration" &&                      /* ① 先旁白 */
             iRev>0 && (iSay<0 || iSay>iRev) &&         /* ② 立绘排在旁白之后 */
             k[k.length-1]==="end" &&                   /* ③ 收尾 */
             k2[0]==="narration" && k2[1]==="narration" && k2[2]==="reveal";  /* 两句旁白都在立绘前 */
    })();
    /* 真跑：① 旁白弹出来（对话框收起、立绘还藏着） */
    settleTyping();                       /* 打字机：先让旁白整句落定再读 */
    R.sceneInNarShown=(function(){
      var s=window.MomoDirector.state();
      R.sceneInNarDbg={state:s.state,nar:s.narVisible,dlg:s.dlgVisible,
                       sceneIn:s.sceneIn,text:(s.narText||"").slice(0,30)};
      return s.state==="narration" && s.narVisible===true && s.dlgVisible===false &&
             s.narText.indexOf("铁壶")>=0 && s.sceneIn===true; })();
    R.sceneInSpriteHidden=(function(){
      var el=q('#scr-主画面 [data-costume]');
      return !!el && el.classList.contains('sprite-out') &&
             getComputedStyle(el).opacity==='0' &&
             window.MomoDirector.state().sceneIn===true; })();
    R.sceneInBoxHidden=window.MomoDirector.state().dlgVisible===false;
    tapAdvance();                                   /* 点一下：旁白收，轮到她登场
                                                       （打字机下要两下，见 tapAdvance） */
    R.sceneInNarGone=window.MomoDirector.state().narVisible===false;
    R.sceneInSpriteRevealed=(function(){
      var el=q('#scr-主画面 [data-costume]');
      return !!el && !el.classList.contains('sprite-out') &&
             window.MomoDirector.state().sceneIn===false; })();
    window.MomoDirector.stop();                     /* 把这段临时脚本收干净，别留给后面的用例 */

    /* ================= 主画面 · 常态点墨墨（日常台词 + 小星星）=================
       点她本人 = 蹦一句日常台词 + 她周围迸小星星；再点一下收起。连击第 4 次起进
       「越点越炸毛」那一档。 */
    var hitArea=q('#scr-主画面 .momo-hit');
    R.idleHitExists=!!hitArea;
    R.idleHitAtSprite=(function(){
      /* 热区必须真盖在她的身子上（真鼠标点得到，不是程序化 .click() 的假绿） */
      var el=q('#scr-主画面 [data-costume]'), st=q('#scr-主画面 .stage');
      if(!el||!st||!hitArea) return false;
      var sb=st.getBoundingClientRect(), k=sb.width/1920;
      var x=sb.left+(el.offsetLeft+el.offsetWidth/2)*k;
      var y=sb.top+(el.offsetTop+el.offsetHeight*0.3)*k;
      return document.elementFromPoint(x,y)===hitArea; })();
    R.idleHitClearOfUi=(function(){
      /* 右上角的「地 / 学」入口、左上角时间条的头像与星星热区都不该被它抢走 */
      return atCenter(q('#scr-主画面 .map-entry')) &&
             atCenter(q('#scr-主画面 .learn-entry')) &&
             atCenter(q('#scr-主画面 .timebar-profile')) &&
             atCenter(q('#scr-主画面 .timebar-set')); })();
    /* 日常台词池：结构后来重排过（场景/时段挪进了「生活」，另外多了「状态」「旧」），
       所以这里按**代码实际读的那几个池子**验，而不是记死旧的键名。
       池子空了不会报错，只是墨墨反复说同一句 —— 典型的静默退化，必须卡住。 */
    R.idleDailyPool=(function(){
      var DL=(window.MOMO_DATA||{}).dialogues||{};
      var D=DL["日常"]||{}, G=D["通用"]||{}, LIFE=D["生活"]||{}, S=D["状态"]||{};
      function lines(o){ return Object.keys(o||{}).filter(function(k){return k!=="note";})
                           .reduce(function(n,k){ return n+((o[k]||[]).length); },0); }
      R.idleSceneCount=Object.keys(LIFE["场景"]||{}).length;
      R.idlePeriodCount=Object.keys(LIFE["时段"]||{}).length;
      R.idleStateCount=Object.keys(S).filter(function(k){return k!=="note";}).length;
      R.idleTierLines=lines(G);                       /* 通用按好感分档：低/中/高 */
      R.idleNarRooms=Object.keys((DL["场景旁白"]||{}).map||{}).length;
      return R.idleSceneCount>=12 && R.idlePeriodCount>=4 && R.idleStateCount>=4 &&
             R.idleTierLines>=6 && R.idleNarRooms>=6 &&
             (D["连击"]||[]).length>=3 && (D["彩蛋"]||[]).length>=3 &&
             (D["旧"]||[]).length>=8; })();
    /* 点一下：出一句 + 迸星星，而且**不能**被同一次点击立刻收掉 */
    hitArea.click();
    var s1=window.MomoDirector.state();
    R.idleSaysLine=s1.state==="say" && s1.dlgVisible===true && s1.plateVisible===true &&
                  s1.plateText==="墨 墨";
    R.idleLineIsDaily=(function(){
      var l=window.MomoIdle.state().lastLine;
      var DL=(window.MOMO_DATA||{}).dialogues||{};
      /* 这些池子层层嵌套（日常/生活/场景/茶歇间、通用/低·中·高、状态/…、旁白/map/房间），
         每变一次结构就要跟着改一遍摊平代码 —— 干脆递归收全部字符串。
         note 是注释键，跳过。 */
      var all=[];
      (function collect(o){
        if(typeof o==="string"){ all.push(o); return; }
        if(Object.prototype.toString.call(o)==="[object Array]"){
          o.forEach(collect); return;
        }
        if(o && typeof o==="object"){
          Object.keys(o).forEach(function(k){ if(k!=="note") collect(o[k]); });
        }
      })(DL["日常"]||{});
      (function collect(o){
        Object.keys(o||{}).forEach(function(k){
          (o[k]||[]).forEach(function(s){ if(typeof s==="string") all.push(s); });
        });
      })((DL["场景旁白"]||{}).map||{});
      R.idleLastLine=l;                              /* 失败时能一眼看出她说的是哪句 */
      R.idlePoolTotal=all.length;
      return !!l && all.indexOf(l)>=0; })();
    R.idleSparks=window.MomoIdle.state().sparks>0;
    R.idleSparksLayerFree=(function(){
      /* 星星层是纯装饰：绝不许挡住点击 */
      var l=q('#scr-主画面 .spark-layer');
      return !l || getComputedStyle(l).pointerEvents==="none"; })();
    /* 连击：第 4 次起进第 4~6 档 */
    R.idleComboLine=(function(){
      /* 用 tapAdvance 而不是裸 click：打字机下第一下只是补全整句，
         不补这一下每次点击都会少走一句，连击计数自然对不上（曾经量到 3）。 */
      function dismiss(){ if(window.MomoDirector.state().state==="say") tapAdvance(); }
      dismiss();
      for(var i=0;i<3;i++){ hitArea.click(); dismiss(); }      /* 第 2、3、4 次 */
      hitArea.click();                                          /* 第 5 次，仍旧在 4~6 档内 */
      var seg=(((window.MOMO_DATA||{}).dialogues||{})["日常"]||{}).连击[0];
      var st=window.MomoIdle.state();
      R.idleComboDbg={combo:st.combo,last:(st.lastLine||"").slice(0,40),
                      segMin:seg.min,segMax:seg.max,
                      inSeg:seg.lines.indexOf(st.lastLine)>=0};
      var ok=st.combo>=4 && seg.lines.indexOf(st.lastLine)>=0;
      dismiss();
      tapAdvance();                 /* 把最后一句也收干净，好让下面的「回到常态」成立 */
      return ok; })();
    R.idleBackToRest=!window.MomoDirector.isPlaying() &&
                     window.MomoDirector.state().dlgVisible===false;
    /* 还没画场景的房间：拦下 + 红字，不改房间 */
    openMap();
    q('#scr-地图界面 .map-tab[data-floor="F1"]').click();
    var rmBefore=window.MomoStore.state.room;
    q('#scr-地图界面 .map-hit[data-room="阳台"]').click();
    R.noSceneBlocked=window.MomoStore.state.room===rmBefore &&
                     (q("#momo-toast")||{}).className==="toast-err";

    /* ================= 学习面板 ================= */
    goNav("主画面");
    var le=q('#scr-主画面 .learn-entry');
    R.learnBtnExists=!!le && le.getAttribute('data-goto')==='学习界面';
    R.learnBtnLabelText=(function(){ var l=q('#scr-主画面 .learn-entry .btn-label');
      return l ? l.textContent.replace(/\s+/g,'') : ''; })()==='学';
    R.learnBtnLabelCream=(function(){ var l=q('#scr-主画面 .learn-entry .btn-label');
      return !!l && getComputedStyle(l).color.replace(/\s/g,'')==='rgb(247,243,238)'; })();
    /* 和「地」字地图入口必须同款同尺寸（用户要求「大小样式与地图入口一样」） */
    R.learnBtnSameStyle=(function(){
      if(!le||!mb) return false;
      var a=getComputedStyle(le), b=getComputedStyle(mb);
      return le.offsetWidth===mb.offsetWidth && le.offsetHeight===mb.offsetHeight &&
             a.borderTopLeftRadius===b.borderTopLeftRadius &&
             a.borderTopColor===b.borderTopColor &&
             a.backgroundColor===b.backgroundColor &&
             a.borderTopWidth===b.borderTopWidth &&
             le.offsetLeft===mb.offsetLeft; })();
    /* 就在地图入口正下方：同一左边界、间隔 12px */
    R.learnBtnBelowMap=(function(){
      if(!le||!mb) return false;
      var a=le.getBoundingClientRect(), b=mb.getBoundingClientRect();
      return Math.abs(a.left-b.left)<=1 && Math.abs(a.top-(b.bottom+12))<=1; })();
    R.learnBtnHitAtCenter=atCenter(le);
    /* 主画面氛围光尘 —— **作者 2026-10-12 要求撤掉**（「有点像灰尘」），
       motes.js 已从 build_dist 的 SRC_JS 里注释掉。
       所以这里不再要求它「在画东西」，改验两条仍然成立的事：
         ① 光尘**要么没启用、要么启用且画得对**（以后想恢复，这个开关一开就自动接着验）；
         ② 不管启用与否，那张画布都不许吃掉点击 —— 它是最容易犯的错
            （pointer-events 没设 none，整块热区就被一层看不见的画布盖住）。 */
    R.mainMotes=(function(){
      var c=q('#scr-主画面 .motes');
      var st=window.MomoMotes&&window.MomoMotes.state();
      R.motesScript=!!st;
      if(!c) return !st;                      /* 画布都没了：那就该是没脚本在跑 */
      R.motesPointer=getComputedStyle(c).pointerEvents;
      var r=c.getBoundingClientRect(), sr=q('#scr-主画面 .stage').getBoundingClientRect();
      R.motesOnStage=Math.abs(r.width-sr.width)<=1 && Math.abs(r.height-sr.height)<=1;
      var el=document.elementFromPoint(Math.round(r.left+r.width/2),
                                       Math.round(r.top+r.height/2));
      R.motesTop=el?(el.className||el.tagName):'';
      R.motesPassThrough=!!el && el!==c && !el.classList.contains('motes');
      if(!st) {  /* 未启用：只需要它铺满舞台、且不挡点击 */
        return R.motesPointer==='none' && R.motesOnStage && R.motesPassThrough;
      }
      R.motesCount=st.count; R.motesSize=st.size; R.motesLit=st.lit;
      R.motesDrawn=st.drawn; R.motesAnimated=st.animated;
      /* 均匀：横向每一列都得有光点 —— 不能「只有半边有」 */
      R.motesColumns=st.columns;
      R.motesEven=!!st.columns && st.columns.length>0 &&
                  st.columns.every(function(n){return n>0;});
      return !!(st.drawn && st.count>0 && st.pointer==='none' &&
                st.size[0]===1920 && st.size[1]===1080 &&
                R.motesEven && R.motesOnStage && R.motesPassThrough);
    })();
    /* 真实入口进学习界面（学习界面不在开发导航栏里） */
    R.learnOpenByButton=(function(){ if(le) le.click();
      return !!le && q('#scr-学习界面').classList.contains('active'); })();
    /* 学习状态存在 localStorage 里，Chrome 复用配置目录时会带到下一次运行 ——
       先清成确定状态再断言，否则「这个词还没练过」这类判断会因历史数据随机失败。 */
    window.MomoStore.state.learn = { lang:'en', learned:{}, starred:{en:[],ja:[]},
                                     wrong:{en:[],ja:[]}, grammar:{en:[],ja:[]} };
    window.MomoStore.save();
    q('#scr-学习界面 .learn-lang[data-lang="en"]').click();
    q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
    var ls=window.MomoLearn.state();
    R.learnPanels=ls.panels;
    R.learnTabs=ls.tabs.length;
    R.learnLangs=ls.langs.length;
    R.learnTabOn=ls.tabs.filter(function(t){return t.on;}).length===1;
    R.learnLangOn=ls.langs.filter(function(t){return t.on;}).length===1;
    R.learnVisible=ls.visible;
    R.learnHitOk=ls.hitOk;
    /* Q 版陪读小人：面板一进来就该有图，且是「还没自评」的常态脸 */
    R.learnQcInit=(function(){
      var q=ls.qc||{};
      R.qcKeys=Object.keys(q);
      return !!q.wc && q.wc.has && !!q.sd && q.sd.has;
    })();
    R.learnQcDefaultFace=(ls.qc.wc||{}).file===((window.MOMO_DATA||{}).qmomo||{})["default"];

    /* --- 面板是「活」的：内容来自词库，不是写死的样例 --- */
    R.learnWordCountEn=ls.counts.en;
    R.learnWordCountJa=ls.counts.ja;
    R.learnGrammarEn=ls.counts.grammar_en;
    R.learnGrammarJa=ls.counts.grammar_ja;
    R.learnWcFromData=!!ls.wcWord && ls.wcWord===ls.wcExpect && ls.wcId.length>0;
    R.learnWcLevelEn=/雅思/.test(ls.wcLevel);
    /* 翻面 */
    q('#scr-学习界面 #wordCardWrap').click();
    R.learnFlipOn=q('#scr-学习界面 .flip-wrap').classList.contains('flipped');
    q('#scr-学习界面 #wordCardWrap').click();
    R.learnFlipOff=!q('#scr-学习界面 .flip-wrap').classList.contains('flipped');
    /* 星标／收入记词本 落存档 */
    q('#scr-学习界面 #starBtn').click();
    R.learnStarred=window.MomoLearn.state().starred===1;
    q('#scr-学习界面 #starBtn').click();
    R.learnUnstarred=window.MomoLearn.state().starred===0;
    /* 三档自评 → SRS 落档（这是「活」的关键：自评真的改了下一次到期日） */
    var wcId0=window.MomoLearn.state().wcId;
    R.learnNoSrsYet=!window.MomoStore.state.learn.learned[wcId0];
    q('#scr-学习界面 .wc-g[data-grade="2"]').click();
    R.learnSrsWritten=(function(){ var r=window.MomoStore.state.learn.learned[wcId0];
      return !!r && r.interval>=1 && r.seen>=1 && r.correct>=1 && !!r.due; })();
    /* 一次「记得」interval=1，还不够 7 天，所以不算掌握 —— 掌握判定得是真的 */
    R.learnNotMasteredYet=!window.MomoSRS.isMastered(wcId0);
    R.learnCardAdvanced=window.MomoLearn.state().wcId!==wcId0;

    /* --- 词库检索面板：单词卡片左边那一栏，英语按首字母 --- */
    R.learnWcTocEn=(function(){
      var box=q('#scr-学习界面 .learn-panel[data-learn="wc"] .lesson-toc');
      var s=window.MomoLearn.state();
      R.wcTocEnVisible=s.wcTocVisible;
      R.wcTocEnLetters=box?box.querySelectorAll('button[data-scope]').length:0;
      var a=box?box.querySelector('button[data-scope="A"]'):null;
      R.wcTocEnHasA=!!a;
      if(a) a.click();
      var s2=window.MomoLearn.state();
      R.wcTocEnFiltered=s2.wcScope==='A' && s2.wcShown>0 &&
        s2.wcShown<window.MOMO_DATA.words_en.length && /^a/i.test(s2.wcWord);
      R.wcTocEnWord=s2.wcWord;
      var all=box?box.querySelector('button[data-scope=""]'):null;
      if(all) all.click();
      R.wcTocEnReset=window.MomoLearn.state().wcShown===window.MOMO_DATA.words_en.length;
      return !!(R.wcTocEnVisible && R.wcTocEnHasA && R.wcTocEnLetters>20 &&
                R.wcTocEnFiltered && R.wcTocEnReset);
    })();
    /* 搜索框：打一个词只剩它一个；清空后恢复全量 */
    R.learnWcSearchEn=(function(){
      var inp=q('#scr-学习界面 .learn-panel[data-learn="wc"] .wc-search');
      if(!inp) return false;
      inp.value='abandon';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      var s=window.MomoLearn.state();
      var ok=s.wcShown===1 && s.wcId==='en_abandon';
      inp.value='';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return ok && window.MomoLearn.state().wcShown===window.MOMO_DATA.words_en.length;
    })();

    /* --- 背单词：卡组来自词库，翻面/认识落 SRS，进度点跟着走 --- */
    q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
    var sd1=window.MomoLearn.state();
    R.learnSdFromData=sd1.sd.running && sd1.sd.total>0 &&
                      !!sd1.sd.word && sd1.sd.word===sd1.sdExpect;
    R.learnSdCards=sd1.sd.cards===3 && sd1.sd.stacks===2;
    R.learnSdDots=sd1.sd.dots===sd1.sd.total && sd1.sd.dotsNow===1;
    R.learnSdNoTocEn=sd1.lessons.sd.visible===false;      /* 英语没有课次结构，目录要藏起来 */
    var sdCard=q('#scr-学习界面 .sd-stage .sd-card');
    if(sdCard) sdCard.click();
    R.learnSdFlip=window.MomoLearn.state().sd.revealed;
    var sdBef=Object.keys(window.MomoStore.state.learn.learned).length;
    q('#scr-学习界面 .sd-btn.ok').click();
    var sd2=window.MomoLearn.state();
    R.learnSdHit=sd2.sd.hit===1 && sd2.sd.dotsHit===1 && sd2.sd.marks[0]==='hit';
    R.learnSdSrs=(function(){
      var r=window.MomoStore.state.learn.learned[sd1.sdId];
      return Object.keys(window.MomoStore.state.learn.learned).length>sdBef && !!r; })();

    /* --- 记词本：数字与 SRS 统计一致 --- */
    q('#scr-学习界面 .learn-tab[data-learn="nb"]').click();
    var nb1=window.MomoLearn.state().nb;
    R.learnNbStats=nb1.stat[0]===nb1.srs[0] && nb1.stat[1]===nb1.srs[1] && nb1.stat[2]===nb1.srs[2];
    R.learnNbRows=nb1.rows>0;
    R.learnNbSeals=nb1.seals.length>0 && nb1.seals.every(function(s){return !!s;});
    R.learnNbHasLearned=nb1.srs[1]+nb1.srs[2]>0;
    q('#scr-学习界面 .nb-tab[data-filter="wait"]').click();
    var nb2=window.MomoLearn.state().nb;
    R.learnNbFilter=nb2.filter==='wait' && nb2.rows<=nb1.rows && nb2.rows===nb1.srs[2];
    q('#scr-学习界面 .nb-tab[data-filter="all"]').click();
    R.learnNbFilterBack=window.MomoLearn.state().nb.rows===nb1.rows;

    /* --- 语法页：目录 = 语法点总数，点目录能换详情 --- */
    q('#scr-学习界面 .learn-tab[data-learn="gr"]').click();
    var gr1=window.MomoLearn.state().gr;
    R.learnGrToc=gr1.tocButtons===gr1.points && gr1.points>0 && gr1.chapters>0;
    R.learnGrDetail=!!gr1.title && gr1.title!=='—' && gr1.examples>=2 && gr1.onCount===1;
    var gb=qa('#scr-学习界面 .learn-panel[data-learn="gr"] .gr-toc button')[1];
    if(gb) gb.click();
    R.learnGrSwitch=!!gb && window.MomoLearn.state().gr.title!==gr1.title &&
                    window.MomoLearn.state().gr.onCount===1;

    /* --- 练习：真的组题、真的判分、真的写错题集、答错零惩罚 --- */
    q('#scr-学习界面 .learn-tab[data-learn="qz"]').click();
    var qz1=window.MomoLearn.state().qz;
    R.learnQzBuilt=qz1.running && qz1.total>0 && qz1.choices===4;
    R.learnQzVariants=qz1.kinds.length>0 &&
                      qz1.kinds.every(function(k){return k;});
    var cur0=window.MomoStore.state.currency, sup0=window.MomoStore.state.supplies,
        aff0=window.MomoStore.state.affection;
    var ai=window.MomoLearn.answer();
    var wrongIdx=ai===0?1:0;
    qa('#scr-学习界面 .dr-choice')[wrongIdx].click();
    R.learnQzWrongMarked=!!q('#scr-学习界面 .dr-choice.bad') && !!q('#scr-学习界面 .dr-choice.ok');
    R.learnQzWrongCounted=window.MomoLearn.state().qz.wrong===1;
    R.learnQzNoPenalty=window.MomoStore.state.currency===cur0 &&
                       window.MomoStore.state.supplies===sup0 &&
                       window.MomoStore.state.affection===aff0;
    R.learnQzWrongStored=(function(){ var w=window.MomoStore.state.learn.wrong;
      return !!w && (w[window.MomoLearn.state().lang]||[]).length===1; })();
    R.learnQzFeedback=q('#scr-学习界面 .dr-fb').textContent.replace(/\s+/g,'').length>6;
    /* 下一题 */
    q('#scr-学习界面 .dr-btn[data-act="next"]').click();
    var qz2=window.MomoLearn.state().qz;
    R.learnQzNext=qz2.index===1 && qz2.choices===4 && !q('#scr-学习界面 .dr-choice.bad');

    /* --- 错题集：真实错题渲染出来，并且能移出 --- */
    q('#scr-学习界面 .learn-tab[data-learn="mk"]').click();
    var mk1=window.MomoLearn.state().mk;
    R.learnMkFromWrong=mk1.stored===1 && mk1.rendered===1 && mk1.count===1;
    var dropB=q('#scr-学习界面 .learn-panel[data-learn="mk"] [data-act="drop"]');
    if(dropB) dropB.click();
    R.learnMkDrop=window.MomoLearn.state().mk.stored===0;
    q('#scr-学习界面 .learn-tab[data-learn="mk"]').click();

    /* --- 语种切换：整组换成另一套系统，SRS 各自独立 --- */
    q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
    q('#scr-学习界面 .learn-lang[data-lang="ja"]').click();
    var js1=window.MomoLearn.state();
    R.learnLangSwitched=js1.lang==='ja' && js1.langs[1].on===true &&
                        js1.langs.filter(function(t){return t.on;}).length===1;
    R.learnJaCard=!!js1.wcWord && js1.wcWord===js1.wcExpect && /标日/.test(js1.wcLevel);
    /* 检索面板换成日语那一套：按课次，全部 + 第1課~第24課 */
    R.learnWcTocJa=(function(){
      var box=q('#scr-学习界面 .learn-panel[data-learn="wc"] .lesson-toc');
      var s=window.MomoLearn.state();
      R.wcTocJaButtons=box?box.querySelectorAll('button[data-scope]').length:0;
      R.wcTocJaField=/按课/.test((q('#scr-学习界面 .learn-panel[data-learn="wc"] .gr-toc h4')||{}).textContent||'');
      var b1=box?box.querySelector('button[data-scope="1"]'):null;
      R.wcTocJaHasL1=!!b1;
      if(b1) b1.click();
      var s2=window.MomoLearn.state();
      R.wcTocJaShown=s2.wcShown;
      R.wcTocJaL1Total=window.MOMO_DATA.words_ja.filter(function(w){return w.lesson===1;}).length;
      R.wcTocJaFiltered=s2.wcScope===1 && s2.wcShown>0 &&
        s2.wcShown<window.MOMO_DATA.words_ja.length && /第1課/.test(s2.wcLevel);
      var all=box?box.querySelector('button[data-scope="0"]'):null;
      if(all) all.click();
      R.wcTocJaReset=window.MomoLearn.state().wcShown===window.MOMO_DATA.words_ja.length;
      return !!(s.wcTocVisible && R.wcTocJaField && R.wcTocJaButtons===25 && R.wcTocJaHasL1 &&
                R.wcTocJaFiltered && R.wcTocJaShown===R.wcTocJaL1Total && R.wcTocJaReset);
    })();
    R.learnJaTabs=js1.tabs.length===6 && js1.tabs.filter(function(t){return t.on;}).length===1;
    q('#scr-学习界面 .learn-tab[data-learn="nb"]').click();
    R.learnJaNbRows=window.MomoLearn.state().nb.rows>0;
    /* 日语下「背单词」和「练习」都要出课次目录：全部 + 24 課，且只有一个是选中态 */
    q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
    var sdJa=window.MomoLearn.state();
    R.learnSdTocJa=sdJa.lessons.sd.visible===true && sdJa.lessons.sd.buttons===25 &&
                   sdJa.lessons.sd.on===1 && sdJa.lessons.sd.selected===0;
    var b3=q('#scr-学习界面 .learn-panel[data-learn="sd"] [data-lesson="3"]');
    if(b3) b3.click();
    var sdJa2=window.MomoLearn.state();
    R.learnSdLesson=sdJa2.lessons.sd.selected===3 && sdJa2.lessons.sd.on===1 &&
                    sdJa2.sd.total>0 && sdJa2.sd.total<=20 && sdJa2.sd.deck.indexOf("3")>=0;
    q('#scr-学习界面 .learn-tab[data-learn="qz"]').click();
    var qzJa=window.MomoLearn.state();
    R.learnQzTocJa=qzJa.lessons.qz.visible===true && qzJa.lessons.qz.buttons===25 &&
                   qzJa.lessons.qz.on===1;
    var qb5=q('#scr-学习界面 .learn-panel[data-learn="qz"] [data-lesson="5"]');
    if(qb5) qb5.click();
    var qzJa2=window.MomoLearn.state();
    R.learnQzLesson=qzJa2.lessons.qz.selected===5 && qzJa2.qz.running &&
                    qzJa2.qz.total>0 && qzJa2.qz.choices===4;
    q('#scr-学习界面 .learn-tab[data-learn="gr"]').click();
    var grJa=window.MomoLearn.state().gr;
    R.learnJaGrammar=grJa.points>0 && grJa.tocButtons===grJa.points && grJa.examples>=2;
    /* 两套系统必须各自独立：在日语里自评一次，只该多出一条 ja_ 记录，
       英语那条 en_ 记录原样还在，两边的错题集也不互相污染 */
    q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
    var jaId=window.MomoLearn.state().wcId;
    var enIdsBefore=Object.keys(window.MomoStore.state.learn.learned)
                       .filter(function(k){return k.indexOf('en_')===0;});
    q('#scr-学习界面 .wc-g[data-grade="2"]').click();
    R.learnJaSeparateSrs=(function(){
      var L=window.MomoStore.state.learn;
      var jaNow=Object.keys(L.learned).filter(function(k){return k.indexOf('ja_')===0;});
      var enNow=Object.keys(L.learned).filter(function(k){return k.indexOf('en_')===0;});
      return !!L.learned[jaId] && L.learned[jaId].seen>=1 &&
             jaNow.length===1 && enNow.length===enIdsBefore.length; })();
    R.learnJaWrongIsolated=(window.MomoStore.state.learn.wrong.ja||[]).length===0 &&
                           (window.MomoStore.state.learn.wrong.en||[]).length===0;
    /* 切回英语，状态要回来 */
    q('#scr-学习界面 .learn-lang[data-lang="en"]').click();
    R.learnLangBack=window.MomoLearn.state().lang==='en';

    /* ================= 学习界面 · 版面：让开顶部导航栏 + 卡片上下居中 ================= */
    R.learnTabsClearNav=(function(){
      var t=q('#scr-学习界面 .learn-tabs'), n=q('#nav');
      if(!t||!n) return false;
      var tb=t.getBoundingClientRect(), nb=n.getBoundingClientRect();
      R.learnTabsTop=Math.round(tb.top); R.learnNavBottom=Math.round(nb.bottom);
      /* 导航栏已经不进产物（默认 hidden）→ 没有「被它压住」的问题；
         本地带 ?dev 时它才出现，那会儿标签仍然要让开。 */
      return nb.height===0 || tb.top>=nb.bottom-0.5; })();
    /* 开发导航栏默认必须是隐藏的 —— 玩家不该看到那排直达按钮（带 ?dev 才显示） */
    R.navHidden=(function(){ var n=q('#nav'); return !!n && n.getBoundingClientRect().height===0; })();
    /* 第一块内容（.cell）的矩形：顺手把面板亮出来，否则量到的是 0 */
    function cellRect(key){
      var p=q('#scr-学习界面 .learn-panel[data-learn="'+key+'"]');
      if(!p) return null;
      var on=p.classList.contains('on'); p.classList.add('on');
      var first=null;
      for(var i=0;i<p.children.length;i++){ if(p.children[i].offsetHeight>0){ first=p.children[i]; break; } }
      var r=first?{ box:first.getBoundingClientRect(), panel:p.getBoundingClientRect() }:null;
      if(!on) p.classList.remove('on');
      return r;
    }
    R.learnCardCentered=(function(){
      var st=q('#scr-学习界面 .stage'), b=cellRect('wc');
      if(!st||!b) return false;
      var sb=st.getBoundingClientRect(), eb=b.box;
      R.learnCardCtr=Math.round((eb.top+eb.bottom-sb.top-sb.bottom)/2);
      R.learnCardBox=[Math.round(eb.top),Math.round(eb.bottom)];
      return eb.height>0 && Math.abs(R.learnCardCtr)<=12 &&
             eb.top>=sb.top-1 && eb.bottom<=sb.bottom+1; })();
    /* 居中是靠 auto 边距做的：内容比面板高时它会退化成 0（内容照常从顶部滚），
       绝不能反过来把内容顶部顶到面板外面 —— 那样上面那半永远滚不到。
       逐块面板确认「第一块内容的顶边没跑到面板顶边之上」。 */
    function cellTop(key){
      var p=q('#scr-学习界面 .learn-panel[data-learn="'+key+'"]');
      if(!p) return null;
      var on=p.classList.contains('on'); p.classList.add('on');
      var first=null;
      for(var i=0;i<p.children.length;i++){ if(p.children[i].offsetHeight>0){ first=p.children[i]; break; } }
      var r={ top: first?Math.round(first.getBoundingClientRect().top-p.getBoundingClientRect().top):null,
              over: p.scrollHeight-p.clientHeight };
      if(!on) p.classList.remove('on');
      return r;
    }
    function clipCheck(keys){
      var bad=[];
      keys.forEach(function(k){
        var r=cellTop(k);
        if(!r||r.top===null){ bad.push(k+':none'); return; }
        R['cellTop_'+k]=r.top; R['over_'+k]=r.over;
        if(r.top<-1) bad.push(k+':top'+r.top);
      });
      return bad;
    }
    R.learnNoClip=(function(){ R.learnClipBad=clipCheck(['wc','sd','nb','gr','mk','qz']);
      return R.learnClipBad.length===0; })();
    /* 日语下「背单词 / 练习」多一列课次目录，是最高的那种版式，也要没被顶出去 */
    R.learnNoClipJa=(function(){
      q('#scr-学习界面 .learn-lang[data-lang="ja"]').click();
      R.learnClipBadJa=clipCheck(['wc','sd','qz','gr']);
      q('#scr-学习界面 .learn-lang[data-lang="en"]').click();
      return R.learnClipBadJa.length===0; })();

    /* ================= 学习界面 · Q 版陪读小人（卡片右侧，约卡片高度的 3/4）================= */
    var QM=(window.MOMO_DATA||{}).qmomo||{};
    var qcFace=function(k){ var s=window.MomoLearn.state().qc||{}; return (s[k]||{}).file||''; };
    function qcGeom(key, cardSel){
      var p=q('#scr-学习界面 .learn-panel[data-learn="'+key+'"]');
      var el=p&&p.querySelector('.qc-momo'), card=p&&p.querySelector(cardSel);
      if(!el||!card) return null;
      var on=p.classList.contains('on'); p.classList.add('on');
      var eb=el.getBoundingClientRect(), cb=card.getBoundingClientRect();
      var st=q('#scr-学习界面 .stage').getBoundingClientRect();
      var r={ gap:Math.round(eb.left-cb.right), ratio:Math.round(eb.height/cb.height*1000)/1000,
              w:Math.round(eb.width), h:Math.round(eb.height),
              /* 卡片自己（不是「卡片+Q版」那一整组）离屏幕中心差多少 */
              cardOff:Math.round(cb.left+cb.width/2-(st.left+st.width/2)),
              /* 横向溢出：Q 版挂在卡片右侧，不能顶出面板让人出横向滚动条 */
              overX:p.scrollWidth-p.clientWidth,
              inside:eb.right<=p.getBoundingClientRect().right+1 };
      if(!on) p.classList.remove('on');
      return r;
    }
    R.learnQcWcGeom=(function(){
      var g=qcGeom('wc','.flip-wrap'); if(!g) return false;
      R.qcWc=g;
      /* Q 版在卡片右侧（gap）、约卡片高度的 3/4、卡片自己正中、不顶出面板 */
      return g.w>0 && g.gap>=4 && g.gap<=90 && Math.abs(g.ratio-0.75)<=0.06 &&
             Math.abs(g.cardOff)<=6 && g.overX<=1 && g.inside; })();
    R.learnQcSdGeom=(function(){
      /* 先点开背单词页：课次目录的显隐是「渲染时按当前语种」定的，
         不切过去的话量的还是上一次日语留下的可见目录（量出来的卡片会偏） */
      q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
      var g=qcGeom('sd','.study');
      q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
      if(!g) return false;
      R.qcSd=g;
      return g.w>0 && g.gap>=4 && g.gap<=90 && Math.abs(g.ratio-0.75)<=0.06 &&
             Math.abs(g.cardOff)<=6 && g.overX<=1 && g.inside; })();
    /* 日语下左边多一列课次目录：卡片不要求居中，但 Q 版绝不能顶出面板 */
    R.learnQcSdJaFits=(function(){
      q('#scr-学习界面 .learn-lang[data-lang="ja"]').click();
      q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
      var g=qcGeom('sd','.study');
      q('#scr-学习界面 .learn-lang[data-lang="en"]').click();
      q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
      if(!g) return false;
      R.qcSdJa=g;
      return g.overX<=1 && g.inside; })();
    R.learnQcRef=(function(){
      var el=q('#scr-学习界面 .learn-panel[data-learn="wc"] .qc-momo');
      var m=el&&/^url\(["']?(.*?)["']?\)/.exec(el.style.backgroundImage||"");
      return !!m && isRef(m[1]); })();
    /* 落影 + 呼吸动画：脚下那块软边椭圆要真的在，而且它和立绘各自都有自己的动画
       （立绘浮起、影子反向缩淡，两个都动才有「浮在空中」的感觉） */
    R.learnQcShadow=(function(){
      var p=q('#scr-学习界面 .learn-panel[data-learn="wc"]');
      var el=p&&p.querySelector('.qc-momo');
      if(!el) return false;
      var on=p.classList.contains('on'); p.classList.add('on');
      var cs=getComputedStyle(el), sa=getComputedStyle(el,"::after");
      R.qcShadow={anim:cs.animationName+" "+cs.animationDuration,
                  shadow:sa.animationName+" "+sa.animationDuration,
                  w:sa.width, h:sa.height, bottom:sa.bottom,
                  bg:sa.backgroundImage.slice(0,24)};
      if(!on) p.classList.remove('on');
      return cs.animationName!=="none" && parseFloat(cs.animationDuration)>0 &&
             sa.animationName!=="none" && parseFloat(sa.animationDuration)>0 &&
             parseFloat(sa.width)>0 && parseFloat(sa.height)>0 &&
             sa.backgroundImage.indexOf("gradient")>=0;
    })();

    /* —— 自评 → 表情：记得/认识=积极池；忘了/模糊/不认识=消极池 —— */
    q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
    var G=function(g){ return q('#scr-学习界面 .learn-panel[data-learn="wc"] .wc-g[data-grade="'+g+'"]'); };
    if(G(2)) G(2).click();
    R.learnQcGood=QM.positive.indexOf(qcFace('wc'))>=0;
    /* 多按几次：必须一直在积极池里，而且要会换脸（不是写死一张） */
    var qcSeen=[];
    for(var qk=0; qk<14; qk++){ if(G(2)) G(2).click(); qcSeen.push(qcFace('wc')); }
    R.learnQcGoodPool=qcSeen.every(function(f){return QM.positive.indexOf(f)>=0;}) &&
                      qcSeen.filter(function(f,i){return qcSeen.indexOf(f)===i;}).length>1;
    if(G(0)) G(0).click();
    R.learnQcForget=QM.negative.indexOf(qcFace('wc'))>=0;
    if(G(1)) G(1).click();
    R.learnQcFuzzy=QM.negative.indexOf(qcFace('wc'))>=0;      /* 模糊也算消极 */
    /* 背单词那两个按钮走同一个出口 sdAdvance（键盘 ←→ 也走它） */
    q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
    var MISS=q('#scr-学习界面 .learn-panel[data-learn="sd"] [data-act="miss"]');
    var HIT=q('#scr-学习界面 .learn-panel[data-learn="sd"] [data-act="hit"]');
    var REST=q('#scr-学习界面 .learn-panel[data-learn="sd"] [data-act="restart"]');
    if(MISS) MISS.click();
    R.learnQcSdMiss=QM.negative.indexOf(qcFace('sd'))>=0;
    /* 飞牌动画期间 sdAdvance 会 busy 挡掉连点，所以重开一轮再验另一个方向 */
    if(REST) REST.click();
    if(HIT) HIT.click();
    R.learnQcSdHit=QM.positive.indexOf(qcFace('sd'))>=0;
    R.learnQcPoolsOk=QM.positive.length>=3 && QM.negative.length>=3 &&
                     QM.positive.every(function(f){return QM.negative.indexOf(f)<0;});

    /* 作用域隔离：令牌挂在面板自己身上，没有漏到全局 :root */
    R.learnScopedTokens=(function(){
      var p=q('#scr-学习界面 .learn-panel[data-learn="wc"]');
      if(!p) return false;
      return getComputedStyle(p).getPropertyValue('--gold').trim()!==''; })();
    R.learnNoGlobalLeak=getComputedStyle(document.documentElement)
                          .getPropertyValue('--gold').trim()==='';
    /* 5 块面板各自的 Kit 都生效（.panel 有金边；各组件独有节点在） */
    R.learnKitsApplied=(function(){
      var ok=true;
      ['wc','sd','nb','gr','mk','qz'].forEach(function(k){
        var p=q('#scr-学习界面 .learn-panel[data-learn="'+k+'"] .panel');
        if(!p || getComputedStyle(p).borderTopColor.replace(/\s/g,'')!=='rgb(115,79,58)') ok=false;
      });
      return ok && !!q('#scr-学习界面 .learn-panel[data-learn="wc"] #wordCardWrap') &&
             !!q('#scr-学习界面 .learn-panel[data-learn="nb"] .nb-list') &&
             !!q('#scr-学习界面 .learn-panel[data-learn="gr"] .gr-formula') &&
             !!q('#scr-学习界面 .learn-panel[data-learn="mk"] .mk-wax') &&
             !!q('#scr-学习界面 .learn-panel[data-learn="sd"] .sd-stage') &&
             !!q('#scr-学习界面 .learn-panel[data-learn="qz"] .dr-choices'); })();
    R.learnBackToMain=(function(){ var b=q('#scr-学习界面 .learn-back');
      if(b) b.click(); return q('#scr-主画面').classList.contains('active'); })();

    /* ================= 剧情回放 + 开屏两个入口 · 结构（行为在末尾异步验） ================= */
    R.replayViewport=(function(){
      var s=q('[data-screen="回放界面"]'), v=q('#scr-回放界面 .rp-viewport');
      if(!s||!v) return false;
      /* 回放界面此刻没显示，量之前先临时点亮它（量完还回去） */
      var wasOn=s.classList.contains('active');
      s.classList.add('active');
      var b=v.getBoundingClientRect();
      R.replayBox=[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)];
      R.replayOverflowY=getComputedStyle(v).overflowY;
      /* 滑动范围必须锁在面板的羊皮纸内区里（那张面板图的内框约 504..1412 × 248..803） */
      var ok=R.replayOverflowY==='auto' && b.width>0 &&
             b.left>=480 && b.right<=1480 && b.top>=230 && b.bottom<=880;
      if(!wasOn) s.classList.remove('active');
      return ok; })();
    R.replayHasEmptyEl=!!q('#scr-回放界面 .rp-viewport .rp-empty');
    R.openingBtns=(function(){
      var a=q('#scr-开屏 [data-name="新的开始"]'), b=q('#scr-开屏 [data-name="继续旅程"]');
      R.newGoto=a?a.getAttribute('data-goto'):null;
      R.contGoto=b?b.getAttribute('data-goto'):null;
      R.newLabel=a?a.textContent.replace(/\s+/g,''):'';
      R.contLabel=b?b.textContent.replace(/\s+/g,''):'';
      return !!a && !!b; })();
    /* 继续旅程 = 接着当前存档走，不该再绕一趟存档界面 */
    R.contGoesMain=R.contGoto==='主画面';
    /* 按钮文字也要跟语义对上：这枚是「继续旅程」，不能写成「开始旅程」 */
    R.contLabelOk=R.contLabel==='继续旅程' && R.newLabel==='新的故事';

    /* ================= 开场引入 · 结构（演出行为在文件末尾异步整段验） ================= */
    R.dlgHasScript=!!window.MomoDirector &&
                   window.MomoDirector.scripts().indexOf("开场")>=0;
    R.dlgSayNodes=(function(){
      var s=((window.MOMO_DATA||{}).dialogues||{}).脚本||{};
      s=s["开场"];
      if(!s||!s.nodes) return 0;
      return s.nodes.filter(function(n){return n.type==="say";}).length; })();
    /* 旁白底条：深咖啡棕 → 透明的渐变，贴画面最底端，文字与对话框正文左右对齐 */
    R.narrationCss=(function(){
      var n=q('#scr-主画面 .narration');
      return !!n && getComputedStyle(n).backgroundImage.indexOf("gradient")>=0; })();
    R.narrationGeom=(function(){
      var n=q('#scr-主画面 .narration'), sr=q('#scr-主画面 .stage');
      var box=q('#scr-主画面 .lL006');
      var a=q('#scr-主画面 .narration .btn-label'), b=box?box.querySelector('.btn-label'):null;
      if(!n||!sr||!box||!a||!b) return false;
      /* 这一对在常态下都是收起的，量尺寸前两个都得亮出来（只亮一个会量出 0 宽度） */
      var hidN=n.classList.contains("is-hidden"), hidD=box.classList.contains("is-hidden");
      n.classList.remove("is-hidden");
      box.classList.remove("is-hidden");
      var nr=n.getBoundingClientRect(), sr2=sr.getBoundingClientRect();
      var ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
      R.narPadL=Math.round(ar.left-br.left);
      R.narPadR=Math.round(br.right-ar.right);
      R.narBottomGap=Math.round(sr2.bottom-nr.bottom);
      /* 舞台是等比缩放的，量出来的像素要除掉缩放才是设计值 */
      R.narHeight=Math.round(nr.height/(sr2.height/1080));
      if(hidN) n.classList.add("is-hidden");
      if(hidD) box.classList.add("is-hidden");
      /* 两个标签都得真的渲染出来，否则「左右对齐」是 0 比 0 的假绿 */
      return ar.width>0 && br.width>0 &&
             Math.abs(R.narPadL)<=2 && Math.abs(R.narPadR)<=2 &&
             Math.abs(R.narBottomGap)<=1 && R.narHeight===200; })();
    /* 点一下推进：演出中对话框/旁白条必须真的能被鼠标点到 */
    R.dlgClickableWhenLive=(function(){
      var sc=q('#scr-主画面'), el=q('#scr-主画面 .lL006'), was=sc.classList.contains("dlg-live");
      sc.classList.add("dlg-live");
      var pe=getComputedStyle(el).pointerEvents;
      if(!was) sc.classList.remove("dlg-live");
      return pe==="auto"; })();

    R.syncPass = R.cgCount===23 && R.newCgMissing.length===0 && R.newCgRef && R.hasPage4 &&
             R.cgPage4ArtOk && R.viewBtnLabel==="查看" && R.viewerOk &&
             R.itemCount===51 && R.allHavePrice && R.slotCount===12 &&
             R.cardHasEffect && R.cardHasPrice && R.hasQtyPlaque &&
             R.hasGiveBtn && R.hasPlus && R.hasMinus &&
             R.covers===0 && R.plusHitClickable && R.minusHitClickable && R.noDuplicateGlyph &&
             R.giveCentered && R.giveSpacingTight && R.giveVertCentered &&
             R.descFits && R.descLineHeight==="37px" && R.descTopAlign && R.slotNameCentered &&
             R.qtyAfterPlus===3 && R.costIsUnitTimesQty && R.deductOk &&
             R.toastOk==="toast-ok" && R.curReadoutOk &&
             R.toastErr==="toast-err" && R.blockedCurrency && R.blockedMood && R.giveDimmed &&
             R.attrsSynced && R.costumeLayers>=2 && R.oldSaveMergedCG && R.oldSaveMergedWardrobe &&
             R.navHidden &&
             R.giftPass && R.variantLabelOk &&
             R.hasTimebar && R.tbTopAlignsMapBtn && R.tbArtRef && R.tbAspectOk && R.tbWeekOk && R.tbDateOk &&
             R.tbClockOk && R.tbProfileToPeople && R.saveScreenOk &&
             R.choiceHiddenByDefault && R.choiceShown && R.choiceTextsSet &&
             R.choicePickIndex===1 && R.choiceHiddenAfterPick && R.choiceGlowCleared &&
             R.setBtnRemoved && R.mapBtnTookOver && R.setHitExists && R.setHitGoto==="设置界面" && R.setHitToSettings &&
             R.tbProfileHitAtAvatar && R.tbSetHitAtStar && R.tbHitsInsideWidget &&
             R.cardHitsClickable &&
             R.nameModalOnLoad && R.nameEmptyBefore && R.nameStored && R.nameModalClosed &&
             R.namePersistedInProfile && R.nameInterpolated && R.dlgGeometry &&
             R.mainSpriteBreathe &&
             R.saveSlots===6 && R.savePages===5 && R.saveEmptyLabel==="空档位" &&
             R.saveWritten && R.saveNameIsPlayer && R.saveDateShown &&
             R.loadRestored && R.loadChanged && R.emptySlotBlocked && R.savePageTurned &&
             R.mapBtnExists && R.mapBtnVisible && R.mapBtnHitAtCenter && R.starToSettings && R.mapOpenByButton &&
             R.mapBtnLabelCream && R.mapBtnShrunk && R.mapBtnLabelText && R.mapBtnSquare && R.mapBtnGoldBorder &&
             R.periodMorning && R.periodNoon && R.periodNight && R.periodLateNight &&
             R.sceneRoomCount>=42 && R.sceneAllResolvable && R.aliasAmuse && R.aliasObs &&
             R.mapHotspots>0 && R.mapTabs===4 && R.mapTabOn && R.mapHitOk && R.mapTabSwitch &&
             R.mapStairF1toF2 && R.mapRoomHitExists && R.mapRoomStored && R.mapBackToMain &&
             R.sceneInSpriteHidden && R.sceneInBoxHidden && R.sceneInSpriteRevealed &&
             R.sceneInScript && R.sceneInNarShown && R.sceneInNarGone &&
             /* 常态点墨墨：日常台词 + 小星星 + 连击分档 */
             R.idleHitExists && R.idleHitAtSprite && R.idleHitClearOfUi && R.idleDailyPool &&
             R.idleSaysLine && R.idleLineIsDaily && R.idleSparks && R.idleSparksLayerFree &&
             R.idleComboLine && R.idleBackToRest &&
             R.sceneApplied && R.sceneOneLayer && R.noSceneBlocked &&
             R.learnBtnExists && R.learnBtnLabelText && R.learnBtnLabelCream &&
             R.learnBtnSameStyle && R.learnBtnBelowMap && R.learnBtnHitAtCenter &&
             R.mainMotes &&
             R.learnOpenByButton && R.learnPanels===6 && R.learnTabs===6 && R.learnTabOn &&
             R.learnLangs===2 && R.learnLangOn &&
             R.learnVisible===1 && R.learnHitOk &&
             /* 词库/语法库规模 —— 用户要求「只有这些词可不行」 */
             R.learnWordCountEn>=600 && R.learnWordCountJa>=800 &&
             R.learnGrammarEn>=100 && R.learnGrammarJa>=50 &&
             R.learnWcFromData && R.learnWcLevelEn &&
             R.learnWcTocEn && R.learnWcSearchEn &&
             R.learnFlipOn && R.learnFlipOff && R.learnStarred && R.learnUnstarred &&
             /* 自评 / 筛选 / 组卷 / 判分 / 错题集 整条链路 */
             R.learnNoSrsYet && R.learnSrsWritten && R.learnNotMasteredYet && R.learnCardAdvanced &&
             /* 背单词（V5 新增）：卡组、翻面、进度点、SRS 落档 */
             R.learnSdFromData && R.learnSdCards && R.learnSdDots && R.learnSdNoTocEn &&
             R.learnSdFlip && R.learnSdHit && R.learnSdSrs &&
             R.learnNbStats && R.learnNbRows && R.learnNbSeals && R.learnNbHasLearned &&
             R.learnNbFilter && R.learnNbFilterBack &&
             R.learnGrToc && R.learnGrDetail && R.learnGrSwitch &&
             R.learnQzBuilt && R.learnQzVariants && R.learnQzWrongMarked &&
             R.learnQzWrongCounted && R.learnQzWrongStored && R.learnQzFeedback &&
             /* 答错零惩罚（硬规则）：答错不许扣任何数值 */
             R.learnQzNoPenalty &&
             R.learnQzNext && R.learnMkFromWrong && R.learnMkDrop &&
             /* 两个语种是两套独立系统 */
             R.learnLangSwitched && R.learnJaCard && R.learnWcTocJa && R.learnJaTabs && R.learnJaNbRows &&
             /* 日语按课选：背单词选卡组、练习选出题范围（就像语法页那份目录） */
             R.learnSdTocJa && R.learnSdLesson && R.learnQzTocJa && R.learnQzLesson &&
             R.learnJaGrammar && R.learnJaSeparateSrs && R.learnJaWrongIsolated && R.learnLangBack &&
             R.learnScopedTokens && R.learnNoGlobalLeak && R.learnKitsApplied &&
             R.learnBackToMain &&
             /* 学习界面版面（让开导航栏 + 卡片居中不被裁）+ Q 版陪读小人 */
             R.learnTabsClearNav && R.learnCardCentered && R.learnNoClip && R.learnNoClipJa &&
             R.learnQcInit && R.learnQcDefaultFace && R.learnQcWcGeom && R.learnQcSdGeom &&
             R.learnQcSdJaFits &&
             R.learnQcRef && R.learnQcShadow && R.learnQcGood && R.learnQcGoodPool && R.learnQcForget &&
             R.learnQcFuzzy && R.learnQcSdMiss && R.learnQcSdHit && R.learnQcPoolsOk &&
             /* 开场引入（结构部分；整段演出行为在末尾异步验） */
             R.dlgHasScript && R.dlgSayNodes>=30 &&
             R.narrationCss && R.narrationGeom && R.dlgClickableWhenLive &&
             /* 剧情回放 + 开屏两个入口（结构部分） */
             R.replayViewport && R.replayHasEmptyEl && R.openingBtns && R.contGoesMain && R.contLabelOk;
  }catch(e){R.error=String(e&&e.stack||e);R.syncPass=false;}

  var d=document.createElement("div");
  d.id="__momo_test";
  document.body.appendChild(d);
  /* 先落一份「还没跑完」的结果：异步段没跑完就绝不放行 —— 宁可红，不要假绿 */
  function report(){ R.pass=!!(R.syncPass&&R.openingPass&&R.replayPass&&R.ecoPass); d.textContent="TESTRESULT:"+JSON.stringify(R); }
  report();

  /* ================= 开场引入：整段真跑一遍 =================
     演出里的表情停留（hold）走定时器，同步跑不完，所以这整段放在最后异步收尾。
     驱动的节奏跟玩家一样：每次 tick 看当前是台词还是旁白，点一下让它走下一行。 */
  (function opening(){
    var dlgEl=q('#scr-主画面 .lL006'), narEl=q('#scr-主画面 .narration');
    var bars=qa('#scr-主画面 [data-glow="choice"]');
    var EX=((window.MOMO_DATA||{}).expressions||{}).sets||{};
    var wantYan=window.ASSET_URI[(EX["墨墨（初始立绘）.webp"]||{})["欲言又止"]];
    var bad=[], ticks=0, lines=0, lastSay=null;
    var sawYan=false, sawNar=false, sawNarText=false, sawNarBox=false,
        sawPlayer=false, sawMomo=false, sawChoice=false, exprYan=false, exprReset=null;
    function st(){ return window.MomoDirector.state(); }
    function note(k,v){ v=!!v; if(!v) bad.push(k); return v; }

    /* 数值从固定起点量，别受前面测试影响。好感有 0 下限（LIMITS.affection），
       从 0 再减看不出效果，所以先垫到 20 再验 A 分支的 -10/-5。
       注意 MomoStore.state 是**活引用**，这里必须把数字抄出来存，不能存对象，
       否则演完它已经跟着变了，拿它算期望值就成了「现在的值 - 10」。 */
    window.MomoStore.apply({mood:50-window.MomoStore.state.mood,
                            affection:20-window.MomoStore.state.affection});
    var mood0=window.MomoStore.state.mood, aff0=window.MomoStore.state.affection;

    window.MomoStore.state.story={intro_done:false};
    window.MomoDirector.setAuto(true);
    goNav("开屏"); goNav("主画面");
    var s0=st();
    /* 墨墨还没开口：对话框与姓名条都不该出现 */
    R.openingS0={bound:s0.bound,playing:s0.playing,state:s0.state,
                 dlg:s0.dlgVisible,plate:s0.plateVisible,nar:s0.narVisible};
    R.openingSilentAtStart=note("silentAtStart", s0.playing && s0.state==="expr" &&
      !s0.dlgVisible && !s0.plateVisible && !s0.narVisible);
    R.openingExprStart=s0.dataExpr===window.MomoExpr.DEFAULT;

    var iv=setInterval(function(){
      if(++ticks>900){ clearInterval(iv); bad.push("timeout"); done(); return; }
      var s=st();
      /* 表情真的换了图（不只是改了个名字） */
      if(s.dataExpr==="欲言又止" && s.sprite==='url("'+wantYan+'")') sawYan=true;
      if(s.state==="narration"){
        sawNar=true;
        if(s.narText.indexOf("劝学总是让人昏昏欲睡")>=0) sawNarText=true;
        if(s.dlgVisible||s.plateVisible) sawNarBox=true;   /* 旁白时两者都必须收起 */
        narEl.click();
      }else if(s.state==="say"){
        if(s.dlgText!==lastSay){ lastSay=s.dlgText; lines++; }
        if(s.plateText===window.MomoName.get()) sawPlayer=true;   /* 玩家说话 → 姓名条填玩家名 */
        if(s.plateText==="墨 墨") sawMomo=true;
        /* 表情只对写了它的那一句生效：带括号那句是「欲言又止」，
           紧接着没写表情的那句必须自动回「默认」 */
        if(s.dlgText.indexOf("认识你.....也就一般高兴吧")>=0) exprYan=s.dataExpr==="欲言又止";
        if(s.dlgText.indexOf("总之——之后的日子")>=0) exprReset=s.dataExpr==="默认";
        dlgEl.click();
      }else if(window.MomoChoice.state().visible){
        sawChoice=true;
        bars[0].click();                                   /* 选 A：心情 -10 / 好感 -5 */
      }
      if(!st().playing){ clearInterval(iv); done(); }
    }, 20);

    function done(){
      var s=st();
      R.openingExprYan=sawYan;
      R.openingExprScene=exprYan;                       /* 带括号那句 = 欲言又止 */
      R.openingExprReset=exprReset===true;              /* 下一句没写 = 自动回默认 */
      R.openingSpriteAtStart=!s0.spriteHidden;          /* 开场立绘是在的（不是切场景那一拍） */
      R.openingNarration=sawNar&&sawNarText;
      R.openingNarHidesBox=!sawNarBox;
      R.openingChoice=sawChoice;
      R.openingPlayerLine=sawPlayer;
      R.openingMomoLine=sawMomo;
      R.openingLines=lines;
      R.openingMood=Math.round(window.MomoStore.state.mood);
      R.openingAffection=Math.round(window.MomoStore.state.affection);
      R.openingStatsOk=R.openingMood===Math.round(mood0-10) &&
                       R.openingAffection===Math.round(aff0-5);
      /* 演完必须「收起一切」—— 墨墨不说话时画面上只剩立绘 + 场景图 */
      R.openingEndRest=!s.playing && s.state==="idle" && !s.dlgVisible &&
                       !s.plateVisible && !s.narVisible && !s.spriteHidden;
      R.openingIntroFlag=window.MomoStore.state.story.intro_done===true;
      /* 演完不该重播：离开主界面再回来，还是收起的常态 */
      goNav("地图界面"); goNav("主画面");
      var s2=st();
      R.openingNoReplay=!s2.playing && s2.state==="idle" && !s2.dlgVisible && !s2.narVisible;
      R.openingBad=bad;
      window.MomoDirector.setAuto(false);
      R.openingPass=bad.length===0 && R.openingSilentAtStart && R.openingExprStart &&
        R.openingSpriteAtStart && R.openingExprYan && R.openingExprScene && R.openingExprReset &&
        R.openingNarration && R.openingNarHidesBox && R.openingChoice &&
        R.openingPlayerLine && R.openingMomoLine && R.openingLines>=30 && R.openingStatsOk &&
        R.openingEndRest && R.openingIntroFlag && R.openingNoReplay;
      replayStage();
    }
  })();

  /* ================= 剧情回放 + 开屏两个入口：整段演练 =================
     要等开场演完才有对话记录，所以接在开场之后跑。 */
  function replayStage(){
    /* 这一段要真的走「新的故事」启动流程，得把自动播打开 */
    window.MomoDirector.setAuto(true);

    /* —— 回放：记录真的被画出来、真的滚得动、且只在这块面板里滚 —— */
    goNav("回放界面");
    var rp=window.MomoReplay.state();
    R.replayEntries=rp.entries;
    R.replayRendered=rp.rendered;
    R.replayKindsOk=rp.kinds.indexOf("momo")>=0 && rp.kinds.indexOf("narr")>=0 &&
                    rp.kinds.indexOf("player")>=0;
    R.replayCountOk=rp.entries>=35 && rp.rendered===rp.entries;
    R.replayFirstIsOpening=rp.firstText.indexOf("你好")>=0 && rp.firstText.indexOf("{{")<0;
    R.replayLastIsLastLine=rp.lastText.indexOf("切。")>=0;
    R.replayOpensAtBottom=rp.atBottom===true;
    R.replayScrollable=rp.scrollHeight>rp.clientHeight+10;
    R.replayNoEmpty=rp.emptyShown===false && rp.emptyRectH===0;
    /* 旁白那一条：没有姓名条、单独一个 class */
    R.replayNarrRow=!!q('#scr-回放界面 .rp-row--narr .rp-txt') &&
                    !q('#scr-回放界面 .rp-row--narr .rp-who');
    var vp=q('#scr-回放界面 .rp-viewport');
    vp.scrollTop=0;
    R.replayScrollToTop=vp.scrollTop===0;
    /* 光看 class/属性会被 CSS 骗过去（空态那块曾经整块盖在列表上），
       所以滚到顶后直接做命中测试：第一行必须真的能点到。
       必须放在 scrollTop=0 之后 —— 刚打开时停在最新一句，第一行在视口上方外面。 */
    R.replayFirstRowVisible=(function(){
      var row=q('#scr-回放界面 .rp-list .rp-row');
      var b=row&&row.getBoundingClientRect();
      if(!b || b.height<=0) return false;
      var t=document.elementFromPoint(b.left+8, b.top+b.height/2);
      return !!t && (t===row || row.contains(t)); })();
    /* 滚轮/触摸滑动要真的能滚到这块 —— .layer 默认 pointer-events:none，
       不放开的话上下滑动完全没反应（列表就在那儿但滑不动）。 */
    R.replayScrollableByWheel=getComputedStyle(vp).pointerEvents==='auto';
    /* 横向上谁都不许越出视口 —— 滑的是上下，不是左右 */
    R.replayRowsInside=(function(){
      var b=vp.getBoundingClientRect(), ok=true;
      [].slice.call(vp.querySelectorAll(".rp-row")).forEach(function(row){
        var rb=row.getBoundingClientRect();
        if(rb.left<b.left-1 || rb.right>b.right+1) ok=false;
      });
      return ok; })();

    /* —— 开屏：新的故事必须先问一句，而且不立刻跳走 —— */
    var learnBefore=Object.keys(window.MomoStore.state.learn.learned||{}).length;
    goNav("开屏");
    var nb=q('#scr-开屏 [data-name="新的开始"]');
    if(nb) nb.click();
    R.newAsks=!!document.getElementById("momo-confirm-mask") &&
              q('[data-screen="开屏"]').classList.contains("active");
    var no=document.getElementById("momo-confirm-no");
    if(no) no.click();
    R.newCancelKeeps=!document.getElementById("momo-confirm-mask") &&
                     q('[data-screen="开屏"]').classList.contains("active") &&
                     window.MomoStore.state.story.intro_done===true;
    /* 确认 → 剧情归零 + 回主画面 + 开场重新开演 */
    if(nb) nb.click();
    var yes=document.getElementById("momo-confirm-yes");
    if(yes) yes.click();
    var st2=window.MomoStore.state;
    R.newResetsStory=st2.story.intro_done===false && (st2.story.log||[]).length===0;
    R.newResetsRelations=st2.mood===50 && st2.affection===0 && st2.supplies===60 &&
                         st2.currency===1000 && st2.room==="卧房" && st2.floor==="F1";
    R.newKeepsLearn=learnBefore>0 &&
                    Object.keys(st2.learn.learned||{}).length===learnBefore;
    R.newGoesMain=q('[data-screen="主画面"]').classList.contains("active") &&
                  window.MomoDirector.isPlaying()===true;
    /* 再等开场的那段表情停留走完，看新记录是不是真的从第一句重新开始 */
    setTimeout(function(){
      var L=window.MomoStore.state.story.log||[];
      R.newLogRestarts=L.length>=1 && L.length<12 && L[0].text.indexOf("你好")>=0 &&
                       window.MomoStore.state.story.intro_done===false;
      R.newLinesAreMomo=L.length>=1 && L[0].who==="momo";
      /* 小星星要自己消失（animationend 自删），不能一直堆在 DOM 里 */
      R.idleSparksLeft=window.MomoIdle.state().sparks;
      R.idleSparksGone=R.idleSparksLeft===0;
      /* 抽样探针：各类图真的下得下来（单文件=data URI；拆分=assets/ 下的文件） */
      R.assetProbe=PROBE.ok+"ok/"+PROBE.total+"total/"+PROBE.err+"err";
      R.assetProbeBad=PROBE.bad.slice(0,5);
      R.assetProbeOk=PROBE.total>=6 && PROBE.ok===PROBE.total && PROBE.err===0;
      window.MomoDirector.setAuto(false);
      ecoStage();
      R.replayPass=!!(R.idleSparksGone && R.assetProbeOk &&
        R.replayViewport && R.contGoesMain && R.replayEntries>=35 &&
        R.replayRendered===R.replayEntries && R.replayKindsOk && R.replayCountOk &&
        R.replayFirstIsOpening && R.replayLastIsLastLine && R.replayOpensAtBottom &&
        R.replayScrollable && R.replayNoEmpty && R.replayFirstRowVisible &&
        R.replayScrollableByWheel && R.replayNarrRow && R.replayScrollToTop &&
        R.replayRowsInside && R.newAsks && R.newCancelKeeps && R.newResetsStory &&
        R.newResetsRelations && R.newKeepsLearn && R.newGoesMain && R.newLogRestarts &&
        R.newLinesAreMomo);
      report();
    }, 2600);
  }

  /* ================= 经济系统：学习产出 / 服装解锁 / 日结算 / 死亡重开 =================
     只认「存档里的数值真的变了吗」，不认界面上的死数字。
     放在最后跑：它要动 currency / supplies 这些全局值，前面那些断言都量完了。 */
  function ecoStage(){
    /* 注意：state 是数据快照，apply / earn / spend 这些出口挂在 MomoStore 上 */
    var MS=window.MomoStore, st=MS.state, MD=window.MomoDaily;
    function setById(id){
      var a=((window.MOMO_DATA||{}).wardrobe||{}).sets||[];
      for(var i=0;i<a.length;i++) if(a[i].id===id) return a[i];
      return null;
    }
    function shiftKey(k,n){
      var t=new Date(+k.slice(0,4),+k.slice(4,6)-1,+k.slice(6,8));
      t.setDate(t.getDate()+n);
      var m=t.getMonth()+1,dd=t.getDate();
      return ""+t.getFullYear()+(m<10?"0"+m:m)+(dd<10?"0"+dd:dd);
    }
    /* 把当天该发的时段在线奖励先结掉，后面才好按固定起点量差值 */
    function rewind(acc, right, slots, streak){
      var d=st.daily;
      d.day=shiftKey(MD.day(),-1);
      d.quiz_total=acc; d.quiz_right=right;
      d.slots={"清晨":!!slots,"午后":!!slots,"夜晚":!!slots};
      d.streak=streak;
      MS.save();
    }
    try{
      /* 「新的故事」把开场又演上了，而日结算面板要等演出停才弹（不然盖住没法点）。
         这里先把它停下，否则下面每次弹窗都在等，量到的都是「还没弹」。 */
      if(window.MomoDirector){ window.MomoDirector.setAuto(false); window.MomoDirector.stop(); }
      MD.tick();
      MS.apply({currency:1000-st.currency, supplies:60-st.supplies,
                mood:50-st.mood, affection:0-st.affection});

      /* ---- ① 练习判分产出：到期词 8 / 其他 2；连对第 3 题起每多一题 +4 ---- */
      /* 学习界面不在开发导航栏里，走主画面那个「学」按钮进（跟玩家一样） */
      goNav("主画面");
      var leEntry=q('#scr-主画面 .learn-entry');
      if(leEntry) leEntry.click();
      R.ecoLearnOpen=!!q('#scr-学习界面') &&
                     q('#scr-学习界面').classList.contains('active');
      q('#scr-学习界面 .learn-lang[data-lang="en"]').click();
      st.learn.learned={}; st.learn.wrong={en:[],ja:[]};
      MS.save();
      q('#scr-学习界面 .learn-tab[data-learn="qz"]').click();
      function hit(){
        var i=window.MomoLearn.answer();
        if(i<0) return -1;
        var b=st.currency;
        qa('#scr-学习界面 .dr-choice')[i].click();
        return st.currency-b;
      }
      var e1=hit();
      q('#scr-学习界面 .dr-btn[data-act="next"]').click();
      var e2=hit();
      q('#scr-学习界面 .dr-btn[data-act="next"]').click();
      var e3=hit();
      R.ecoQuizEach=[e1,e2,e3];
      R.ecoQuizGain=e1===8 && e2===8 && e3===12;
      R.ecoQuizFeedback=/＋\d+/.test(q('#scr-学习界面 .dr-fb').textContent);
      R.ecoQuizFbText=q('#scr-学习界面 .dr-fb').textContent.slice(-24);
      R.ecoQuizDaily=MD.state().quiz_total===3 && MD.state().quiz_right===3;
      R.ecoChipEquals=window.MomoLearn.state().money.shown===String(Math.round(st.currency));

      /* ---- ② 自评产出：记得 5 / 模糊 1 / 忘了 0 ---- */
      q('#scr-学习界面 .learn-tab[data-learn="wc"]').click();
      var k0=st.currency;
      q('#scr-学习界面 .wc-g[data-grade="2"]').click();
      R.ecoCardRemember=st.currency-k0;
      k0=st.currency;
      q('#scr-学习界面 .wc-g[data-grade="1"]').click();
      R.ecoCardFuzzy=st.currency-k0;
      k0=st.currency;
      q('#scr-学习界面 .wc-g[data-grade="0"]').click();
      R.ecoCardForget=st.currency-k0;
      R.ecoCardGain=R.ecoCardRemember===5 && R.ecoCardFuzzy===1 && R.ecoCardForget===0;
      /* 背单词的「认识」跟卡片的「记得」是同一档，产出同数 */
      q('#scr-学习界面 .learn-tab[data-learn="sd"]').click();
      k0=st.currency;
      q('#scr-学习界面 .sd-btn.ok').click();
      R.ecoDeckHit=st.currency-k0;

      /* ---- ③ 服装：排序（已解锁在前 / 未解锁按价升序） / 按价购买 / 未解锁可试穿但不落盘 ---- */
      goNav("服装");
      var w=window.MomoWardrobe.state();
      /* 排序规则是对**整个分类**说的，所以拿全量顺序验，而不是只看第一页：
         已解锁的必须全部在前（一旦出现过未解锁的，后面就不许再有已解锁的），
         未解锁的那段价格必须非递减。 */
      R.ecoSortUnlockedFirst=(function(){
        var o=w.order, seenLocked=false, prev=0, ok=true;
        for(var i=0;i<o.length;i++){
          if(o[i].unlocked){ if(seenLocked) ok=false; }
          else {
            if(!seenLocked){ seenLocked=true; prev=o[i].price; }
            else { if(o[i].price<prev) ok=false; prev=o[i].price; }
          }
        }
        R.ecoSortLen=o.length; R.ecoSortSeenLocked=seenLocked;
        return ok && o.length>3 && seenLocked;
      })();
      /* 推论：第一页应当全是已解锁的（未解锁的都被排到后面去了） */
      R.ecoPage0AllUnlocked=w.cards.length>0 &&
        w.cards.every(function(c){return c.unlocked;});
      R.ecoFreeCount=w.cards.filter(function(c){return c.unlocked;}).length;
      /* 未解锁的现在都在后面几页，翻到一个能看见未解锁卡片的页再继续。
         取到的必然是**最便宜**的那一档 —— 顺带把「按价升序」在真实界面上验一遍 */
      var locked=null, li=-1;
      for(var pg=0; pg<w.total; pg++){
        var cand=w.cards.filter(function(c){return !c.unlocked && c.price>0;})[0];
        if(cand){ locked=cand; li=w.cards.indexOf(cand); break; }
        q('#scr-服装 .lL022').click();          /* 向右翻页（.lL022=右，.lL023=左） */
        w=window.MomoWardrobe.state();
      }
      R.ecoLockedPrice=locked?locked.price:0;
      R.ecoLockedIsCheapest=(function(){
        var prices=w.order.filter(function(s){return !s.unlocked && s.price>0;})
                          .map(function(s){return s.price;});
        R.ecoMinLocked=prices.length?Math.min.apply(null,prices):0;
        return !!locked && R.ecoLockedPrice===R.ecoMinLocked;
      })();
      R.ecoBadge=li>=0&&!!w.badges[li]&&w.badges[li].shown&&w.badges[li].text===locked.price+" 金";
      R.ecoWearClickable=li>=0&&w.wearClickable[li]===true;
      var worn0=st.wardrobe.worn;
      if(li>=0) qa('#scr-服装 [data-glow="cards"]')[li].click();          /* 白框 = 试穿 */
      R.ecoTrialPreview=li>=0&&window.MomoWardrobe.state().preview===locked.id;
      R.ecoTrialNotSaved=st.wardrobe.worn===worn0;                       /* 试穿绝不写 worn */
      q('#scr-服装 .lL037').click();            /* 「确 认」= PSD 里文字与 data-name 是反的 */
      R.ecoTrialBlocked=st.wardrobe.worn===worn0 &&
                        st.wardrobe.unlocked.indexOf(locked.id)<0;
      /* 试穿不许漏到别的屏：回主画面，立绘必须是身上那套，不是刚才试的那套 */
      goNav("主画面");
      var spr=q('#scr-主画面 [data-costume]');
      var lockImg=window.ASSET_URI[(setById(locked.id)||{}).img]||"__none__";
      R.ecoTrialNoLeak=!!spr && spr.style.backgroundImage.indexOf(lockImg)<0;
      goNav("服装");
      R.ecoTrialResets=window.MomoWardrobe.state().preview===st.wardrobe.worn;
      /* 余额不足 → 拦截，什么都不改 */
      MS.apply({currency:10-st.currency});
      qa('#scr-服装 [data-role="wear"]')[li].click();                    /* 小牌 = 购买 */
      R.ecoBuyBlocked=st.currency===10 &&
        st.wardrobe.unlocked.indexOf(locked.id)<0 &&
        st.wardrobe.worn===worn0;
      /* 钱够 → 扣费 + 写进 unlocked + 顺手穿上 */
      MS.apply({currency:1000-st.currency});
      qa('#scr-服装 [data-role="wear"]')[li].click();
      R.ecoBuyPaid=1000-st.currency===locked.price;
      R.ecoBuyUnlocked=st.wardrobe.unlocked.indexOf(locked.id)>=0;
      R.ecoBuyWorn=st.wardrobe.worn===locked.id;
      R.ecoBuyOk=R.ecoBuyPaid&&R.ecoBuyUnlocked&&R.ecoBuyWorn;

      /* ---- ④ 日结算：准确率 ≥90% → 50 金 / 心情 +8 / 好感 +3；三段全清 → 好感 +2；
                        物资按真实日差扣（12/天） ---- */
      MS.apply({currency:1000-st.currency, supplies:60-st.supplies,
                mood:50-st.mood, affection:0-st.affection});
      rewind(10,10,true,1);
      var c0=st.currency,s0=st.supplies,m0=st.mood,a0=st.affection;
      var rep=MD.rollover();
      R.ecoSettleCurrency=st.currency-c0;
      R.ecoSettleSupplies=s0-st.supplies;
      R.ecoSettleMood=st.mood-m0;
      R.ecoSettleAffection=st.affection-a0;
      R.ecoSettleLines=rep?rep.lines.length:0;
      R.ecoSettleOk=R.ecoSettleCurrency===50 && R.ecoSettleSupplies===12 &&
        R.ecoSettleMood===8 && R.ecoSettleAffection===5 && R.ecoSettleLines>=3;
      R.ecoSettleReset=st.daily.day===MD.day() && !st.daily.slots["清晨"] &&
        st.daily.quiz_total===0 && st.daily.streak===2;

      /* 没考好那一整天：准确率低于 pass 线 → 心情 -2（唯一的负值项） */
      MS.apply({mood:50-st.mood});
      rewind(10,1,false,1);
      MD.rollover();
      R.ecoSettleLowMood=st.mood-50;

      /* ---- ⑤ 时段在线奖励：发一次，同段不重发 ---- */
      var c1=st.currency;
      MD.tick();
      R.ecoSlotGain=st.currency-c1;
      var c2=st.currency;
      MD.tick();
      R.ecoSlotOnce=st.currency===c2 && R.ecoSlotGain===20;

      /* ---- ⑦ 地点小游戏：只发货币、每地点每天一次、每天最多三个地点 ---- */
      R.ecoMini=(function(){
        var MG=window.MomoMinigame;
        R.ecoMiniApi=!!MG;
        if(!MG) return false;
        var sup0=st.supplies, mood0=st.mood, aff0=st.affection;
        /* 入口 → 屏真的打开，关卡键按「楼层:房间」解析（房间有重名，必须带楼层） */
        MG.debugGoto("OUT","河边");
        MomoUI.show("小游戏界面");
        R.ecoMiniScreen=q("#scr-小游戏界面").classList.contains("active");
        var s0=MG.state();
        R.ecoMiniLevel=s0.key==="OUT:河边" && s0.core==="skim" && s0.playable===true;
        R.ecoMiniPlaying=!!s0.run;                 /* 进来就该在跑 */
        /* 出口热区：elementFromPoint 必须真的命中它（程序化 .click 测不出错位） */
        var ex=q("#scr-小游戏界面 .mini-exit"), r=ex.getBoundingClientRect();
        var el=document.elementFromPoint(Math.round(r.left+r.width/2),
                                         Math.round(r.top+r.height/2));
        R.ecoMiniHit=!!el && (el===ex || ex.contains(el));
        /* 按得动：按下立刻进蓄力、松开立刻进判定环 —— 这两步是同步的，
           所以能在无头浏览器里稳定断言（rAF 在 virtual time 下不推进，画不到画布） */
        var scr0=q("#scr-小游戏界面");
        scr0.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));
        R.ecoMiniCharge=(MG.state().run||{}).phase==="charge";
        scr0.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));
        R.ecoMiniRing=(MG.state().run||{}).phase==="ring";
        /* 结算发钱：S 级正好 15（= earn[0]）；同一地点当天不重发 */
        var before=st.currency;
        var a=MG.debugPlay({grade:"S"});
        R.ecoMiniEarn=(st.currency-before)===15 && a.coins===15;
        var mid=st.currency;
        MG.debugPlay({grade:"S"});
        R.ecoMiniOnce=st.currency===mid;
        /* 每天最多三个地点：第 4 个地点白玩不给钱 */
        MG.debugPlay({floor:"OUT",room:"码头",grade:"S"});
        MG.debugPlay({floor:"OUT",room:"公园",grade:"S"});
        var q4=MG.debugPlay({floor:"OUT",room:"灯塔",grade:"S"});
        R.ecoMiniQuota=q4.coins===0 && MG.state().total===3;
        /* 只发货币：物资 / 心情 / 好感一点没动 */
        R.ecoMiniOnlyCurrency=(st.supplies===sup0 && st.mood===mood0 && st.affection===aff0);
        /* ---- rush（出餐）：进屏就该有一张单，点它要的那一格必须真的推进 ---- */
        MG.debugGoto("F1","餐厅");
        MomoUI.show("小游戏界面");
        var rs=MG.state(), rr0=rs.run||{}, cs=rr0.cells||[];
        R.rushLevel=rs.core==="rush";
        R.rushOrder=rr0.orders===1 && !!rr0.need;
        var cell=null, ci;
        for(ci=0;ci<cs.length;ci++) if(cs[ci].label===rr0.need) cell=cs[ci];
        R.rushCell=!!cell;
        if(cell){
          /* 画布可能被缩放，所以按「舞台坐标 → 视口坐标」换算，别假设 1:1 */
          var cr=q("#scr-小游戏界面 .mini-canvas").getBoundingClientRect();
          var vx=cr.left + cell.x*(cr.width/1920), vy=cr.top + cell.y*(cr.height/1080);
          scr0.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:vx,clientY:vy}));
          var r1=MG.state().run;
          R.rushTap=r1.combo===rr0.combo+1;
          /* 再点同一格（已经不需要它了）：不加分也不扣 —— 忙乱是「来不及」不是「答错了」 */
          scr0.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:vx,clientY:vy}));
          var r2=MG.state().run;
          R.rushNoPenalty=r2.combo===r1.combo && r2.done===r1.done && r2.missed===r1.missed;
        } else { R.rushTap=false; R.rushNoPenalty=false; }
        /* 还没做玩法的地点：屏里明确说「还没做」，不是静默坏掉。
           不能用固定房间 —— 玩法是一个个补上的（书房后来就有了），写死会随进度变成假失败。
           这里从地图里现挑一个当前确实没有关卡的房间。 */
        var MG_lv=((window.MOMO_DATA||{}).minigames||{}).levels||{};
        var MG_map=(window.MOMO_DATA||{}).map||{};
        var free=null;
        (MG_map.order||[]).forEach(function(f){
          if(free) return;
          (((MG_map.floors||{})[f]||{}).rooms||[]).forEach(function(r){
            if(free||r.kind!=="room") return;
            var k=f+":"+r.raw;
            if(!MG_lv[k]) free=k;
          });
        });
        R.ecoMiniEmptyRoom=free;
        if(free) MG.debugGoto(free.split(":")[0], free.split(":")[1]);
        MomoUI.show("小游戏界面");
        R.ecoMiniEmpty=!q("#scr-小游戏界面 .mini-empty").hidden &&
                       MG.state().playable===false && !MG.state().playing;
        MomoUI.show("主画面");
        /* 主画面上那枚「玩」入口。这里要验**两件相反的事**，
           因为 2026-10-12 加了「演出锁」：剧本在演时「地/学/玩」会被收起来
           （opacity 0 + pointer-events none），演完自动恢复。
             · 演出中：必须锁住 —— 否则玩家能在剧情中途跑掉；
             · 演出后：必须点得着 —— 否则入口就成了摆设。
           上面几步会留下没演完的临时演出（换装回话等），正好拿它当「演出中」这一测。 */
        var pe=q("#scr-主画面 .play-entry");
        R.ecoMiniEntry=false; R.ecoMiniLockOk=false;
        if(pe){
          function hitPe(){
            var r=pe.getBoundingClientRect();
            var el=document.elementFromPoint(Math.round(r.left+r.width/2),
                                             Math.round(r.top+r.height/2));
            R.ecoMiniEntryAt=el?(el.className||el.tagName):"(null)";
            return !!el && (el===pe || pe.contains(el));
          }
          var playing0=window.MomoDirector.isPlaying();
          if(playing0){
            R.ecoMiniEntryLock=q('#scr-主画面').classList.contains('story-lock');
            R.ecoMiniEntryOpacity=getComputedStyle(pe).opacity;
            R.ecoMiniEntryPE=getComputedStyle(pe).pointerEvents;
            /* 锁得住＝挂了 story-lock、且真的点不到（光有 class 不算数） */
            R.ecoMiniLockOk=R.ecoMiniEntryLock && R.ecoMiniEntryPE==='none' && !hitPe();
            window.MomoDirector.stop();
          } else {
            R.ecoMiniLockOk=true;         /* 没在演出：那就不该有锁 */
            R.ecoMiniEntryLock=q('#scr-主画面').classList.contains('story-lock');
            if(R.ecoMiniEntryLock) R.ecoMiniLockOk=false;
          }
          R.ecoMiniEntryPlayingAfter=window.MomoDirector.isPlaying();
          R.ecoMiniEntry=hitPe();         /* 演出收掉之后：入口必须点得着 */
        }
        return !!(R.ecoMiniApi && R.ecoMiniScreen && R.ecoMiniLevel && R.ecoMiniPlaying &&
                  R.ecoMiniHit && R.ecoMiniCharge && R.ecoMiniRing &&
                  R.ecoMiniEarn && R.ecoMiniOnce && R.ecoMiniQuota &&
                  R.ecoMiniOnlyCurrency && R.ecoMiniEmpty && R.ecoMiniEntry &&
                  R.ecoMiniLockOk &&
                  R.rushLevel && R.rushOrder && R.rushCell && R.rushTap && R.rushNoPenalty);
      })();

      /* ---- ⑥ 死亡 / 多周目：物资归零 → 弹出提示 → 重开一局 ---- */
      var d=st.daily;
      d.day=shiftKey(MD.day(),-1);
      d.quiz_total=0; d.quiz_right=0;
      MS.apply({supplies:-st.supplies, affection:30-st.affection, mood:50-st.mood});
      var learnedBefore=Object.keys(st.learn.learned||{}).length;
      /* 新 daily.js 的死亡/结算面板走 whenIdle：**演出还在播就先不盖面板**
         （盖上去演出就没法点了），等演完再弹。所以这里得先把正在播的台词收掉，
         否则断言永远看不到面板 —— 那是测试没跟上新行为，不是面板坏了。 */
      if(window.MomoDirector && window.MomoDirector.isPlaying()) window.MomoDirector.stop();
      MD.tick();
      R.ecoDeathPanel=!!document.getElementById("momo-daily-mask");
      var btn=document.querySelector("#momo-daily-panel .cf-btn");
      R.ecoDeathBtn=btn?btn.textContent.replace(/\s+/g,""):"";
      if(btn) btn.click();
      R.ecoReviveSupplies=st.supplies;
      R.ecoReviveMood=st.mood;
      R.ecoReviveAffection=st.affection;
      R.ecoReviveCycle=st.cycle;
      R.ecoReviveIntro=st.story.intro_done===false;
      /* 重开周目要把地点小游戏的每日配额也清掉，否则新周目第一天就玩不了 */
      R.ecoMiniQuotaReset=!!st.daily.mini && st.daily.mini.total===0 &&
        Object.keys(st.daily.mini.used).length===0;
      R.ecoReviveKeepsLearn=Object.keys(st.learn.learned||{}).length===learnedBefore &&
                            learnedBefore>0;
      R.ecoRevive=!document.getElementById("momo-daily-mask") &&
        R.ecoReviveSupplies===60 && R.ecoReviveMood===0 && R.ecoReviveAffection===0 &&
        R.ecoReviveCycle>=2 && R.ecoReviveIntro && R.ecoReviveKeepsLearn;
      /* 结算面板那条路也走一遍：新的一天要真的弹出来、点掉能关 */
      rewind(1,0,false,1);
      if(window.MomoDirector && window.MomoDirector.isPlaying()) window.MomoDirector.stop();
      MD.tick();
      R.ecoSettlePanel=!!document.getElementById("momo-daily-mask");
      var ok2=document.querySelector("#momo-daily-panel .cf-btn");
      if(ok2) ok2.click();
      R.ecoSettlePanelCloses=R.ecoSettlePanel && !document.getElementById("momo-daily-mask");
    }catch(e){ R.ecoError=String(e&&e.stack||e); }

    /* ================= 外壳：自带字体 + 主屏独立模式 =================
       这两条都是「在自己电脑上怎么都看不出问题、一到手机就露馅」的类型：
         · 字体：本机装了方正小标宋就一直正常，换台没装的机器/手机就静默回退到 serif，
           所以必须断言「@font-face 真的在产物里、src 指向自带的 woff2、并且浏览器认它」。
         · 独立模式：manifest 或那几个 meta 只要漏一个，加主屏后就又带上浏览器地址栏。 */
    try{
      R.fontFace=(function(){
        var rule=false, src="";
        for(var i=0;i<document.styleSheets.length;i++){
          var rs; try{ rs=document.styleSheets[i].cssRules; }catch(e){ continue; }
          for(var j=0;j<rs.length;j++){
            var r=rs[j];
            if(r.type===5){                       /* CSSRule.FONT_FACE_RULE */
              var fam=String((r.style&&r.style.fontFamily)||"").replace(/["']/g,"");
              if(fam.toLowerCase()==="fzxiaobiaosong-b05s"){
                rule=true; src=String((r.style&&r.style.src)||"");
              }
            }
          }
        }
        R.fontFaceSrc=src;
        /* src 必须是自带的 woff2（被构建换成 assets/方正小标宋简体.<hash>.woff2） */
        R.fontFaceSelfHost=/\.woff2/.test(src) && /方正小标宋简体/.test(src);
        /* 浏览器认不认这个 family（字体没载完 / 名字写错都会是 false） */
        R.fontFaceReady=document.fonts.check('30px "FZXiaoBiaoSong-B05S"');
        /* 落回 serif 的度量不一样：能证明真的换了字形，而不是「名字对但没生效」 */
        var c=document.createElement("canvas").getContext("2d");
        c.font='30px "FZXiaoBiaoSong-B05S"'; var a=c.measureText("墨墨的洋馆").width;
        c.font="30px serif";                 var b=c.measureText("墨墨的洋馆").width;
        R.fontFaceW=[Math.round(a),Math.round(b)];
        return rule && R.fontFaceSelfHost;
      })();

      R.pwaMeta=(function(){
        var man=document.querySelector('link[rel="manifest"]');
        R.pwaManifestHref=man?man.getAttribute("href"):"";
        return !!man &&
               !!document.querySelector('meta[name="mobile-web-app-capable"]') &&
               !!document.querySelector('meta[name="apple-mobile-web-app-capable"]') &&
               !!document.querySelector('meta[name="theme-color"]') &&
               !!document.querySelector('link[rel="apple-touch-icon"]');
      })();

      /* 竖屏遮罩：手机上竖着拿必须先盖住整屏、提示横过来（否则一堆元素挤成一团） */
      R.rotateTip=(function(){
        var t=document.getElementById("rotate-tip");
        if(!t) return false;
        var cs=getComputedStyle(t);
        return cs.position==="fixed" && t.textContent.indexOf("横")>=0;
      })();
      /* 按钮基础态必须是「没有滤镜」。
         以前按钮上挂着 --fx: brightness(1)：看着什么都不做，但浏览器照样为每个按钮
         跑一遍滤镜合成（iOS 还会单独开层栅格化），一屏几十个按钮白跑几十遍。
         改成 --fx: initial 之后基础态是 none、悬停/发光态靠 var() 兜底 ——
         这一步**像素级等价**（brightness(1) 是恒等滤镜），属于纯赚，所以拿它当断言。 */
      R.btnBaseNoFilter=(function(){
        window.MomoUI.show("人物");
        var scr=q('[data-screen="人物"]');
        if(!scr) return false;
        var none=0, ident=0, fx=0;
        qa(".layer.btn",scr).forEach(function(e){
          var f=getComputedStyle(e).filter||"";
          if(f==="none") none++; else fx++;
          if(f.indexOf("brightness(1)")>=0) ident++;   /* 恒等滤镜又回来了 */
        });
        R.btnBaseNone=none; R.btnIdentFilter=ident; R.btnFiltered=fx;
        return none>0 && ident===0;
      })();

      /* 首屏搬运层在 file:// 下必须**自动让开**。
         这一条既是产品要求（本地直开要能玩，不该卡在「正在搬运」），
         也是这套验证能跑的前提 —— 验证就是 file:// 加载 dist 的，
         preload 要是不肯让路，那一层会盖住整个界面，下面所有断言全废。 */
      R.bootOffFile=(function(){
        var off=window.MomoPreload && window.MomoPreload.off===true;
        R.bootOffReason=window.MomoPreload?window.MomoPreload.reason:"(无 MomoPreload)";
        return off && !document.getElementById("boot");
      })();
    }catch(e){ R.shellError=String(e&&e.stack||e); }

    R.ecoPass=!!(R.ecoLearnOpen && R.ecoQuizGain && R.ecoQuizFeedback && R.ecoQuizDaily && R.ecoChipEquals &&
      R.ecoCardGain && R.ecoDeckHit===5 &&
      R.ecoSortUnlockedFirst && R.ecoPage0AllUnlocked &&
      R.ecoLockedIsCheapest && R.ecoBadge && R.ecoWearClickable &&
      R.ecoTrialPreview && R.ecoTrialNotSaved && R.ecoTrialBlocked &&
      R.ecoTrialNoLeak && R.ecoTrialResets &&
      R.ecoBuyBlocked && R.ecoBuyOk &&
      R.ecoSettleOk && R.ecoSettleReset && R.ecoSettleLowMood===-2 &&
      R.ecoSlotOnce && R.ecoMini && R.ecoMiniQuotaReset &&
      R.ecoRevive && R.ecoSettlePanelCloses);
  }
})();
</script>
"""


def check_asset_refs(page_path):
    """全量核对产物里的图片引用与文件是否一一对上。

    为什么放在 Python 侧而不是浏览器里：这是一条纯文件层面的对应关系（引用 → 文件），
    在文件系统上逐个 stat 一秒就能查完 400 个，而塞进浏览器只能抽样，还会把
    浏览器测试拖慢。拆分产物最典型的翻车就是「index.html 传上去了、assets/ 少传了」，
    那种时候页面照样打开、只是图全白 —— 这条断言就是专门盯这个的。
    单文件模式没有 assets/ 引用，这里会退化成「0 个引用 = 通过」，两种产物都能跑。"""
    html = open(page_path, encoding="utf-8").read()
    refs = set(re.findall(r"""url\(\s*['"]?(assets/[^'")]+?)['"]?\s*\)""", html))
    m = re.search(r"window\.ASSET_URI=(\{.*?\});", html, re.S)
    if m:
        try:
            for v in json.loads(m.group(1)).values():
                if isinstance(v, str) and not v.startswith("data:"):
                    refs.add(v)
        except ValueError:
            pass
    root = os.path.dirname(page_path)
    missing = sorted(r for r in refs if not os.path.exists(os.path.join(root, r)))
    return len(refs), missing


def check_offline_shell():
    """核对「先搬一次、以后离线也能开」这套东西在产物里是齐的。

    这套东西由三个文件分头负责，任何一个掉了都不会报错、只是**静默失效**：
      · dist/sw.js          —— 断网时把 index.html 从缓存里交出来（不然就是浏览器报错页）
      · index.html 里的 window.MOMO_ASSETS —— 首屏要下哪些图、各多大
      · index.html 里内联的 preload 代码   —— 真正搬图的那个循环
    最容易出的是「构建跑了一半 / 包漏传 sw.js」和「两份缓存名写岔」，
    前者让页面照开、只是永远没有离线兜底，后者让进度条每次都从头走一遍。"""
    errs = []
    root = os.path.dirname(DIST)
    sw_path = os.path.join(root, "sw.js")
    if not os.path.exists(sw_path):
        errs.append("dist/sw.js 不存在（构建没生成或上传包漏了它）")
        sw_cache = None
    else:
        sw_cache = re.search(r'\bCACHE\s*=\s*"([^"]+)"', open(sw_path, encoding="utf-8").read())
        sw_cache = sw_cache.group(1) if sw_cache else None
        if not sw_cache:
            errs.append("sw.js 里找不到 CACHE 声明")

    html = open(DIST, encoding="utf-8").read()
    if 'id="boot"' not in html or 'id="boot-fill"' not in html:
        errs.append("index.html 里没有首屏搬运层（#boot）")
    if 'register("sw.js")' not in html:
        errs.append("index.html 里没有注册 Service Worker")

    m = re.search(r"window\.MOMO_ASSETS=(\[.*?\]);", html, re.S)
    if not m:
        errs.append("index.html 里没有 window.MOMO_ASSETS（首屏搬运清单）")
        return 0, 0, errs
    try:
        pairs = json.loads(m.group(1))
    except ValueError as e:
        errs.append("MOMO_ASSETS 不是合法 JSON：%s" % e)
        return 0, 0, errs

    total = sum(p[1] for p in pairs)
    if len(pairs) < 700:
        errs.append("搬运清单只有 %d 项，看着不完整（产物里有 790 张左右）" % len(pairs))
    if total < 100 * 1048576:
        errs.append("搬运清单合计才 %.1f MB，不像是全部美术资产" % (total / 1048576))
    missing = [p[0] for p in pairs if not os.path.exists(os.path.join(root, p[0]))]
    if missing:
        errs.append("清单里有 %d 个文件不存在（首屏会一直空转）：%s" % (len(missing), missing[:3]))

    # 内联代码里的缓存名必须与 sw.js 一致 —— 写岔了不报错，只是缓存永远对不上
    inlined = re.search(r'\bCACHE\s*=\s*"([^"]+)"', html)
    if not inlined or inlined.group(1) != sw_cache:
        errs.append("缓存名不一致：sw.js=%r  index.html 内联=%r"
                    % (sw_cache, inlined.group(1) if inlined else None))

    # 缓存读取必须自带兜底：读挂了要当「没有缓存」回源网络。
    # 少了它 → 导航永不 settle（浏览器弹自己的报错页）、图片请求直接失败（CSS 背景
    # 图失败不会显示裂图，就是那块 UI 干脆不画，用户看到「只有旧图能出来」）。
    # 这里不写死具体写法，只查「每个 c.match 附近都有个 catch 把异常吞掉」。
    sw_src = open(sw_path, encoding="utf-8").read() if os.path.exists(sw_path) else ""
    sw_src = sw_src.replace("\u3000", " ")
    for m in re.finditer(r"\.match\(", sw_src):
        near = sw_src[m.end():m.end() + 260]
        if "catch" not in near:
            errs.append("sw.js 里有一处 c.match 没接 catch 兜底（缓存读挂会打断请求）")
            break

    hdr = os.path.join(root, "_headers")
    if os.path.exists(hdr) and "/sw.js" not in open(hdr, encoding="utf-8").read():
        errs.append("_headers 里没有 /sw.js 的 no-cache 规则（SW 更新会被缓存挡住）")
    # 存储配额撞过一次之后不能再拦人（否则每次打开都被「正在搬运」挡一次）
    if "momo.preload.quota" not in html:
        errs.append("preload 没有记录「配额不够」的静默开关（会让你每次打开都被拦）")
    return len(pairs), total, errs


def check_manifest():
    """核对 Web App Manifest：文件在、独立模式、横屏、图标指向的文件真实存在。

    为什么在 Python 侧查：清单里的图标 src 是**构建算出来的内容哈希路径**，
    也是纯文件层面的对应关系。清单里的路径写错的话页面照样开、只是加主屏后
    图标是空白 —— 跟「传了 index.html 忘了传 assets/」是同一类静默翻车。"""
    path = os.path.join(os.path.dirname(DIST), "manifest.webmanifest")
    if not os.path.exists(path):
        return None, ["manifest.webmanifest 不存在（构建没生成或没传上去）"]
    try:
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
    except ValueError as e:
        return None, ["manifest.webmanifest 不是合法 JSON：%s" % e]
    errs = []
    if m.get("display") != "standalone":
        errs.append("display 应为 standalone，实际 %r" % m.get("display"))
    if m.get("orientation") != "landscape":
        errs.append("orientation 应为 landscape，实际 %r" % m.get("orientation"))
    icons = m.get("icons") or []
    want = {("192x192", "any"), ("512x512", "any"), ("512x512", "maskable")}
    got = set((i.get("sizes"), i.get("purpose")) for i in icons)
    if not want <= got:
        errs.append("图标缺档：%s" % sorted(want - got))
    root = os.path.dirname(DIST)
    for i in icons:
        src = i.get("src") or ""
        if not src.endswith(".png"):
            errs.append("图标应保持 png（iOS 不认 webp）：%s" % src)
        if not os.path.exists(os.path.join(root, src)):
            errs.append("图标文件不存在：%s" % src)
    return m, errs


def main():
    fresh = "--fresh" in sys.argv
    html = open(DIST, encoding="utf-8").read()
    assert "</body>" in html, "dist 缺少 </body>"
    if not fresh:
        # 必须在游戏脚本执行前写入存档，否则初始化已经跑完了
        assert "<head>" in html, "dist 缺少 <head>"
        html = html.replace("<head>", "<head>\n" + SEED_JS, 1)
    print("模式:", "空存档（首次进入）" if fresh else "旧存档（老玩家回归）")
    html = html.replace("</body>", TEST_JS + "\n</body>", 1)
    with open(TMP_HTML, "w", encoding="utf-8") as f:
        f.write(html)
    p = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                        "--window-size=1920,1080", "--hide-scrollbars",
                        "--virtual-time-budget=20000", "--dump-dom",
                        "file://" + TMP_HTML], capture_output=True, timeout=300)
    dom = p.stdout.decode("utf-8", "replace")
    os.remove(TMP_HTML)
    m = re.search(r'TESTRESULT:(\{.*?\})</div>', dom, re.S)
    if not m:
        print("FAIL: 未捕获到测试结果")
        print("stderr tail:", p.stderr.decode("utf-8", "replace")[-400:])
        return 1
    R = json.loads(m.group(1))
    # 图片引用全量核对（浏览器里只抽样，文件层面在这里查全）
    R["assetRefCount"], missing_refs = check_asset_refs(DIST)
    R["assetRefsMissing"] = missing_refs[:8]
    R["assetRefsExist"] = len(missing_refs) == 0
    # 外壳：自带字体真的生效 + 主屏独立模式的清单与 meta 齐全
    man, man_errs = check_manifest()
    R["manifestDisplay"] = (man or {}).get("display")
    R["manifestIcons"] = len((man or {}).get("icons") or [])
    R["manifestErr"] = man_errs[:8]
    R["manifestOk"] = len(man_errs) == 0
    R["shellPass"] = bool(R.get("fontFace") and R.get("fontFaceReady") and
                          R.get("pwaMeta") and R.get("rotateTip") and R.get("bootOffFile") and
                          R.get("btnBaseNoFilter"))
    # 离线兜底：SW + 首屏搬运清单（纯文件层面的对应关系，在 Python 侧查全）
    n_assets, bytes_assets, off_errs = check_offline_shell()
    R["offlineAssets"] = n_assets
    R["offlineBytes"] = round(bytes_assets / 1048576, 1)
    R["offlineErr"] = off_errs[:8]
    R["offlineOk"] = len(off_errs) == 0
    R["pass"] = (bool(R.get("pass")) and R["assetRefsExist"] and R["manifestOk"] and
                 R["shellPass"] and R["offlineOk"])
    print(json.dumps(R, ensure_ascii=False, indent=2))
    print("\n图片引用: %d 个，缺失 %d 个" % (R["assetRefCount"], len(missing_refs)))
    print("自带字体: %s（就绪 %s / 度量 %s）  清单: %s %s，图标 %d 个"
          % ("在" if R.get("fontFace") else "缺",
             R.get("fontFaceReady"), R.get("fontFaceW"),
             R.get("manifestDisplay"), "OK" if R["manifestOk"] else R["manifestErr"],
             R["manifestIcons"]))
    print("离线壳: %s（搬运清单 %d 项 %.1f MB）  file:// 下自动让开: %s"
          % ("OK" if R["offlineOk"] else R["offlineErr"],
             R["offlineAssets"], R["offlineBytes"], R.get("bootOffFile")))
    print("\nRESULT:", "PASS" if R.get("pass") else "FAIL")
    return 0 if R.get("pass") else 1


if __name__ == "__main__":
    sys.exit(main())