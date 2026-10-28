import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { storage } from "./storage";

/* ---------- palette ---------- */
const PALETTE = {
  green:  ["#DCFCE7", "#BBF7D0", "#86EFAC", "#4ADE80", "#22C55E"],
  teal:   ["#CCFBF1", "#99F6E4", "#5EEAD4", "#2DD4BF", "#14B8A6"],
  blue:   ["#E0F2FE", "#BAE6FD", "#7DD3FC", "#38BDF8", "#0EA5E9"],
  indigo: ["#E0E7FF", "#C7D2FE", "#A5B4FC", "#818CF8", "#6366F1"],
  purple: ["#F3E8FF", "#E9D5FF", "#D8B4FE", "#C084FC", "#A855F7"],
  rose:   ["#FCE7F3", "#FBCFE8", "#F9A8D4", "#F472B6", "#EC4899"],
  red:    ["#FEE2E2", "#FECACA", "#FCA5A5", "#F87171", "#EF4444"],
  orange: ["#FFEDD5", "#FED7AA", "#FDBA74", "#FB923C", "#F97316"],
  amber:  ["#FEF3C7", "#FDE68A", "#FCD34D", "#FBBF24", "#F59E0B"],
};
const COLOR_KEYS = Object.keys(PALETTE);
const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const NAME_W = 116;
const ROW_H = 60;
const STAT_W = 74;
const VISIBLE = 5;
const MIN_HISTORY = 60;

/* リボンの太さ。日ごとの値のあいだを曲線でつなぐので段差にならない */
const BAND = { full: 36, rest: 26, half: 14 };
const PLATEAU = 0.5; // 1日のうち太さを保つ割合。残りが遷移区間

/* ---------- date ---------- */
const key = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const shift = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const gap = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
const INTERVAL_LABEL = (n) => (n === 1 ? "毎日" : n === 7 ? "週1回" : `${n}日に1回`);

/* 一時休止期間は習慣データとは別に保存し、表示・集計時だけ half として重ねる */
const inPause = (day, pauses) => pauses.some((p) => p.start <= day && day <= p.end);
function withPauses(days, pauses) {
  if (!pauses.length) return days;
  const next = { ...(days || {}) };
  const today = key(new Date());
  pauses.forEach(({ start, end }) => {
    if (!start || !end || start > end || start > today) return;
    const last = end < today ? end : today;
    for (let d = parse(start); key(d) <= last; d = shift(d, 1)) {
      const k = key(d);
      next[k] = { ...next[k], state: "half" };
    }
  });
  return next;
}

/* ---------- streak ---------- */
const split = (days) => {
  const fulls = [], halves = [];
  for (const [d, v] of Object.entries(days || {})) {
    if (v?.state === "full") fulls.push(d);
    else if (v?.state === "half") halves.push(d);
  }
  fulls.sort(); halves.sort();
  return { fulls, halves };
};
const skipped = (halves, a, b) => halves.filter((d) => gap(d, a) > 0 && gap(b, d) >= 0).length;
const effGap = (halves, a, b) => gap(b, a) - skipped(halves, a, b);

function stats(days, interval, today) {
  const { fulls, halves } = split(days);
  if (!fulls.length)
    return { current: 0, best: 0, total: 0, alive: false, doneToday: false, restDay: false, daysLeft: 0 };

  let best = 1, run = 1;
  for (let i = 1; i < fulls.length; i++) {
    run = effGap(halves, fulls[i - 1], fulls[i]) <= interval ? run + 1 : 1;
    if (run > best) best = run;
  }
  let current = 1;
  for (let i = fulls.length - 1; i > 0; i--) {
    if (effGap(halves, fulls[i - 1], fulls[i]) <= interval) current++;
    else break;
  }
  const since = Math.max(0, effGap(halves, fulls[fulls.length - 1], today));
  const alive = since <= interval;
  return {
    current: alive ? current : 0,
    best,
    total: fulls.length,
    alive,
    doneToday: days[today]?.state === "full",
    restDay: alive && since > 0 && since < interval,
    daysLeft: Math.max(0, interval - since),
  };
}

function cellState(days, fulls, halves, interval, day, today) {
  const v = days[day];
  const future = gap(day, today) > 0;
  if (v?.state === "full") {
    let n = 1, i = fulls.indexOf(day);
    while (i > 0 && effGap(halves, fulls[i - 1], fulls[i]) <= interval) { n++; i--; }
    return { band: "full", note: v.note, future };
  }
  const prev = [...fulls].reverse().find((c) => gap(day, c) > 0);
  const covered = !future && !!prev && effGap(halves, prev, day) < interval;
  return { band: v?.state === "half" ? "half" : covered ? "rest" : null, note: v?.note, future };
}

/* ---------- 濃度 ----------
   1実施ごとに1段濃くなり、10実施で最濃。
   10を超えた連鎖は、初日が最薄・最終日が最濃になるよう全体を細分化して割り直す。 */
const RAMP_STEPS = 10;

function chainTones(fulls, halves, interval) {
  const chains = [];
  let cur = [];
  fulls.forEach((d, i) => {
    if (i === 0 || effGap(halves, fulls[i - 1], d) <= interval) cur.push(d);
    else { chains.push(cur); cur = [d]; }
  });
  if (cur.length) chains.push(cur);

  const t = {};
  chains.forEach((ch) => {
    const denom = Math.max(RAMP_STEPS, ch.length);
    ch.forEach((d, k) => { t[d] = (k + 1) / denom; });
  });
  return t;
}

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
function ramp(shades, t) {
  const x = Math.max(0, Math.min(1, t)) * (shades.length - 1);
  const i = Math.min(shades.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex2rgb(shades[i]), b = hex2rgb(shades[i + 1]);
  return rgb2hex(a.map((v, n) => v + (b[n] - v) * f));
}

/* ---------- リボンのパス生成 ---------- */
function ribbon(segment, colW, cy) {
  const p = segment.map(({ i, r }) => {
    const cx = (i + 0.5) * colW;
    const w = (colW * PLATEAU) / 2;
    return { a: cx - w, b: cx + w, r };
  });
  const n = p.length;
  let d = `M ${p[0].a} ${cy - p[0].r}`;
  for (let k = 0; k < n; k++) {
    d += ` L ${p[k].b} ${cy - p[k].r}`;
    if (k < n - 1) {
      const x1 = p[k].b, x2 = p[k + 1].a, m = (x2 - x1) / 2;
      d += ` C ${x1 + m} ${cy - p[k].r} ${x2 - m} ${cy - p[k + 1].r} ${x2} ${cy - p[k + 1].r}`;
    }
  }
  const last = p[n - 1];
  d += ` A ${last.r} ${last.r} 0 0 1 ${last.b} ${cy + last.r}`;
  for (let k = n - 1; k >= 0; k--) {
    d += ` L ${p[k].a} ${cy + p[k].r}`;
    if (k > 0) {
      const x1 = p[k].a, x2 = p[k - 1].b, m = (x1 - x2) / 2;
      d += ` C ${x1 - m} ${cy + p[k].r} ${x2 + m} ${cy + p[k - 1].r} ${x2} ${cy + p[k - 1].r}`;
    }
  }
  d += ` A ${p[0].r} ${p[0].r} 0 0 1 ${p[0].a} ${cy - p[0].r} Z`;
  return d;
}

/* 日付をまたいでも表示が古びないよう、復帰時に再描画する */
function useDateTick() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    document.addEventListener("visibilitychange", f);
    window.addEventListener("focus", f);
    const id = setInterval(f, 60000);
    return () => {
      document.removeEventListener("visibilitychange", f);
      window.removeEventListener("focus", f);
      clearInterval(id);
    };
  }, []);
}

/* ---------- app ---------- */
export default function StreakApp() {
  const [habits, setHabits] = useState([]);
  const [pauses, setPauses] = useState([]);
  const [ready, setReady] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [colW, setColW] = useState(56);
  const scroller = useRef(null);
  const press = useRef({ timer: null, long: false, x: 0, y: 0 });

  useDateTick();
  const today = key(new Date());
  const active = habits.filter((h) => !h.archived);
  const archived = habits.filter((h) => h.archived);

  useEffect(() => {
    (async () => {
      try {
        const habitData = await storage.get("streaks:habits");
        if (habitData?.value) {
          const saved = JSON.parse(habitData.value);
          if (Array.isArray(saved)) setHabits(saved.map(migrate));
        }
      } catch (e) { /* 初回、または壊れた習慣データ */ }
      try {
        const pauseData = await storage.get("streaks:pauses");
        if (pauseData?.value) {
          const saved = JSON.parse(pauseData.value);
          if (Array.isArray(saved)) setPauses(saved.filter((p) => p?.id && p?.start && p?.end));
        }
      } catch (e) { /* 初回、または壊れた一時休止データ */ }
      setReady(true);
    })();
  }, []);

  const history = useMemo(() => {
    let oldest = today;
    for (const h of habits)
      if (!h.archived) for (const d of Object.keys(h.days || {})) if (d < oldest) oldest = d;
    return Math.max(MIN_HISTORY, gap(today, oldest) + 3);
  }, [habits, today]);

  const days = useMemo(() => {
    const now = new Date();
    return Array.from({ length: history }, (_, i) => shift(now, i - (history - 1)));
  }, [history, today]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => setColW(Math.max(46, (el.clientWidth - NAME_W) / VISIBLE));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, habits.length]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;
    /* 実寸から逆算する。列幅の端数が積み上がっても今日が右端に揃う */
    const id = requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth - 3 * STAT_W);
    });
    return () => cancelAnimationFrame(id);
  }, [colW, ready, history, active.length]);

  const commit = useCallback((next) => {
    setHabits(next);
    storage.set("streaks:habits", JSON.stringify(next)).catch(() => {});
  }, []);

  const commitPauses = useCallback((next) => {
    setPauses(next);
    storage.set("streaks:pauses", JSON.stringify(next)).catch(() => {});
  }, []);

  const patchDay = (id, day, fn) =>
    commit(habits.map((h) => {
      if (h.id !== id) return h;
      const next = fn(h.days[day]);
      const d = { ...h.days };
      if (!next || (!next.state && !next.note)) delete d[day];
      else d[day] = next;
      return { ...h, days: d };
    }));

  const cycle = (id, day) => {
    if (gap(day, today) > 0) return;
    patchDay(id, day, (cur) => {
      const s = cur?.state;
      const next = s === "full" ? "half" : s === "half" ? null : "full";
      return next ? { ...cur, state: next } : { note: cur?.note };
    });
  };

  const down = (e, id, day) => {
    press.current = { timer: null, long: false, x: e.clientX, y: e.clientY };
    press.current.timer = setTimeout(() => {
      press.current.long = true;
      setSheet({ mode: "note", id, day });
    }, 450);
  };
  const move = (e) => {
    const p = press.current;
    if (p.timer && (Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8)) {
      clearTimeout(p.timer); p.timer = null;
    }
  };
  const up = (id, day) => {
    clearTimeout(press.current.timer);
    if (!press.current.long) cycle(id, day);
    press.current.long = false;
  };

  if (!ready)
    return <div className="min-h-screen bg-white flex items-center justify-center text-neutral-400 text-sm">読み込み中</div>;

  const gridW = history * colW;
  const contentW = NAME_W + gridW + 3 * STAT_W;
  const cy = ROW_H / 2;

  return (
    <div className="min-h-screen bg-white text-neutral-900 select-none">
      <div className="mx-auto max-w-md" style={{ paddingTop: "max(12px, env(safe-area-inset-top))" }}>
        {active.length === 0 ? (
          <Empty onMenu={() => setSheet({ mode: "data" })}
            onAdd={() => setSheet({ mode: "add" })} onSeed={() => commit(seed(today))} />
        ) : (
          <div ref={scroller} className="overflow-x-auto overscroll-x-contain no-scrollbar">
            <div style={{ width: contentW }}>
              <div className="flex" style={{ height: 56 }}>
                <div className="sticky left-0 z-20 bg-white flex items-end pb-2 pl-4"
                  style={{ width: NAME_W, minWidth: NAME_W }}>
                  <button onClick={() => setSheet({ mode: "data" })} aria-label="メニュー"
                    className="w-8 h-8 rounded-full hover:bg-neutral-100 text-neutral-400 text-lg leading-none">⋯</button>
                </div>
                {days.map((d) => {
                  const k = key(d);
                  const weekend = d.getDay() === 6 ? "text-blue-600" : d.getDay() === 0 ? "text-red-600" : "text-neutral-400";
                  const dateColor = d.getDay() === 6 ? "text-blue-600" : d.getDay() === 0 ? "text-red-600" : "text-neutral-700";
                  return (
                    <div key={k} style={{ width: colW, minWidth: colW }} className="text-center">
                      <div className={`text-[10px] tracking-wider ${weekend}`}>{WD[d.getDay()]}</div>
                      <div className={"mx-auto mt-1 w-7 h-7 flex items-center justify-center rounded-full text-[15px] tabular-nums " +
                        (k === today
                          ? d.getDay() === 6 ? "bg-blue-50 text-blue-600 font-medium ring-1 ring-blue-200"
                            : d.getDay() === 0 ? "bg-red-50 text-red-600 font-medium ring-1 ring-red-200"
                              : "bg-green-600 text-white font-medium"
                          : dateColor)}>{d.getDate()}</div>
                    </div>
                  );
                })}
                {["現在の\n連続回数", "最高\n連続回数", "合計\n回数"].map((t) => (
                  <div key={t} style={{ width: STAT_W, minWidth: STAT_W }} className="flex items-end justify-center pb-1.5">
                    <span className="text-[10px] leading-tight text-neutral-400 text-center whitespace-pre-line">{t}</span>
                  </div>
                ))}
              </div>

              {active.map((h) => {
                const effectiveDays = withPauses(h.days, pauses);
                const { fulls, halves } = split(effectiveDays);
                const st = stats(effectiveDays, h.interval, today);
                const shades = PALETTE[h.color] || PALETTE.green;
                const tones = chainTones(fulls, halves, h.interval);
                const cells = days.map((d) => {
                  const k = key(d);
                  return { ...cellState(effectiveDays, fulls, halves, h.interval, k, today), k, paused: inPause(k, pauses) };
                });
                /* 実施日で濃くなり、お休み・延命はその濃さを引き継ぐ */
                let carry = null;
                cells.forEach((c) => {
                  if (!c.band) { carry = null; c.tone = null; return; }
                  if (c.band === "full") carry = ramp(shades, tones[c.k] ?? 1 / RAMP_STEPS);
                  else if (carry === null) carry = shades[1];
                  c.tone = carry;
                });

                /* 連なりごとにリボンを1本ずつ */
                const segments = [];
                let cur = [];
                cells.forEach((c, i) => {
                  if (c.band) cur.push({ i, r: BAND[c.band] / 2 });
                  else if (cur.length) { segments.push(cur); cur = []; }
                });
                if (cur.length) segments.push(cur);

                const gid = `g-${h.id}`;
                const stops = [];
                cells.forEach((c, i) => {
                  if (!c.band) return;
                  const cx = (i + 0.5) * colW, w = (colW * PLATEAU) / 2;
                  stops.push([(cx - w) / gridW, c.tone], [(cx + w) / gridW, c.tone]);
                });

                const dueIdx = st.alive && st.daysLeft === 0 && !st.doneToday ? history - 1 : -1;

                return (
                  <div key={h.id} className="flex" style={{ height: ROW_H }}>
                    <button onClick={() => setSheet({ mode: "detail", id: h.id })}
                      style={{ width: NAME_W, minWidth: NAME_W }}
                      className="sticky left-0 z-20 bg-white pl-4 pr-2 text-left flex flex-col justify-center">
                      <span className="text-[13px] leading-tight text-neutral-700 line-clamp-2">{h.name}</span>
                      <span className="mt-1 self-start px-1.5 py-px rounded text-[10px]"
                        style={{ background: shades[0], color: shades[4] }}>{INTERVAL_LABEL(h.interval)}</span>
                    </button>

                    <div className="relative" style={{ width: gridW, height: ROW_H }}>
                      <svg width={gridW} height={ROW_H} className="absolute inset-0 pointer-events-none"
                        style={{ overflow: "visible" }}>
                        {stops.length > 0 && (
                          <defs>
                            <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={gridW} y2="0">
                              {stops.map(([o, c], n) => <stop key={n} offset={o} stopColor={c} />)}
                            </linearGradient>
                          </defs>
                        )}
                        {segments.map((s, n) => (
                          <path key={n} d={ribbon(s, colW, cy)} fill={`url(#${gid})`} />
                        ))}
                        {dueIdx >= 0 && (() => {
                          const cx = (dueIdx + 0.5) * colW, w = (colW * PLATEAU) / 2, r = BAND.full / 2;
                          return (
                            <rect x={cx - w - r} y={cy - r} width={2 * (w + r)} height={2 * r} rx={r}
                              fill="none" stroke={shades[2]} strokeWidth="2" strokeDasharray="5 5" />
                          );
                        })()}
                      </svg>

                      <div className="absolute inset-0 flex">
                        {days.map((d, i) => {
                          const k = key(d);
                          const c = cells[i];
                          return (
                            <button key={k}
                              onPointerDown={(e) => !c.future && !c.paused && down(e, h.id, k)}
                              onPointerMove={move}
                              onPointerUp={() => !c.future && !c.paused && up(h.id, k)}
                              onPointerLeave={() => clearTimeout(press.current.timer)}
                              onPointerCancel={() => clearTimeout(press.current.timer)}
                              onContextMenu={(e) => e.preventDefault()}
                              disabled={c.future || c.paused}
                              aria-label={`${h.name} ${k}`}
                              style={{ width: colW, minWidth: colW, height: ROW_H, touchAction: "pan-x" }}
                              className="relative disabled:cursor-default">
                              {c.note && (
                                <span className="absolute left-1/2 bottom-0.5 -translate-x-1/2 px-1 rounded bg-white/85 text-[9px] leading-[12px] text-neutral-500 max-w-full truncate">
                                  {c.note.slice(0, 3)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {[st.current, st.best, st.total].map((v, i) => (
                      <div key={i} style={{ width: STAT_W, minWidth: STAT_W }} className="flex items-center justify-center">
                        <span className={"text-lg tabular-nums " + (i === 0 && v > 0 ? "text-neutral-800" : "text-neutral-400")}>{v}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {sheet?.mode === "add" && (
        <Editor onClose={() => setSheet(null)}
          onSave={(h) => { commit([...habits, { ...h, id: crypto.randomUUID(), days: {} }]); setSheet(null); }} />
      )}
      {sheet?.mode === "detail" && (
        <Detail habit={habits.find((h) => h.id === sheet.id)} pauses={pauses} today={today}
          onClose={() => setSheet(null)}
          onSave={(p) => { commit(habits.map((h) => (h.id === sheet.id ? { ...h, ...p } : h))); setSheet(null); }}
          onArchive={() => { commit(habits.map((h) => (h.id === sheet.id ? { ...h, archived: true } : h))); setSheet(null); }}
          onDelete={() => { commit(habits.filter((h) => h.id !== sheet.id)); setSheet(null); }} />
      )}
      {sheet?.mode === "note" && (
        <NoteSheet habit={habits.find((h) => h.id === sheet.id)} day={sheet.day}
          onClose={() => setSheet(null)}
          onSave={(note) => { patchDay(sheet.id, sheet.day, (cur) => ({ ...cur, note: note || undefined })); setSheet(null); }} />
      )}
      {sheet?.mode === "order" && (
        <Reorder habits={active} onChange={(n) => commit([...n, ...archived])} onClose={() => setSheet(null)} />
      )}
      {sheet?.mode === "data" && (
        <MenuSheet habits={habits} archived={archived} pauses={pauses} onPausesChange={commitPauses} onReplace={commit}
          onAdd={() => setSheet({ mode: "add" })}
          onOrder={() => setSheet({ mode: "order" })}
          onRestore={(id) => commit(habits.map((h) => (h.id === id ? { ...h, archived: false } : h)))}
          onDelete={(id) => commit(habits.filter((h) => h.id !== id))}
          onClose={() => setSheet(null)} />
      )}

      <style>{`.no-scrollbar::-webkit-scrollbar{display:none}.no-scrollbar{scrollbar-width:none}`}</style>
    </div>
  );
}

function migrate(h) {
  if (h.days) return h;
  const days = {};
  (h.checks || []).forEach((d) => { days[d] = { state: "full" }; });
  const { checks, ...rest } = h;
  return { ...rest, days };
}

/* ---------- 並び替え ---------- */
function Reorder({ habits, onChange, onClose }) {
  const move = (i, d) => {
    const n = [...habits];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    onChange(n);
  };
  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] tracking-widest text-neutral-400 mb-4">並び替え</div>
      <ul>
        {habits.map((h, i) => (
          <li key={h.id} className="flex items-center gap-3 py-2 border-b border-neutral-100 last:border-0">
            <span className="w-5 h-2.5 rounded-full shrink-0" style={{ background: (PALETTE[h.color] || PALETTE.green)[3] }} />
            <span className="flex-1 text-sm text-neutral-700 truncate">{h.name}</span>
            <span className="text-[10px] text-neutral-400 shrink-0">{INTERVAL_LABEL(h.interval)}</span>
            <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="上へ"
              className="w-9 h-9 rounded-full border border-neutral-200 text-neutral-500 disabled:opacity-25">▲</button>
            <button onClick={() => move(i, 1)} disabled={i === habits.length - 1} aria-label="下へ"
              className="w-9 h-9 rounded-full border border-neutral-200 text-neutral-500 disabled:opacity-25">▼</button>
          </li>
        ))}
      </ul>
      <button onClick={onClose} className="mt-6 w-full py-3 rounded-full bg-neutral-900 text-white text-sm">閉じる</button>
    </Sheet>
  );
}

/* ---------- データの書き出し・読み込み ---------- */
function MenuSheet({ habits, archived, pauses, onPausesChange, onAdd, onOrder, onReplace, onRestore, onDelete, onClose }) {
  const today = key(new Date());
  const [tab, setTab] = useState("pause");
  const [pauseStart, setPauseStart] = useState(today);
  const [pauseEnd, setPauseEnd] = useState(today);
  const [raw, setRaw] = useState("");
  const [pending, setPending] = useState(null);
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  const json = useMemo(() => JSON.stringify(habits, null, 2), [habits]);
  const count = habits.reduce((n, h) => n + Object.keys(h.days || {}).length, 0);

  const download = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `streaks-${key(new Date())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(json); setMsg("コピーしました"); }
    catch { setMsg("コピーできませんでした。下の文字列を選択してください"); }
  };

  const inspect = (text) => {
    setMsg("");
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error();
      const cleaned = parsed
        .filter((h) => h && typeof h.name === "string")
        .map((h) => {
          const m = migrate(h);
          return {
            id: m.id || crypto.randomUUID(),
            name: m.name,
            color: PALETTE[m.color] ? m.color : "green",
            interval: Number(m.interval) > 0 ? Number(m.interval) : 1,
            days: m.days && typeof m.days === "object" ? m.days : {},
            archived: !!m.archived,
          };
        });
      if (!cleaned.length) throw new Error();
      setPending(cleaned);
    } catch {
      setPending(null);
      setMsg("読み取れませんでした。書き出したJSONをそのまま貼ってください");
    }
  };

  const pickFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setRaw(String(r.result)); inspect(String(r.result)); };
    r.readAsText(f);
  };

  const addPause = () => {
    if (!pauseStart || !pauseEnd || pauseStart > pauseEnd) return;
    const next = [...pauses, { id: crypto.randomUUID(), start: pauseStart, end: pauseEnd }]
      .sort((a, b) => a.start.localeCompare(b.start));
    onPausesChange(next);
  };

  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] tracking-widest text-neutral-400 mb-4">メニュー</div>
      <div className="grid grid-cols-2 gap-3 mb-5">
        <button onClick={onAdd}
          className="py-3 rounded-full bg-neutral-900 text-white text-sm">＋ 新しい習慣</button>
        <button onClick={onOrder} disabled={habits.filter((h) => !h.archived).length < 2}
          className="py-3 rounded-full border border-neutral-200 text-sm text-neutral-700 disabled:opacity-30">⇅ 並び替え</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {[["pause", `一時休止${pauses.length ? ` ${pauses.length}` : ""}`], ["rest", `習慣の休止${archived.length ? ` ${archived.length}` : ""}`], ["out", "書き出し"], ["in", "読み込み"]].map(([v, l]) => (
          <button key={v} onClick={() => { setTab(v); setMsg(""); }}
            className={"px-3 py-1.5 rounded-full text-sm border " +
              (tab === v ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-600")}>{l}</button>
        ))}
      </div>

      {tab === "pause" ? (
        <div className="mt-5">
          <p className="text-[13px] text-neutral-500 leading-relaxed">
            テスト前などの期間を、すべての習慣で一時休止にします。連鎖は続きますが、この期間は実施回数に数えません。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="text-[11px] text-neutral-400">
              開始日
              <input type="date" value={pauseStart} onChange={(e) => setPauseStart(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 outline-none focus:border-neutral-900" />
            </label>
            <label className="text-[11px] text-neutral-400">
              終了日
              <input type="date" value={pauseEnd} min={pauseStart} onChange={(e) => setPauseEnd(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 outline-none focus:border-neutral-900" />
            </label>
          </div>
          <button onClick={addPause} disabled={!pauseStart || !pauseEnd || pauseStart > pauseEnd}
            className="mt-4 w-full py-3 rounded-full bg-neutral-900 text-white text-sm disabled:opacity-30">
            この期間を一時休止にする
          </button>
          {pauses.length > 0 && (
            <ul className="mt-5 border-t border-neutral-100">
              {pauses.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-3 border-b border-neutral-100">
                  <span className="flex-1 text-sm text-neutral-700 tabular-nums">
                    {p.start.replaceAll("-", "/")} 〜 {p.end.replaceAll("-", "/")}
                  </span>
                  <button onClick={() => onPausesChange(pauses.filter((x) => x.id !== p.id))}
                    className="text-[13px] text-neutral-400 hover:text-red-500">解除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : tab === "rest" ? (
        <div className="mt-5">
          {archived.length === 0 ? (
            <p className="text-[13px] text-neutral-400 leading-relaxed">
              休止中の習慣はありません。習慣名をタップ →「休止する」で、記録を残したまま一覧から外せます。
            </p>
          ) : (
            <ul>
              {archived.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-3 border-b border-neutral-100 last:border-0">
                  <span className="w-5 h-2.5 rounded-full shrink-0" style={{ background: (PALETTE[h.color] || PALETTE.green)[3] }} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-neutral-700 truncate">{h.name}</span>
                    <span className="block text-[10px] text-neutral-400">
                      {INTERVAL_LABEL(h.interval)}・記録 {Object.keys(h.days || {}).length}日
                    </span>
                  </span>
                  <button onClick={() => onRestore(h.id)}
                    className="px-3 py-1.5 rounded-full border border-neutral-200 text-[13px] shrink-0">再開</button>
                  <button onClick={() => { if (confirm(`「${h.name}」の記録をすべて削除します。よろしいですか。`)) onDelete(h.id); }}
                    aria-label="削除" className="text-[13px] text-neutral-300 hover:text-red-500 shrink-0">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : tab === "out" ? (
        <div className="mt-5">
          <p className="text-[13px] text-neutral-500">習慣 {habits.length}件・記録 {count}日分</p>
          <div className="mt-4 flex gap-3">
            <button onClick={download} className="flex-1 py-3 rounded-full bg-neutral-900 text-white text-sm">ファイルに保存</button>
            <button onClick={copy} className="flex-1 py-3 rounded-full border border-neutral-200 text-sm">コピー</button>
          </div>
          <textarea readOnly value={json} rows={6} onFocus={(e) => e.target.select()}
            className="mt-4 w-full rounded-lg border border-neutral-200 p-3 text-[11px] font-mono text-neutral-500 outline-none resize-none" />
        </div>
      ) : (
        <div className="mt-5">
          <p className="text-[13px] text-neutral-500 leading-relaxed">
            書き出したJSONを読み込むと、いまの記録は<b className="text-neutral-800">すべて置き換わります</b>。
          </p>
          <input ref={fileRef} type="file" accept="application/json,.json" onChange={pickFile} className="hidden" />
          <button onClick={() => fileRef.current?.click()}
            className="mt-4 w-full py-3 rounded-full border border-neutral-200 text-sm">ファイルを選ぶ</button>
          <textarea value={raw} rows={5} placeholder="または、ここにJSONを貼り付け"
            onChange={(e) => { setRaw(e.target.value); if (e.target.value.trim()) inspect(e.target.value); else setPending(null); }}
            className="mt-3 w-full rounded-lg border border-neutral-200 p-3 text-[11px] font-mono outline-none focus:border-neutral-900 resize-none" />
          {pending && (
            <button onClick={() => { onReplace(pending); onClose(); }}
              className="mt-4 w-full py-3 rounded-full bg-neutral-900 text-white text-sm">
              習慣 {pending.length}件で置き換える
            </button>
          )}
        </div>
      )}

      {msg && <p className="mt-3 text-[12px] text-neutral-500">{msg}</p>}
    </Sheet>
  );
}

/* ---------- メモ ---------- */
function NoteSheet({ habit, day, onClose, onSave }) {
  const [text, setText] = useState(habit?.days?.[day]?.note ?? "");
  if (!habit) return null;
  const d = parse(day);
  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] tracking-widest text-neutral-400 mb-1">MEMO</div>
      <div className="text-sm text-neutral-700">
        {habit.name}・{d.getMonth() + 1}月{d.getDate()}日（{"日月火水木金土"[d.getDay()]}）
      </div>
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="この日のこと"
        className="mt-4 w-full rounded-lg border border-neutral-200 p-3 text-sm outline-none focus:border-neutral-900 resize-none" />
      <div className="mt-4 flex gap-3">
        <button onClick={() => onSave("")} className="flex-1 py-3 rounded-full border border-neutral-200 text-sm text-neutral-500">消す</button>
        <button onClick={() => onSave(text.trim())} className="flex-1 py-3 rounded-full bg-neutral-900 text-white text-sm">保存</button>
      </div>
    </Sheet>
  );
}

/* ---------- empty / seed ---------- */
function Empty({ onMenu, onAdd, onSeed }) {
  return (
    <>
      <div className="h-14 flex items-end px-4 pb-2">
        <button onClick={onMenu} aria-label="メニュー"
          className="w-8 h-8 rounded-full hover:bg-neutral-100 text-neutral-400 text-lg leading-none">⋯</button>
      </div>
      <div className="px-4 py-24 text-center">
        <p className="text-neutral-500 text-sm leading-relaxed">習慣がまだありません。</p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <button onClick={onAdd} className="px-5 py-2 rounded-full bg-neutral-900 text-white text-sm">習慣を追加</button>
          <button onClick={onSeed} className="text-xs text-neutral-400 underline">サンプルで試す</button>
        </div>
      </div>
    </>
  );
}
function seed(today) {
  const back = (n) => key(shift(parse(today), -n));
  const D = (...p) => Object.fromEntries(p);
  return [
    { id: crypto.randomUUID(), name: "Anki", color: "green", interval: 2,
      days: D([back(6), { state: "full" }], [back(4), { state: "full" }], [back(2), { state: "full" }]) },
    { id: crypto.randomUUID(), name: "英会話", color: "purple", interval: 1,
      days: D([back(3), { state: "full" }], [back(2), { state: "half", note: "発熱" }], [back(1), { state: "full" }], [today, { state: "full" }]) },
    { id: crypto.randomUUID(), name: "フランス語会話", color: "red", interval: 3,
      days: D([back(7), { state: "full" }], [back(4), { state: "full" }]) },
    { id: crypto.randomUUID(), name: "建築士過去問", color: "amber", interval: 2,
      days: D([back(5), { state: "full" }], [back(3), { state: "half", note: "半分だけ" }], [back(2), { state: "full" }]) },
    { id: crypto.randomUUID(), name: "地名暗記", color: "indigo", interval: 1,
      days: D(...Array.from({ length: 16 }, (_, n) => [back(15 - n), { state: "full" }])) },
  ];
}

/* ---------- editor / detail / sheet ---------- */
function Editor({ initial, onClose, onSave, title = "新しい習慣" }) {
  const presets = [1, 2, 3, 4, 7];
  const initialInterval = Math.max(1, Math.min(60, Math.trunc(Number(initial?.interval) || 1)));
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? "green");
  const [interval, setIv] = useState(initialInterval);
  const [custom, setCustom] = useState(!presets.includes(initialInterval));
  const clampCustom = (value) => Math.max(2, Math.min(60, Math.trunc(Number(value) || 2)));
  return (
    <Sheet onClose={onClose}>
      <div className="text-[11px] tracking-widest text-neutral-400 mb-4">{title}</div>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="習慣の名前"
        className="w-full text-lg border-b border-neutral-200 pb-2 outline-none focus:border-neutral-900" />
      <div className="mt-6 text-[11px] tracking-widest text-neutral-400 mb-2">ペース</div>
      <div className="flex flex-wrap gap-2">
        {presets.map((n) => (
          <button key={n} onClick={() => { setIv(n); setCustom(false); }}
            className={"px-3 py-1.5 rounded-full text-sm border " +
              (!custom && interval === n ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-600")}>
            {INTERVAL_LABEL(n)}
          </button>
        ))}
        <button onClick={() => { setCustom(true); setIv((n) => clampCustom(n)); }}
          className={"px-3 py-1.5 rounded-full text-sm border " +
            (custom ? "bg-neutral-900 text-white border-neutral-900" : "border-neutral-200 text-neutral-600")}>
          その他
        </button>
      </div>
      {custom && (
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => setIv((n) => Math.max(2, n - 1))} disabled={interval <= 2} aria-label="1日減らす"
            className="w-9 h-9 rounded-full border border-neutral-200 text-neutral-600 disabled:opacity-30">−</button>
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="number" min="2" max="60" step="1" value={interval}
              onChange={(e) => setIv(clampCustom(e.target.value))}
              className="w-16 rounded-lg border border-neutral-200 px-2 py-2 text-center tabular-nums outline-none focus:border-neutral-900" />
            日に1回
          </label>
          <button onClick={() => setIv((n) => Math.min(60, n + 1))} disabled={interval >= 60} aria-label="1日増やす"
            className="w-9 h-9 rounded-full border border-neutral-200 text-neutral-600 disabled:opacity-30">+</button>
        </div>
      )}
      <p className="mt-2 text-[11px] text-neutral-400 leading-relaxed">
        {interval === 1 ? "1日でも空くと連鎖が切れます。" : `前回から${interval}日以内にやれば連鎖は続きます。連日やってもかまいません。`}
      </p>
      <div className="mt-6 text-[11px] tracking-widest text-neutral-400 mb-2">色</div>
      <div className="flex flex-wrap gap-2">
        {COLOR_KEYS.map((c) => (
          <button key={c} onClick={() => setColor(c)} aria-label={c}
            className={"w-8 h-8 rounded-md " + (color === c ? "ring-2 ring-offset-2 ring-neutral-900" : "")}
            style={{ background: PALETTE[c][3] }} />
        ))}
      </div>
      <button disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), color, interval })}
        className="mt-8 w-full py-3 rounded-full bg-neutral-900 text-white text-sm disabled:opacity-30">保存</button>
    </Sheet>
  );
}

function Detail({ habit, pauses, today, onClose, onSave, onArchive, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!habit) return null;
  if (editing) return <Editor initial={habit} title="習慣を編集" onClose={onClose} onSave={onSave} />;
  const st = stats(withPauses(habit.days, pauses), habit.interval, today);
  const shades = PALETTE[habit.color] || PALETTE.green;
  const status = st.doneToday ? "今日は完了"
    : !st.alive ? "連鎖は途切れています"
    : st.daysLeft === 0 ? "今日が期限"
    : `今日は休んでOK（あと${st.daysLeft}日）`;
  const notes = Object.entries(habit.days).filter(([, v]) => v.note).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5);

  return (
    <Sheet onClose={onClose}>
      <div className="flex items-center gap-2">
        <span className="w-6 h-3 rounded-full" style={{ background: shades[3] }} />
        <h2 className="text-lg">{habit.name}</h2>
      </div>
      <div className="mt-1 text-xs text-neutral-400">{INTERVAL_LABEL(habit.interval)}・{status}</div>
      <div className="mt-6 grid grid-cols-3 gap-2 text-center">
        {[["現在の連続回数", st.current], ["最高連続回数", st.best], ["合計回数", st.total]].map(([l, v]) => (
          <div key={l} className="rounded-lg bg-neutral-50 py-4">
            <div className="text-2xl tabular-nums">{v}</div>
            <div className="text-[10px] text-neutral-400 mt-1 leading-tight">{l}</div>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <div className="mt-6">
          <div className="text-[11px] tracking-widest text-neutral-400 mb-2">MEMO</div>
          <ul className="space-y-1.5">
            {notes.map(([d, v]) => (
              <li key={d} className="flex gap-3 text-[13px]">
                <span className="text-neutral-400 tabular-nums shrink-0">{d.slice(5).replace("-", "/")}</span>
                <span className="text-neutral-700">{v.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 flex gap-3">
        <button onClick={() => setEditing(true)} className="flex-1 py-3 rounded-full border border-neutral-200 text-sm">編集</button>
        <button onClick={onArchive} className="flex-1 py-3 rounded-full border border-neutral-200 text-sm">休止する</button>
      </div>
      <p className="mt-2 text-[11px] text-neutral-400 leading-relaxed">
        休止すると一覧から外れますが、記録は残ります。⋯ から再開できます。
      </p>
      <div className="mt-5 text-center">
        {confirming ? (
          <span className="text-[13px]">
            <span className="text-neutral-500">記録も消えます。</span>
            <button onClick={onDelete} className="ml-2 text-red-600">本当に削除</button>
            <button onClick={() => setConfirming(false)} className="ml-4 text-neutral-400">やめる</button>
          </span>
        ) : (
          <button onClick={() => setConfirming(true)} className="text-[13px] text-neutral-400">削除</button>
        )}
      </div>
    </Sheet>
  );
}

function Sheet({ children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-t-2xl p-6 pb-10 max-h-[85vh] overflow-y-auto">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-neutral-200" />
        {children}
      </div>
    </div>
  );
}
