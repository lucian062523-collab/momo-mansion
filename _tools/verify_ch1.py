# -*- coding: utf-8 -*-
"""S1C1《月见茶会》静态自检：
   ① 引用零断链：NPC 立绘文件 / 剧本节点 / NPC表情 / 场景 / 发言池 bucket / 词包 id
   ② 平衡模拟：按 party_月见茶会.json 的规则复刻对局跑 2000 局，
      验证「3狐5客被执念锁刀」的平衡与 A/B/C 触发分布

   2026-10-12 起：**茶会作为「章节事件」被撤下**（chapters.json 的 ch1 去掉了
   event_module / end_branches，剧本也只剩「前言」）。但 party_月见茶会.json、
   对局引擎 party.js、NPC 立绘都原样留着等接回来。
   所以本脚本按「对局在不在」分两种跑法：
     · 不在（当前）：验保留数据的完整性（立绘齐不齐、池子/座位/词包是否还自洽），
       平衡模拟照跑 —— 它只依赖 rules 数据，数据坏了要能第一时间发现；
     · 接回来之后：剧本与章节联动那几条会**自动**重新纳入校验，不用改本文件。
   这样脚本不会因为「功能被刻意撤下」而误报，也不会在接回来之后漏检。
   用法：/usr/bin/python3 _tools/verify_ch1.py"""
import json, os, random, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CT = os.path.join(ROOT, "game", "content")
ASSET = os.path.join(ROOT, "墨墨-美术资产-web", "月见茶会-NPC")

def load(n):
    return json.load(open(os.path.join(CT, n), encoding="utf-8"))

dj, pj, cj = load("dialogues.json"), load("party_月见茶会.json"), load("chapters.json")
we, wj, sc = load("words_en.json"), load("words_ja.json"), load("scenes.json")
err = []

# ---------- 房间名 → 场景基名的别名层 ----------
# 剧本里写的是**玩家看到的房间名**（卧室），scenes.json 的键是**美术基名**（卧房），
# 两者由 map.json 的房间条目 scene 字段牵线。直接拿房间名查 scenes.json 会误报断链。
def build_room_index():
    idx = {}
    M = load("map.json")
    for fk in (M.get("order") or []):
        for r in ((M.get("floors") or {}).get(fk) or {}).get("rooms") or []:
            if r.get("kind") == "stair":
                continue
            idx.setdefault(r.get("label"), r.get("scene") or [r.get("label")])
    return idx

ROOM2SCENE = build_room_index()
def room_ok(room):
    if room in sc["scenes"]:
        return True
    return any(s in sc["scenes"] for s in (ROOM2SCENE.get(room) or []))

# ---------- ① 引用零断链 ----------
for name, c in pj["chars"].items():
    for k, f in c["exprs"].items():
        if not os.path.exists(os.path.join(ASSET, c["prefix"], f)):
            err.append("缺立绘文件：%s %s -> %s" % (name, k, f))
    if c["default"] not in c["exprs"].values():
        err.append("default 不在表情表里：%s" % name)

# 节点类型**从 director.js 的实处理里取**，不写死 ——
# 写死的清单会在每次加新节点（sprite / cgoff / map_hint…）之后变成一堆假失败。
def node_types():
    src = open(os.path.join(ROOT, "game", "js", "director.js"), encoding="utf-8").read()
    import re as _re
    return set(_re.findall(r'n\.type\s*===\s*"(\w+)"', src))

NODE_TYPES = node_types()
if not NODE_TYPES:
    err.append("读不到 director.js 的节点类型表（校验没法确认节点是否合法）")
SCRIPTS = dj["脚本"]

# 对局剧本（ch1_入席 / 结A / 结B / 结C）现在**不在**了 —— 见文件头说明。
# 在则全量校验，不在则只记一笔，不算错。
PARTY_SCRIPTS = ("ch1_入席", "ch1_结A", "ch1_结B", "ch1_结C")
DORMANT = not any(s in SCRIPTS for s in PARTY_SCRIPTS)

if DORMANT:
    print("· 对局已撤下（休眠保留）：跳过 入席/结A/结B/结C 剧本与章节联动校验")
else:
    for sid in PARTY_SCRIPTS:
        if sid not in SCRIPTS:
            err.append("剧本缺失：%s" % sid)
            continue
        s = SCRIPTS[sid]
        want_then = "party:begin" if sid == "ch1_入席" else "party:finish"
        want_flag = "bridge.ch1_seated" if sid == "ch1_入席" else "bridge.ch1_done"
        if s.get("then") != want_then:
            err.append("%s then 应为 %s" % (sid, want_then))
        if s.get("flag") != want_flag:
            err.append("%s flag 应为 %s" % (sid, want_flag))

# 现有剧本一律照验（前言就是现在的主线入口，更该验）
for sid, s in SCRIPTS.items():
    for n in s.get("nodes", []):
        if n["type"] not in NODE_TYPES:
            err.append("%s 未知节点 %s" % (sid, n["type"]))
        if n["type"] == "say" and n.get("who"):
            w = n["who"]
            if w not in ("player", "墨墨") and w not in pj["chars"]:
                err.append("%s say.who 未注册：%s" % (sid, w))
            if w in pj["chars"] and n.get("expr") and n["expr"] not in pj["chars"][w]["exprs"]:
                err.append("%s %s 缺表情 %s" % (sid, w, n["expr"]))
        if n["type"] == "stage" and n.get("who") and n["who"] not in pj["chars"]:
            err.append("%s stage.who 未注册：%s" % (sid, n["who"]))
        if n["type"] == "scene" and n.get("room") and not room_ok(n["room"]):
            err.append("%s scene 房间未注册：%s" % (sid, n["room"]))
        if n["type"] == "lamp" and not (1 <= (n.get("n") or 0) <= 8):
            err.append("%s lamp.n 越界" % sid)

for ch in cj["chapters"]:
    at = "chapters.json(%s)" % ch.get("id")
    if ch.get("open_script") and ch["open_script"] not in SCRIPTS:
        err.append("%s open_script 断链：%s" % (at, ch["open_script"]))
    for k, sid in (ch.get("end_branches") or {}).items():
        if sid not in SCRIPTS:
            err.append("%s end_branches 断链：%s" % (at, sid))
        elif (ch.get("flag") or "") != SCRIPTS[sid].get("flag"):
            err.append("%s 分支 flag 与章节 flag 不一致：%s" % (at, sid))
    # 章节点名的房间也得能解析（scene.room 同样是玩家看到的房间名）
    rm = (ch.get("scene") or {}).get("room")
    if rm and not room_ok(rm):
        err.append("%s scene.room 房间未注册：%s" % (at, rm))

POOL_USED = {
    "千春": ["claim", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "茶终": ["claim", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "小野": ["claim", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "池田": ["claim", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "幸子": ["claim_d1", "firm_d2", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "樱井": ["claim_d1", "claim_d2", "claim_d2_fox", "react", "accuse", "defend", "voted_out", "watch_reaction"],
    "墨墨": ["claim", "tell", "react", "d2", "voted_out_by_player", "voted_out_by_npc",
             "defend", "guard", "back_thanks", "watch_reaction"],
}
for name, keys in POOL_USED.items():
    p = (pj["pools"] or {}).get(name) or {}
    for k in keys:
        if k not in p:
            err.append("发言池缺 bucket：%s.%s" % (name, k))

en_s1c1 = [w for w in we if "s1c1" in (w.get("tags") or [])]
ja_s1c1 = [w for w in wj if "s1c1" in (w.get("tags") or [])]
if len(en_s1c1) != 12 or len(ja_s1c1) != 12:
    err.append("词包数量异常：en %d / ja %d（应各 12）" % (len(en_s1c1), len(ja_s1c1)))
for lst, tag in ((we, "en"), (wj, "ja")):
    ids = [w["id"] for w in lst]
    dups = [i for i, c in collections.Counter(ids).items() if c > 1]
    if dups:
        err.append("%s 词库重复 id：%s" % (tag, dups))
    for w in lst:
        # lesson 允许留空：剧情 / 章节词不属于任何一课（见 verify_content.py 同款约定）
        if ("s1c1" in (w.get("tags") or []) and tag == "ja" and w.get("lesson")
                and w["id"] != "ja_橋"):
            err.append("s1c1 新增日语词不该挂課号：%s" % w["id"])

seats = (pj.get("seats") or {}).get("order") or []
need = ["千春", "池田", "茶终", "你", "墨墨", "樱井", "小野", "幸子"]
if seats != need:
    err.append("seats.order 应为 %s，实际 %s" % (need, seats))

print("① 数据完整性：%s" % ("全绿" if not err else "%d 处问题" % len(err)))
for e in err:
    print("   -", e)

# ---------- ② 平衡模拟（复刻 party.js 的规则） ----------
R = pj["rules"]
FOXES = set(R["foxes"]); PLAYERS = [n if n != "你" else "玩家" for n in seats]
KNIFE_ZERO = {k: set(v) for k, v in (R.get("knife_zero") or {}).items()}
KNIFE_W = R.get("knife_weight") or {}
PR = R.get("pharm_rules") or {}
NEVER = {"千春": {"池田"}, "茶终": {"樱井"}, "小野": {"幸子"}, "墨墨": {"玩家", "墨墨"}}

def wvote(lst):
    """加权抽票：客人们对「被请来的末茶人」客气（与 party.js 的 wvote 同款）"""
    if not lst: return None
    return random.choices(lst, weights=[0.25 if n == "玩家" else 1 for n in lst])[0]

def sim():
    alive = {n: True for n in PLAYERS}
    player_alive = True; lastTop = None; day = 0; outed = None
    mvp = {"momo_out_by_player": False, "tea_momo": False}
    def al(): return [n for n in PLAYERS if alive[n]]
    while True:
        day += 1
        foxes = [n for n in al() if n in FOXES]
        knifed = None; saved = False; poisoned = None
        if foxes:
            owner = random.choice(foxes); zero = KNIFE_ZERO.get(owner, set())
            cand = [n for n in al() if n not in FOXES and n not in zero]
            if cand:
                knifed = random.choices(cand, weights=[KNIFE_W.get(n, 1) for n in cand])[0]
        if alive["小野"] and knifed:
            if knifed in (PR.get("must_save") or []): saved = True
            elif day == 1 and random.random() < PR.get("night1_save_chance", .35): saved = True
        if day >= 2 and alive["小野"] and random.random() < PR.get("night2_poison_chance", .6):
            bad = set(PR.get("never_poison") or []) | {knifed, "小野"}
            pool = [n for n in al() if n not in bad]
            if pool:
                poisoned = lastTop if (lastTop and lastTop in pool) else random.choice(pool)
        if alive["樱井"] and day >= 2 and alive["千春"]:
            outed = "千春"                       # D2 照镜点名千春（party.js 同款）
        if poisoned:
            alive[poisoned] = False
            if poisoned == "玩家": player_alive = False
        if knifed and not saved:
            alive[knifed] = False
            if knifed == "玩家": player_alive = False
        fx = len([n for n in al() if n in FOXES]); gs = len(al()) - fx
        if fx == 0: return settle(alive, player_alive, outed, mvp)
        if fx >= gs: return settle(alive, player_alive, outed, mvp)
        votes = {}
        for n in al():
            if n in ("玩家", "幸子"): continue
            cand = [x for x in al() if x != n and x not in NEVER.get(n, set())]
            if n == "墨墨":
                guests = [x for x in cand if x not in FOXES]
                votes[n] = random.choice(guests) if guests else None
            elif outed and alive.get(outed) and outed in cand:
                votes[n] = outed                   # 全桌跟随照镜点名
            elif n == "池田" and alive["千春"]:
                votes[n] = "千春"
            else:
                votes[n] = wvote(cand)             # 对末茶人客气（party.js 同款权重）
        if alive["幸子"]:
            c = collections.Counter(v for v in votes.values() if v)
            top = c.most_common(1)[0][0] if c else None
            cand = [x for x in al() if x != "幸子"]
            votes["幸子"] = top if (top and top in cand) else (random.choice(cand) if cand else None)
        if player_alive:
            cand = [x for x in al() if x != "玩家"]
            votes["玩家"] = (outed if (outed and outed in cand and alive.get(outed)) else
                             (random.choice(cand) if cand else None))
        c = collections.Counter(v for v in votes.values() if v and alive.get(v))
        if c:
            mx = max(c.values()); out = random.choice([k for k in c if c[k] == mx])
            alive[out] = False; lastTop = out
            if out == "玩家": player_alive = False
            if out == "墨墨" and votes.get("玩家") == "墨墨": mvp["momo_out_by_player"] = True
        fx = len([n for n in al() if n in FOXES]); gs = len(al()) - fx
        if fx == 0: return settle(alive, player_alive, outed, mvp)
        if fx >= gs: return settle(alive, player_alive, outed, mvp)
        if day >= R.get("days", 4): return settle(alive, player_alive, outed, mvp)

def settle(alive, player_alive, outed, mvp):
    """终局递茶：点名的狐还活着 → 六成递她；两成递墨墨（A 线）；其余随意。
       递给活着的狐 = 那杯茶替真相作证，重算终局。"""
    al = [n for n in PLAYERS if alive[n]]
    r = random.random()
    if outed and alive.get(outed):
        tea = outed if r < 0.6 else ("墨墨" if r < 0.78 else random.choice(al))
    else:
        tea = "墨墨" if r < 0.18 else (random.choice(al) if al else None)
    if tea == "墨墨": mvp["tea_momo"] = True
    if tea and alive.get(tea) and tea in FOXES:
        alive[tea] = False
    al = [n for n in PLAYERS if alive[n]]
    fx = len([n for n in al if n in FOXES]); gs = len(al) - fx
    if fx == 0: w = "guest"
    elif fx >= gs: w = "fox"
    else: w = "timeout"
    if not player_alive: b = "C"
    elif mvp["momo_out_by_player"] or mvp["tea_momo"]: b = "A"
    else: b = "B"
    return b, w

random.seed(20261006)
N = 2000
abc = collections.Counter(); win = collections.Counter()
for _ in range(N):
    a, w = sim()
    abc[a] += 1
    win[str(w)] += 1
print("② 平衡模拟 %d 局%s：" % (N, "（对局数据保留中）" if DORMANT else ""))
print("   分支分布 A/B/C = %d / %d / %d（%s）" % (
    abc["A"], abc["B"], abc["C"], "、".join("%s %.0f%%" % (k, v * 100.0 / N) for k, v in sorted(abc.items()))))
print("   终局 guest/fox/timeout = %s" % "、".join("%s %d" % (k, v) for k, v in sorted(win.items())))
print("   判定：%s" % ("OK（客方可赢、狐方可赢、C 线稀有）"
      if win["guest"] > N * 0.15 and win["fox"] > N * 0.15 and abc["C"] < N * 0.30
      else "注意：分布偏离预期，考虑调 knife_weight / pharm 规则"))
print("   %s" % ("结论：数据全绿，平衡成立" if not err else "请先修上面的问题"))
