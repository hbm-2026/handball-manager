
/* =========================================================
   HM_ENGINE_CONTEXT (invisible wiring layer)
   Purpose:
   - Provide a stable place where Staff -> (future) Tactics/Training can plug in
   - NO UI changes, NO FM skin changes
   - Safe to call every render()
   ========================================================= */
(function(){
  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
  function toNum(x, d){ const n = Number(x); return Number.isFinite(n) ? n : d; }

  function avgObj(obj){
    if(!obj || typeof obj !== 'object') return 0;
    const vals = Object.values(obj).map(v=>Number(v)).filter(v=>Number.isFinite(v));
    if(!vals.length) return 0;
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  }
  function avgNested(attrs, key){
    try{ return avgObj((attrs||{})[key]||{}); }catch(e){ return 0; }
  }

  function getClubFromState(state){
    try{
      // club data might exist in multiple shapes across phases
      return state?.clubData || state?.career?.clubData || state?.currentClubData || null;
    }catch(e){ return null; }
  }

  function getStaffList(state){
    try{
      // Preferred: unified team API (works for CLUB + NT)
      if(window.HM_TEAM && typeof window.HM_TEAM.getStaff === 'function'){
        const staff = window.HM_TEAM.getStaff(state);
        if(Array.isArray(staff)) return staff;
      }
      // Legacy fallbacks
      const club = getClubFromState(state);
      if(club && Array.isArray(club.staff)) return club.staff;
      const c = state?.club || state?.career?.club || state?.currentClub;
      if(c && Array.isArray(c.staff)) return c.staff;
      return [];
    }catch(e){ return []; }
  }

  function roleKey(role){
    const r = (role||'').toLowerCase();
    if(r.includes('pomo')) return 'assistant';
    if(r.includes('kondic')) return 'fitness';
    if(r.includes('fizio')) return 'physio';
    if(r.includes('golman')) return 'gk';
    if(r.includes('analit')) return 'analyst';
    if(r.includes('skaut')) return 'scout';
    return 'other';
  }

  function computeStaffImpact(state){
    const staff = getStaffList(state);

    // Weighted pools by role (small, safe deltas)
    const pools = {
      tactical: [],
      training: [],
      mental: [],
      strategic: [],
      impact: []
    };

    staff.forEach(s=>{
      const attrs = (s && s.attributes) ? s.attributes : {};
      const r = roleKey(s?.role);

      const t = avgNested(attrs,'tactical');
      const tr= avgNested(attrs,'training');
      const m = avgNested(attrs,'mental');
      const st= avgNested(attrs,'strategic');
      const im= avgNested(attrs,'impact');

      // role weights (keep it simple and robust)
      const w = {
        assistant: 1.00,
        analyst: 0.75,
        fitness: 0.75,
        physio: 0.55,
        gk: 0.50,
        scout: 0.35,
        other: 0.40
      }[r] || 0.40;

      if(t)  pools.tactical.push(t*w);
      if(tr) pools.training.push(tr*w);
      if(m)  pools.mental.push(m*w);
      if(st) pools.strategic.push(st*w);
      if(im) pools.impact.push(im*w);
    });

    function safeAvg(arr){
      const nums = (arr||[]).map(Number).filter(v=>Number.isFinite(v));
      if(!nums.length) return 10;
      return nums.reduce((a,b)=>a+b,0)/nums.length;
    }

    const tactical = safeAvg(pools.tactical);
    const training = safeAvg(pools.training);
    const mental   = safeAvg(pools.mental);
    const strategic= safeAvg(pools.strategic);
    const impact   = safeAvg(pools.impact);

    // Convert 1–20-ish into *small* multipliers around 1.00
    // 10 -> 1.00, 20 -> ~1.08, 1 -> ~0.93 (very mild)
    function multFromRating(r){
      const rr = clamp(toNum(r,10), 1, 20);
      const delta = (rr - 10) / 125; // max ~ +0.08
      return clamp(1 + delta, 0.90, 1.10);
    }

    return {
      ratings: { tactical, training, mental, strategic, impact },
      multipliers: {
        tactic:   multFromRating(tactical),
        training: multFromRating(training),
        mental:   multFromRating(mental),
        strategy: multFromRating(strategic),
        match:    multFromRating(impact)
      }
    };
  }

  function ensureTeamContext(state){
    if(!state) return null;
    if(!state.teamContext){
      state.teamContext = {
        // staff side (computed)
        staffImpact: null,

        // tactic hook (placeholder; we will attach real tactic model later)
        tacticStub: {
          system: '6-0',
          tempo: 'normal',
          attack: 'balans',
          defense: 'balans',
          risk: 'normal'
        },

        // the one place we read later in match engine / training
        combined: {
          // multipliers that other subsystems can read safely
          mult: { tactic:1, training:1, mental:1, strategy:1, match:1 }
        },

        // meta
        hooks: {
          // future: HM_TACTICS will write here
          readyForTactics: true,
          schemaVersion: 1
        }
      };
    }
    return state.teamContext;
  }

  function recompute(state){
    const ctx = ensureTeamContext(state);
    if(!ctx) return null;

    const staff = computeStaffImpact(state);
    ctx.staffImpact = staff;

    // Today: combined == staff only (tactics can later multiply/adjust here)
    const sm = staff?.multipliers || { tactic:1, training:1, mental:1, strategy:1, match:1 };

    // Placeholder: tacticStub does nothing yet, but we keep a hook point.
    // Later we will compute tactic multipliers and multiply them here.
    ctx.combined.mult = {
      tactic:   sm.tactic,
      training: sm.training,
      mental:   sm.mental,
      strategy: sm.strategy,
      match:    sm.match
    };

    return ctx;
  }

  function setTacticStub(state, patch){
    const ctx = ensureTeamContext(state);
    if(!ctx) return null;
    if(patch && typeof patch === 'object'){
      ctx.tacticStub = { ...ctx.tacticStub, ...patch };
    }
    return ctx.tacticStub;
  }

  function get(state){
    return ensureTeamContext(state);
  }

  window.HM_ENGINE = {
    ensureTeamContext,
    recompute,
    setTacticStub,
    get
  };

  // =========================================================
  // Centralized tactic mods (single source of truth)
  // Engine should consume ONLY these numeric mods.
  // =========================================================
  function getTacticMods(gameState){
    const gs = gameState || window.gameState || {};
    const t = (gs.tactics && typeof gs.tactics==='object') ? gs.tactics : {};
    const o = (t.offense && typeof t.offense==='object') ? t.offense : {};
    const d = (t.defense && typeof t.defense==='object') ? t.defense : {};
    const tr = (t.transition && typeof t.transition==='object') ? t.transition : {};

    const tempo = clamp(Number(o.tempo ?? 5), 1, 10);
    const passRisk = clamp(Number(o.passRisk ?? 5), 1, 10);
    const focus = String(o.focus || "balanced");
    const width = clamp(Number(o.width ?? 5), 1, 10);

    // pace: baseline 1.0, tempo 5 = neutral
    const paceMultiplier = clamp(1 + (tempo-5)*0.06, 0.75, 1.35);

    // turnovers: delta added to turnover probability (small)
    const turnoverDelta = clamp((passRisk-5)*0.010, -0.06, 0.10);

    // shot weights: baseline distribution; focus + width tweak
    let wPivot = 0.22, wWings = 0.18, wBackcourt = 0.45, wBreak = 0.15;

    if(focus==="pivot"){ wPivot += 0.16; wBackcourt -= 0.08; wWings -= 0.05; }
    else if(focus==="wings"){ wWings += 0.16; wBackcourt -= 0.08; wPivot -= 0.05; }
    else if(focus==="backcourt"){ wBackcourt += 0.14; wPivot -= 0.06; wWings -= 0.04; }

    const widN = (width-5)/5; // -0.8..+1
    wWings += 0.05*widN;
    wBreak += 0.03*widN;

    // Transition pressAfterGoal: belongs to transition, but UI also has offense pressAfterGoal
    const pressAfterGoal = !!(tr.pressAfterGoal ?? o.pressAfterGoal);

    if(pressAfterGoal){ wBreak += 0.03; }

    // Normalize
    wPivot = Math.max(0.05, wPivot);
    wWings = Math.max(0.05, wWings);
    wBackcourt = Math.max(0.05, wBackcourt);
    wBreak = Math.max(0.05, wBreak);
    const s = wPivot+wWings+wBackcourt+wBreak;

    return {
      paceMultiplier,
      turnoverDelta,
      shotWeights:{
        pivot: wPivot/s,
        wings: wWings/s,
        backcourt: wBackcourt/s,
        breakthrough: wBreak/s
      },
      // keep for future extension
      defense:{
        system: String(d.system || "6-0"),
        height: String(d.height || "low"),
        aggression: clamp(Number(d.aggression ?? 5), 1, 10)
      },
      transition:{
        fastBreak: clamp(Number(tr.fastBreak ?? 5), 1, 10),
        pressAfterGoal,
        retreatSpeed: clamp(Number(tr.retreatSpeed ?? 5), 1, 10)
      }
    };
  }

  window.getTacticMods = getTacticMods;
})();
// NOTE: renderFitnessBar/renderOVRBar are defined INSIDE the FM skin IIFE
// so they can safely use helpers like escapeAttr/fitnessTier.

// === HM Staff helpers (skill & reporting accuracy) ===
function hmNum(v, d=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function hmClamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function hmGetStaffByRole(club, roleName){
  try{
    const staff = (club && (club.staff || club.coaches)) || [];
    const rn = String(roleName||"").toLowerCase();
    return staff.find(s=> String(s.role||s.title||"").toLowerCase() === rn) || null;
  }catch(e){ return null; }
}

// Return 1–20
function hmGetStaffSkill(club, roleName){
  const s = hmGetStaffByRole(club, roleName);
  const A = (s && s.attributes) || {};
  // attributes can be nested or flat
  const tactical = hmNum(A.tactical ?? A.taktika ?? A.tacticalRating, 10);
  const training = hmNum(A.training ?? A.trening ?? A.trainingRating, 10);
  const mental   = hmNum(A.mental ?? A.ment ?? A.mentalRating, 10);
  const strategic= hmNum(A.strategic ?? A.strat ?? A.strategicRating, 10);
  const impact   = hmNum(A.impact ?? A.uticaj ?? A.impactRating, 10);

  // role weighting
  let raw = (tactical + training + mental + strategic + impact) / 5;
  const rn = String(roleName||"").toLowerCase();
  if(rn === "pomoćni trener") raw = (training*0.45 + tactical*0.30 + mental*0.25);
  if(rn === "analitičar")     raw = (tactical*0.55 + strategic*0.45);
  if(rn === "skaut")          raw = (strategic*0.55 + tactical*0.30 + impact*0.15);
  return hmClamp(Math.round(raw), 1, 20);
}

// === Staff suggestions generator (public API) ===
// This is a logic-only hook. Other parts of the game (match engine later) can call this
// by setting `state.career.lastMatchToken` (or passing a token) and re-rendering.
if(typeof window !== "undefined" && !window.generateStaffSuggestions){
  window.generateStaffSuggestions = function(state, opts){
    try{
      if(!state) return;
      state.career = state.career || {};
      // mark season start generation
      if(opts && opts.seasonStart){
        state.career.season = Number(state.career.season||1);
        state.career._seasonStartToken = String(Date.now());
      }
      if(opts && opts.matchEnd){
        // unique token so FM skin can detect and generate matchSuggestions once
        state.career.lastMatchToken = String(opts.matchToken || Date.now());
        state.career.lastMatch = { token: state.career.lastMatchToken, meta: opts.meta||{} };
      }
      // No direct rendering here; caller decides. FM skin will generate on next render.
    }catch(e){
      console.error("generateStaffSuggestions error", e);
    }
  };
}

// Map staff skill 1–20 to decision accuracy 0.65–0.98
function hmSkillToAccuracy(skill){
  const s = hmClamp(hmNum(skill,10), 1, 20);
  return hmClamp(0.65 + (s/20)*0.33, 0.65, 0.98);
}
function hmSkillToNoiseScale(skill){
  const s = hmClamp(hmNum(skill,10), 1, 20);
  return hmClamp(1 - (s/20), 0, 0.95);
}

// Handball Manager — FM 2007 layout (FAZA 2) — SKIN from provided FM zip
// RULES:
// - NO hardcoded club data
// - NO localStorage guessing
// - Reads ONLY from shared DB (window.HM_DB) using state.career.clubKey
// - Must work for ANY club selected in FAZA 1
// Exposes: window.renderFMSkin(state, mountEl)

(function(){
  function escapeHtml(str){


    return String(str ?? "").replace(/[&<>"']/g, s => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[s]));
  }


  function escapeAttr(str){
    // Safe escaping for HTML attribute values
    return escapeHtml(str);
  }
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
  function seedFrom(str){
    const s = String(str||"");
    let h = 2166136261;
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h>>>0);
  }
  function moraleToArrow(morale){
    const m = Number(morale)||0;
    if(m <= 5) return {arrow:"↓", cls:"morale-bad"};
    if(m <= 10) return {arrow:"↘", cls:"morale-low"};
    if(m <= 15) return {arrow:"→", cls:"morale-neutral"};
    if(m <= 20) return {arrow:"↗", cls:"morale-good"};
    return {arrow:"↑", cls:"morale-excellent"};
  }


  // Tooltip for morale arrow (psychological status)
  function psychTooltip(p, club, assignedSlot){
    const mVal = hmClamp(Number(ensureMorale(p, club) || 0), 0, 25);

    let icon="😐", label="SREDNJI MORAL";
    if(mVal <= 5){ icon="😡"; label="LOŠ MORAL"; }
    else if(mVal <= 10){ icon="😕"; label="NIZAK MORAL"; }
    else if(mVal <= 15){ icon="😐"; label="SREDNJI MORAL"; }
    else if(mVal <= 20){ icon="🙂"; label="DOBAR MORAL"; }
    else { icon="😎"; label="ODLIČAN MORAL"; }

    // Tooltip should be short: stanje + smajli
    return `${label} ${icon}`;
  }

  function ensureFitness(p){
    if(p.fitness!=null) return p.fitness;
    const v = 70 + (seedFrom(p.name)%31);
    return clamp(Math.round(v), 55, 100);
  }
  
  // Tooltip for fitness/condition (Kondicija) — redesigned for clarity
  function fitnessTier(val){
    if(val >= 90) return {label:"ODLIČNA", cls:"fitness-excellent", impact:"Bez penalizacije"};
    if(val >= 75) return {label:"DOBRA", cls:"fitness-good", impact:"Blagi pad učinka (≈ -2%)"};
    if(val >= 60) return {label:"UMOR", cls:"fitness-tired", impact:"Primetan pad učinka (≈ -5%)"};
    return {label:"ISCRPLJEN", cls:"fitness-bad", impact:"Veliki pad učinka (≈ -10%) + veći rizik povrede"};
  }

  function fitnessTooltip(val){
    const v = hmClamp(Number(val||0), 0, 100);
    const t = fitnessTier(v);

    // 12-block meter for quick glance
    const blocks = 12;
    const filled = Math.round((v/100)*blocks);
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, blocks-filled));

    const lines = [
      `KONDICIJA — ${v}%`,
      `${bar}  ${t.label}`,
      "",
      `Uticaj na igru: ${t.impact}`,
      "Šta znači: trenutna fizička spremnost igrača.",
      "Napomena: niska kondicija smanjuje sprint/duel/šut i povećava umor."
    ];

    return lines.join("\n");
  }

  // Bars used in squad table (defined inside IIFE so helpers are in scope)
  function renderFitnessBar(p){
    const val = Math.max(0, Math.min(100, (p.fitness ?? p.condition ?? p.kondicija ?? p.cond ?? 50)));
    const tier = fitnessTier(val);
    return `<div class="fm-barRow hmTip ${tier.cls}" data-tip="${escapeAttr(fitnessTooltip(val))}">
              <div class="fm-progress-dark"><span style="width:${val}%"></span></div>
              <div class="fm-barNum">${val}%</div>
            </div>`;
  }
  function renderOVRBar(p){
    const ovr = Math.max(1, Math.min(20, Math.round(p.ovr ?? p.overall ?? p.rating ?? p.avgRating ?? 10)));
    const percent = Math.round((ovr/20)*100);
    return `<div class="fm-barRow" title="OVR ${ovr}">
              <div class="fm-progress-ovr"><span style="width:${percent}%"></span></div>
              <div class="fm-barNum">${ovr}</div>
            </div>`;
  }

  function ensureMorale(p, club){
    if(p.morale!=null) return p.morale;
    if(p.moral!=null) return p.moral;
    // derive from club progress bars if present (0-100)
    const gRaw = (club && club.goalProgress!=null) ? club.goalProgress : (club && club.goalsProgress!=null ? club.goalsProgress : 50);
    const prRaw = (club && club.pressureProgress!=null) ? club.pressureProgress : (club && club.pressure!=null ? club.pressure : 50);
    const gVal = (typeof gRaw==='object' && gRaw && 'v' in gRaw) ? gRaw.v : gRaw;
    const prVal = (typeof prRaw==='object' && prRaw && 'v' in prRaw) ? prRaw.v : prRaw;
    const g = Number.isFinite(Number(gVal)) ? Number(gVal) : 50;
    const pr = Number.isFinite(Number(prVal)) ? Number(prVal) : 50;
    const base = 12 + (g-50)/8 - (pr-50)/10; // around 6-18 typically
    const jitter = ((seedFrom(p.name)%7)-3)*0.6; // small variance
    return clamp(Math.round(base + jitter), 0, 25);
  }


  // Ensure age exists (years). If missing, generate a realistic age by position, deterministic per player.
  function ensureAge(p, club){
    const raw = p?.age ?? p?.years ?? p?.god ?? p?.godine;
    const n = Number(raw);
    if(Number.isFinite(n) && n>14 && n<60) return Math.round(n);

    const pos = String(p?.pos ?? p?.position ?? p?.poz ?? "").toUpperCase();
    let minA=22, maxA=31;
    if(pos==="GK") { minA=26; maxA=34; }
    else if(pos==="LW" || pos==="RW") { minA=20; maxA=29; }
    else if(pos==="PIV") { minA=23; maxA=32; }

    const key = `${p?.id ?? p?.pid ?? p?.name ?? p?.ime ?? "player"}|${pos}|${club?.name ?? club?.clubName ?? ""}`;
    const r = seedFrom(key); // 0..1
    return Math.round(minA + r * (maxA - minA));
  }

  // Compute per-player KOMPAKTNOST (1–20). Tactical fit + discipline/positioning + team-defense awareness.
// Deterministic-ish, derived from existing attribute cards (no new DB fields needed).
function computeCompactness(p, club){
    try{
      // Make sure attributes exist (from FAZA 1 DB seed)
      const at = p?.attributes;
      const me = at?.mental || {};
      const df = at?.defense || {};
      const pos = hmNum(me.pozicioniranje, null);
      const dis = hmNum(me.disciplina, null);
      const kon = hmNum(me.koncentracija, null);
      const td  = hmNum(df.timskaOdbrana, null);
      const an  = hmNum(df.anticipacija, null);

      // Fallbacks when missing (should be rare)
      const fPos = (pos!=null)?pos: hmClamp(hmNum(p?.ovr ?? p?.overall ?? 12, 12), 6, 20);
      const fDis = (dis!=null)?dis: hmClamp(10 + ((seedFrom(String(p?.name||""))%7)-3), 1, 20);
      const fKon = (kon!=null)?kon: hmClamp(10 + ((seedFrom("k|"+String(p?.name||""))%7)-3), 1, 20);
      const fTd  = (td!=null)?td: hmClamp(10 + ((seedFrom("t|"+String(p?.name||""))%7)-3), 1, 20);
      const fAn  = (an!=null)?an: hmClamp(10 + ((seedFrom("a|"+String(p?.name||""))%7)-3), 1, 20);

      // Small morale influence (keeps it connected to team dynamics)
      const morale = hmClamp(hmNum(ensureMorale(p, club), 13), 0, 25);
      const moraleN = (morale - 13) / 12; // -1..+1

      // Weighted average -> 1..20
      let c = (fPos*0.26) + (fDis*0.22) + (fTd*0.22) + (fAn*0.18) + (fKon*0.12);
      c = c + (moraleN * 0.9); // +/- ~0.9
      c = hmClamp(c, 1, 20);
      return Math.round(c);
    }catch(e){
      return 10;
    }
}

function compactnessToMeter(c){
  const v = hmClamp(Number(c)||0, 0, 20);
  const pct = Math.round((v/20)*100);
  const blocks = 10;
  const filled = Math.round((v/20)*blocks);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, blocks-filled));
  return { pct, bar };
}

function compactTooltip(p, club){
  const c = computeCompactness(p, club);
  const m = compactnessToMeter(c);
  const head = `🧩 KOMPAKTNOST — ${c}/20`;
  const meter = `${m.bar}  ${m.pct}%`;

  const bullets = [
    "• Stabilnost pozicioniranja i discipline",
    "• Bolja timska odbrana i saradnja u sistemu",
    "• Direktan bonus na TEAM_POWER (kada je tim uigran)"
  ].join("\n");

  // Bez "napomene" — korisnik želi čist tooltip.
  return head + "\n" + meter + "\n\n" + bullets;
}

// Detaljni prikaz (3 stavke) za hover nad mini progress linijom.
function compactBreakdown(p, club){
  const at = p?.attributes;
  const me = at?.mental || {};
  const df = at?.defense || {};

  const pos = hmNum(me.pozicioniranje, null);
  const dis = hmNum(me.disciplina, null);
  const kon = hmNum(me.koncentracija, null);
  const td  = hmNum(df.timskaOdbrana, null);
  const an  = hmNum(df.anticipacija, null);

  // Fallbacks kao i u computeCompactness
  const fPos = (pos!=null)?pos: hmClamp(hmNum(p?.ovr ?? p?.overall ?? 12, 12), 6, 20);
  const fDis = (dis!=null)?dis: hmClamp(10 + ((seedFrom(String(p?.name||""))%7)-3), 1, 20);
  const fKon = (kon!=null)?kon: hmClamp(10 + ((seedFrom("k|"+String(p?.name||""))%7)-3), 1, 20);
  const fTd  = (td!=null)?td: hmClamp(10 + ((seedFrom("t|"+String(p?.name||""))%7)-3), 1, 20);
  const fAn  = (an!=null)?an: hmClamp(10 + ((seedFrom("a|"+String(p?.name||""))%7)-3), 1, 20);

  // Grupisano u 3 jasne stavke:
  // 1) Pozicioniranje
  // 2) Disciplina
  // 3) Tim. svest (timska odbrana + anticipacija + koncentracija)
  const teamAware = Math.round((fTd + fAn + fKon) / 3);

  return {
    pos: hmClamp(fPos, 1, 20),
    dis: hmClamp(fDis, 1, 20),
    team: hmClamp(teamAware, 1, 20)
  };
}

function compactBreakdownTooltip(p, club){
  const b = compactBreakdown(p, club);
  const mPos = compactnessToMeter(b.pos);
  const mDis = compactnessToMeter(b.dis);
  const mTeam = compactnessToMeter(b.team);

  // Jednostavno, "na prvu" čitljivo.
  return [
    `🧩 KOMPAKTNOST — osnove`,
    `Pozicioniranje: ${mPos.bar}  ${b.pos}/20`,
    `Disciplina:     ${mDis.bar}  ${b.dis}/20`,
    `Tim. svest:     ${mTeam.bar}  ${b.team}/20`
  ].join("\n");
}


  function ensureSkinCSS(){
    if(document.getElementById("hm-fm-skin-css")) return;
    const st = document.createElement("style");
    st.id = "hm-fm-skin-css";
    st.textContent = `/* Handball Manager — FM 2007 layout, modern neon skin */

:root{
  --bg0:#040617;
  --bg1:#061b3f;
  --panelA: rgba(18,26,44,.86);
  --panelB: rgba(10,14,26,.78);
  --text:#eef4ff;
  --muted:#aab7d1;
  --b1: rgba(255,255,255,.10);
  --b2: rgba(107,209,255,.26);
  --accent:#6bd1ff;
  --accent2:#6cffc1;
  --warn:#ffcf5a;
  --shadow: 0 22px 60px rgba(0,0,0,.55);
  --radius: 22px;
  --radius2: 18px;
}

*{box-sizing:border-box}
html,body{height:100%}

body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
  color:var(--text);
  background:
    radial-gradient(980px 560px at 12% 0%, rgba(107,209,255,.18), transparent 62%),
    radial-gradient(980px 560px at 88% 0%, rgba(108,255,193,.12), transparent 62%),
    radial-gradient(900px 520px at 50% 110%, rgba(255,207,90,.06), transparent 62%),
    linear-gradient(180deg, var(--bg0), var(--bg1));
}

/* TOPBAR */
.topbar{
  height:74px;
  display:grid;
  grid-template-columns: 1fr 2fr 1fr;
  align-items:center;
  padding:0 16px;
  border-bottom:1px solid var(--b1);
  background: rgba(4,6,23,.78);
  backdrop-filter: blur(18px);
}
.top-left{display:flex;align-items:center}
.logo{
  width:46px;height:46px;border-radius:16px;
  display:grid;place-items:center;
  background: linear-gradient(135deg,var(--accent),var(--accent2));
  box-shadow: var(--shadow);
}
.top-center{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0}
.clubName{
  text-align:center;
  font-size:28px;
  font-weight:1000;
  letter-spacing:.35px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.clubSub{
  font-size:12px;
  color: rgba(238,244,255,.70);
  letter-spacing:.2px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.teamStatus{
  margin-top:6px;
  font-size:14px;
  font-weight:800;
  letter-spacing:.15px;
  opacity:.92;
  /* Align with content column ("Igrači") */
  position:absolute;
  left:calc(280px + 16px);
  bottom:10px;
  text-align:left;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  max-width:calc(100% - 280px - 16px - 160px);
}

@media (max-width: 920px){
  .teamStatus{
    position:static;
    left:auto; bottom:auto;
    text-align:center;
    max-width:none;
  }
}
.teamStatus.good{ color: rgba(140, 255, 180, .92); }
.teamStatus.warn{ color: rgba(255, 220, 120, .92); }
.teamStatus.bad{  color: rgba(255, 135, 135, .92); }
.top-right{
  display:flex;
  gap:10px;
  justify-content:flex-end;
  align-items:center;
}
.topSelect{
  height:34px;
  width:120px;
  min-width:120px;
  padding:4px 10px;
  border-radius:14px;
  text-align:center;
  background: rgba(255,255,255,.06);
  border:1px solid var(--b1);
  color:var(--text);
  outline:none;
}
.topSelect:focus{
  border-color: rgba(107,209,255,.55);
  box-shadow: 0 0 0 3px rgba(107,209,255,.14);
}

/* LAYOUT */
.layout{
  height:calc(100% - 74px);
  display:grid;
  grid-template-columns: 280px 1fr;
  min-height:0;
}

/* SIDEBAR */
.sidebar{
  background: linear-gradient(180deg, var(--panelA), var(--panelB));
  border-right:1px solid var(--b1);
  box-shadow: inset -1px 0 0 rgba(255,255,255,.06);
  display:flex;
  flex-direction:column;
  min-height:0;
}
.sideHeader{
  padding:14px 14px 10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08);
  background:
    radial-gradient(520px 180px at 10% 0%, rgba(107,209,255,.16), transparent 62%),
    rgba(0,0,0,.06);
}
.sideTitle{font-weight:1000; letter-spacing:.2px}
.sideHint{font-size:12px;color:rgba(238,244,255,.65); margin-top:4px}

#nav{
  padding:10px 10px 12px 10px;
  overflow:auto;
  min-height:0;
}

.tree{
  display:flex;
  flex-direction:column;
  gap:8px;
}

/* Group container */
.group{
  border-radius: var(--radius2);
  border:1px solid rgba(255,255,255,.08);
  background: rgba(0,0,0,.10);
  overflow:hidden;
}
.groupHead{
  display:flex;
  align-items:center;
  gap:10px;
  padding:12px 12px;
  cursor:pointer;
  user-select:none;
  transition: background .12s ease, border-color .12s ease;
}
.groupHead:hover{ background: rgba(107,209,255,.07); }
.groupIcon{
  width:26px;height:26px;border-radius:10px;
  display:grid;place-items:center;
  background: rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.10);
}
.groupTitle{font-weight:950}
.groupCaret{
  margin-left:auto;
  width:26px;height:26px;border-radius:10px;
  display:grid;place-items:center;
  background: rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.10);
  color: rgba(238,244,255,.92);
  font-weight:1000;
}
.groupBody{
  display:none;
  padding:6px 8px 10px 8px;
  border-top:1px solid rgba(255,255,255,.08);
  background: rgba(0,0,0,.08);
}
.group.open .groupBody{ display:block; }

/* Single item */
.item{
  border-radius: var(--radius2);
  border:1px solid rgba(255,255,255,.08);
  background: rgba(0,0,0,.10);
  overflow:hidden;
}
.itemBtn{
  width:100%;
  display:flex;
  align-items:center;
  gap:10px;
  padding:12px 12px;
  cursor:pointer;
  user-select:none;
  background: transparent;
  border: none;
  color: var(--text);
  font: inherit;
  text-align:left;
}
.itemBtn:hover{ background: rgba(107,209,255,.07); }
.itemBtn.active{
  background: rgba(107,209,255,.16);
  outline: 1px solid rgba(107,209,255,.25);
}
.subBtn{
  display:flex;
  align-items:center;
  gap:10px;
  padding:10px 10px;
  border-radius: 14px;
  border:1px solid transparent;
  color: rgba(238,244,255,.78);
  cursor:pointer;
  user-select:none;
}
.subBtn:hover{
  background: rgba(255,255,255,.05);
  border-color: rgba(255,255,255,.08);
  color: var(--text);
}
.subBtn.active{
  background: rgba(108,255,193,.12);
  border-color: rgba(108,255,193,.22);
  color: var(--text);
}
.subDot{
  width:8px;height:8px;border-radius:999px;
  background: rgba(107,209,255,.65);
  box-shadow: 0 0 0 4px rgba(107,209,255,.10);
}

.sideFooter{
  margin-top:auto;
  padding:12px 14px;
  border-top:1px solid rgba(255,255,255,.08);
  background: rgba(0,0,0,.06);
}
.softBtn{
  width:100%;
  height:38px;
  border-radius:16px;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.06);
  color: var(--text);
  font-weight:950;
  cursor:pointer;
}
.softBtn:hover{
  border-color: rgba(107,209,255,.45);
  box-shadow: 0 12px 30px rgba(0,0,0,.28);
}

/* CONTENT */
.content{
  min-width:0;
  min-height:0;
  padding:16px;
  display:flex;
  flex-direction:column;
  gap:12px;
}
.contentHeader{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
}
.contentTitle{
  font-size:20px;
  font-weight:1000;
  letter-spacing:.15px;
}
.contentMeta{display:flex;gap:8px;flex-wrap:wrap}
.pill{
  display:inline-flex;
  align-items:center;
  padding:6px 10px;
  border-radius:999px;
  font-size:12px;
  border:1px solid rgba(255,255,255,.12);
  background: rgba(0,0,0,.18);
  color: rgba(238,244,255,.90);
}

.panel{
  flex:1;
  min-height:0;
  border-radius: var(--radius);
  border:1px solid rgba(255,255,255,.10);
  background: linear-gradient(180deg, rgba(18,26,44,.90), rgba(10,14,26,.82));
  box-shadow: var(--shadow);
  overflow:auto;
  padding:12px;
}

/* TABLE */
.tableWrap{padding:6px}
.tableTitleRow{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 10px;
  border-bottom:1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.03);
  border-radius: 16px;
}
.tableTitleRow .sub{
  color: rgba(238,244,255,.70);
  font-size:12px;
  margin-top:2px;
}

/* TACTICS SUBTABS */
.subTabs{
  display:flex;
  gap:8px;
  margin:10px 0 12px 0;
}
.subTabBtn{
  appearance:none;
  border:1px solid rgba(255,255,255,.10);
  background: rgba(0,0,0,.18);
  color: rgba(238,244,255,.88);
  padding:8px 12px;
  border-radius: 12px;
  font-weight: 900;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease, transform .05s ease;
}
.subTabBtn:hover{ background: rgba(107,209,255,.08); border-color: rgba(107,209,255,.25); }
.subTabBtn:active{ transform: translateY(1px); }
.subTabBtn.active{
  background: rgba(107,209,255,.14);
  border-color: rgba(107,209,255,.35);
  color: rgba(255,255,255,.95);
}
.tagMini{
  display:inline-flex;
  align-items:center;
  padding:4px 10px;
  border-radius:999px;
  font-size:12px;
  border:1px solid rgba(255,255,255,.12);
  background: rgba(255,255,255,.04);
  color: rgba(238,244,255,.85);
}

table{
  width:100%;
  border-collapse:collapse;
  font-size:14px;
  margin-top:10px;
}
th,td{
  padding:10px 8px;
  border-bottom:1px solid rgba(255,255,255,.07);
}
th{
  color: rgba(238,244,255,.62);
  font-weight:900;
  text-align:left;
}
tbody tr{
  background: rgba(0,0,0,.10);
}
tbody tr:nth-child(2n){
  background: rgba(0,0,0,.18);
}
tbody tr:hover{
  background: rgba(107,209,255,.08);
}

@media (max-width: 920px){
  .layout{grid-template-columns: 1fr}
  .sidebar{height: 260px}
}

/* ===== CAREER FM SKIN (FINAL, CONTINUATION) ===== */
.fm-career{height:100%;display:grid;grid-template-rows:72px 1fr;color:#eef4ff}
.fm-top{display:grid;grid-template-columns:1fr 2fr 1fr;align-items:center;
padding:0 16px;border-bottom:1px solid rgba(255,255,255,.1);
background:rgba(4,6,23,.75);backdrop-filter:blur(16px)}
.fm-logo{width:44px;height:44px;border-radius:16px;display:grid;place-items:center;
background:linear-gradient(135deg,#6bd1ff,#6cffc1)}
.fm-club{font-size:28px;font-weight:1000;text-align:center}
.fm-wrap{display:grid;grid-template-columns:280px 1fr;min-height:0}
.fm-side{background:linear-gradient(180deg,rgba(18,26,44,.86),rgba(10,14,26,.78));
border-right:1px solid rgba(255,255,255,.1);padding:12px;overflow:auto}
.fm-group{border:1px solid rgba(255,255,255,.1);border-radius:18px;margin-bottom:8px}
.fm-head{padding:12px;cursor:pointer;font-weight:900}
.fm-body{display:none;padding:8px}
.fm-group.open .fm-body{display:block}
.fm-item{padding:10px;border-radius:14px;cursor:pointer;color:#aab7d1}
.fm-item:hover{background:rgba(255,255,255,.06);color:#eef4ff}
.fm-main{padding:16px;color:#eef4ff}
.fm-panel{border:1px solid rgba(255,255,255,.1);border-radius:22px;
background:linear-gradient(180deg,rgba(18,26,44,.9),rgba(10,14,26,.82));
padding:12px;overflow:auto}

/* ===== STAFF HUB (Stručni štab) ===== */
.staffHub{display:grid;grid-template-columns:420px 1fr;gap:14px;min-height:520px}
.staffHubTitle{margin-bottom:10px}
.staffHubTitle .big{font-size:18px;font-weight:900}
.staffHubTitle .sub{opacity:.8;font-size:12px;margin-top:2px}
.staffCards{display:grid;gap:10px}
.staffCard{border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:10px;cursor:pointer;
background:rgba(0,0,0,.18);transition:transform .12s ease, background .12s ease, border-color .12s ease}
.staffCard:hover{transform:translateY(-1px);background:rgba(107,209,255,.06);border-color:rgba(107,209,255,.25)}
.staffCard.active{border-color:rgba(107,209,255,.55);background:rgba(107,209,255,.08)}
.staffCardTop{display:flex;justify-content:space-between;gap:10px}
.staffCardName .nm{font-weight:900;font-size:14px}
.staffCardName .rl{opacity:.85;font-size:12px;margin-top:2px}
.staffCardName .flag{margin-left:6px;opacity:.9}
.staffMini{opacity:.75;font-size:11px;text-align:right;min-width:110px}
.staffTraits{display:grid;gap:6px;margin-top:8px}
.trait{display:flex;gap:8px;align-items:center;font-size:12px}
.trait.weak{opacity:.85}
.staffCardBtns{display:flex;gap:8px;margin-top:10px}

.staffMorale{margin-top:6px;font-weight:900;font-size:12px;opacity:.95}
.sugList{display:grid;gap:10px;margin-top:10px}
.sugItem{border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px;background:rgba(0,0,0,.14)}
.sugTitle{font-weight:950}
.sugWhy{opacity:.85;font-size:13px;margin-top:6px;line-height:1.35}
.sugBtns{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}
.btnSm{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#eef4ff;
padding:6px 10px;border-radius:12px;font-weight:800;cursor:pointer}
.btnSm:hover{background:rgba(255,255,255,.1)}
.btnSm.ghost{background:transparent}

.decisionPanel,.impactPanel{border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(0,0,0,.18);padding:12px}
.decisionPanel{margin-bottom:12px}
.panelTitle{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:900;margin-bottom:10px}
.panelTitle .dot{width:10px;height:10px;border-radius:999px;background:#6bd1ff;box-shadow:0 0 14px rgba(107,209,255,.35)}
.quote{font-size:14px;font-weight:900;margin-bottom:10px}
.effects{display:grid;gap:6px;margin-bottom:10px}
.effRow{display:flex;justify-content:space-between;opacity:.9;font-size:12px}
.effRow.pos b{color:#6cffc1}
.effRow.neg b{color:#ff7b7b}
.panelBtns{display:flex;gap:10px;margin-top:8px}
.btnPrimary,.btnSecondary{border-radius:14px;padding:8px 12px;font-weight:900;cursor:pointer;border:1px solid rgba(255,255,255,.16)}
.btnPrimary{background:rgba(108,255,193,.16)}
.btnPrimary:hover{background:rgba(108,255,193,.24)}
.btnSecondary{background:rgba(108,255,193,.16);color:#ffffff !important}
.btnSecondary:hover{background:rgba(108,255,193,.24);color:#ffffff !important}
.sugBtns .btnPrimary,.sugBtns .btnSecondary{min-width:96px}
.warn{margin-top:10px;opacity:.9;color:#ffcf6b;font-weight:900}
.impactGrid{display:grid;gap:8px}
.impRow{display:flex;justify-content:space-between;font-size:12px;opacity:.92}
.impRow.pos b{color:#6cffc1}
.impRow.neg b{color:#ff7b7b}
.miniNote{opacity:.75;font-size:11px;margin-top:10px;line-height:1.35}

@media (max-width: 980px){
  .staffHub{grid-template-columns:1fr;}
}
.fm-table{width:100%;border-collapse:collapse}
.fm-table th,.fm-table td{padding:10px;border-bottom:1px solid rgba(255,255,255,.08)}
.fm-row{cursor:pointer}
.fm-row:hover{background:rgba(107,209,255,.08)}

/* ===== TALK PANEL (Razgovaraj) ===== */
.hmTalkPanel{position:fixed;top:0;right:-420px;width:420px;max-width:92vw;height:100vh;z-index:9999;
  background:rgba(8,14,24,.96);backdrop-filter:blur(10px);
  border-left:1px solid rgba(107,209,255,.18);
  box-shadow:-14px 0 40px rgba(0,0,0,.55);
  transition:right .22s ease;display:flex;flex-direction:column}
.hmTalkPanel.open{right:0}
.hmTalkHdr{padding:14px 14px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
.hmTalkHdr .ttl{font-size:14px;font-weight:900;letter-spacing:.3px}
.hmTalkHdr .sub{margin-top:4px;font-size:12px;opacity:.8}
.hmTalkBody{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:auto}
.hmTalkLbl{font-size:12px;opacity:.85}
.hmTalkSelect{width:100%;padding:10px 10px;border-radius:12px;
  border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);color:#eaf6ff}
.hmTalkAnswer{padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.08);
  background:rgba(255,255,255,.03);line-height:1.35;font-size:13px;color:#eaf6ff}
.hmTalkAnswer.typing{position:relative;color:#cfe9ff}
.hmTalkAnswer.typing::after{content:"";display:inline-block;width:18px;height:10px;margin-left:6px;
  background:currentColor;opacity:.45;border-radius:6px;animation:hmDots 1.0s infinite steps(3,end)}
@keyframes hmDots{0%{clip-path:inset(0 66% 0 0)}33%{clip-path:inset(0 33% 0 0)}66%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(0 66% 0 0)}}
.hmTalkMeta{font-size:12px;opacity:.85}
.hmTalkBtns{padding:12px 14px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:10px;justify-content:flex-end}
.hmTalkBtns .btnSm{min-width:110px}

`;
    document.head.appendChild(st);
  }

  function getClubFromDB(state){
    const db = state?.db || window.HM_DB;
    if(!db) return null;
    const cKey = state?.career?.clubKey;
    const nKey = state?.career?.ntKey;
    // Active team logic: if career.active === 'NT' prefer NT, else club
    const active = state?.career?.active || (state?.career?.mode === 'NT' ? 'NT' : 'CLUB');
    if(active === 'NT'){
      if(nKey && db.nts?.[nKey]) return db.nts[nKey] || null;
      // fallback: if only club exists
      if(cKey && db.clubs?.[cKey]) return db.clubs[cKey] || null;
      return null;
    }
    if(cKey && db.clubs?.[cKey]) return db.clubs[cKey] || null;
    // fallback: allow NT-only career even if active not set
    if(nKey && db.nts?.[nKey]) return db.nts[nKey] || null;
    return null;
  }

  window.renderFMSkin = function renderFMSkin(state, mountEl){
    ensureSkinCSS();
    const t = (k)=> (window.hmT ? window.hmT(k) : k);
    if(!mountEl) return;

// Team status (narativ, bez AI)
    function getTeamStatusText(club, players, pressure){
      const pr = Number(pressure ?? club?.pressure ?? club?.pressureValue ?? 0);
      let avgMorale = 13;
      try{
        if(Array.isArray(players) && players.length){
          const sum = players.reduce((acc,p)=> acc + ensureMorale(p, club), 0);
          avgMorale = sum / players.length;
        }
      }catch(e){}
      if(avgMorale >= 18 && pr <= 6) return "U usponu";
      if(pr >= 8 && avgMorale >= 12) return "Pod pritiskom";
      if(avgMorale <= 9) return "U krizi";
      if(avgMorale <= 12 && pr >= 7) return "U tranziciji";
      return "Stabilna";
    }

    // UI tone for status label (green/yellow/red)
    function getTeamStatusTone(statusText, pressure){
      const s = String(statusText || "").toLowerCase();
      const p = Number(pressure);
      // Keywords win
      if(s.includes("kriz") || s.includes("lo") || s.includes("pad")) return "bad";
      if(s.includes("pritis") || s.includes("tranz") || s.includes("riz")) return "warn";
      if(s.includes("uspon") || s.includes("stabil")) return "good";
      // Fallback to pressure
      if(Number.isFinite(p)){
        if(p >= 7) return "bad";
        if(p >= 4) return "warn";
      }
      return "good";
    }

    const club = getClubFromDB(state);
    if(!club){
      
    mountEl.innerHTML = `
        <div style="padding:16px">
          <div style="font-weight:900; margin-bottom:6px">FAZA 2</div>
          <div style="opacity:.8">Nema podataka o izabranom timu. Proveri da je FAZA 1 upisala <b>state.career.clubKey</b> (klub) ili <b>state.career.ntKey</b> (reprezentacija), i da postoji odgovarajući zapis u <b>HM_DB.clubs</b> ili <b>HM_DB.nts</b>.</div>
        </div>
      `;
      return;
    }

    // --- Tactics model (BASE + NEXT) ---
    // BASE: season/default plan set in Taktika panel
    // NEXT: one-match override coming from Staff suggestions (Option B)
    function ensureTacticsModel(cl){
      if(!cl) return;
      // migrate legacy `club.tactics` (single layer) into tacticsBase
      const legacy = cl.tactics && typeof cl.tactics === "object" ? cl.tactics : null;
      cl.tacticsBase = (cl.tacticsBase && typeof cl.tacticsBase === "object") ? cl.tacticsBase : null;

      if(!cl.tacticsBase){
        cl.tacticsBase = {
          defense: legacy?.defense ?? legacy?.defenseSystem ?? "6-0",
          defenseMode: legacy?.defenseMode ?? "standard",
          attack: legacy?.attack ?? legacy?.attackSystem ?? "balanced",
          tempo: legacy?.tempo ?? "normal",
          risk: legacy?.risk ?? "medium",
          pivotFocus: Number.isFinite(Number(legacy?.pivotFocus)) ? Number(legacy.pivotFocus) : 50,
          crossFrequency: Number.isFinite(Number(legacy?.crossFrequency)) ? Number(legacy.crossFrequency) : 55,
          aggression: Number.isFinite(Number(legacy?.aggression)) ? Number(legacy.aggression) : 3,
          compactness: Number.isFinite(Number(legacy?.compactness)) ? Number(legacy.compactness) : 3,
          fastBreakIntensity: Number.isFinite(Number(legacy?.fastBreakIntensity)) ? Number(legacy.fastBreakIntensity) : 3,
          defensiveRecovery: Number.isFinite(Number(legacy?.defensiveRecovery)) ? Number(legacy.defensiveRecovery) : 3,
          halfStepDepth: legacy?.halfStepDepth ?? "medium",
        };
      }

      // NEXT can be null or object
      if(cl.tacticsNext && typeof cl.tacticsNext !== "object") cl.tacticsNext = null;
      // keep legacy mirror for backwards compat
      cl.tactics = cl.tacticsBase;
    }
    function getActiveTactics(cl){
      if(!cl) return {};
      return (cl.tacticsNext && typeof cl.tacticsNext === "object") ? cl.tacticsNext : (cl.tacticsBase || cl.tactics || {});
    }
    ensureTacticsModel(club);

    // FM UI sub-state (route + expanded groups)
    state.fm = state.fm || {};
    if(!state.fm.openGroups) state.fm.openGroups = ["club","training","transfers","competitions","support"];
    if(!state.fm.route) state.fm.route = "club.players";

    const fm = state.fm;

    // --- FM style sorting for squad table ---
    const SORT_DEFAULT_DIR = { name: 1, position: 1, morale: -1, condition: -1, form: -1, rating: -1, age: 1 };
    const POS_ORDER = { GK:1, LW:2, RW:3, LB:4, CB:5, RB:6, PIV:7 };

    const getSortInd = (key) => {
      const s = fm.squadSort || null;
      if(!s || s.key !== key) return "";
      return (s.dir === 1) ? "▲" : "▼";
    };

    const cmpName = (a,b) => {
      const an = String(a?.name ?? a?.fullName ?? "");
      const bn = String(b?.name ?? b?.fullName ?? "");
      return an.localeCompare(bn, "sr", { sensitivity:"base" });
    };
    const cmpPosition = (a,b) => {
      const ap = String(a?.pos ?? a?.position ?? "").toUpperCase();
      const bp = String(b?.pos ?? b?.position ?? "").toUpperCase();
      return (POS_ORDER[ap] ?? 99) - (POS_ORDER[bp] ?? 99) || cmpName(a,b);
    };
    const cmpMorale = (a,b) => {
      const am = Number(a?.morale ?? a?.moral ?? 0) || 0;
      const bm = Number(b?.morale ?? b?.moral ?? 0) || 0;
      return am - bm || cmpName(a,b);
    };
    const cmpCondition = (a,b) => {
      const ac = Number(a?.condition ?? a?.fitness ?? a?.kondicija ?? 0) || 0;
      const bc = Number(b?.condition ?? b?.fitness ?? b?.kondicija ?? 0) || 0;
      return ac - bc || cmpName(a,b);
    };

    const cmpForm = (a,b) => {
      const af = Number(a?.form ?? a?.forma ?? a?.formLast5 ?? a?.matchForm ?? 6.5) || 0;
      const bf = Number(b?.form ?? b?.forma ?? b?.formLast5 ?? b?.matchForm ?? 6.5) || 0;
      return af - bf || cmpName(a,b);
    };
    const cmpRating = (a,b) => {
      const ar = Number(a?.ovr ?? a?.overall ?? a?.rating ?? a?.avgRating ?? 10) || 0;
      const br = Number(b?.ovr ?? b?.overall ?? b?.rating ?? b?.avgRating ?? 10) || 0;
      return ar - br || cmpName(a,b);
    };
    const cmpAge = (a,b) => {
      const aa = Number(a?.age ?? a?.godine ?? a?.years ?? 0) || 0;
      const ba = Number(b?.age ?? b?.godine ?? b?.years ?? 0) || 0;
      return aa - ba || cmpName(a,b);
    };


    const sortPlayersView = (arr) => {
      const s = fm.squadSort;
      if(!s || !s.key) return arr;
      const dir = (s.dir === -1) ? -1 : 1;
      const key = s.key;
      const cmp = (key === "name") ? cmpName
              : (key === "position") ? cmpPosition
              : (key === "morale") ? cmpMorale
              : (key === "condition") ? cmpCondition
              : (key === "form") ? cmpForm
              : (key === "rating") ? cmpRating
              : (key === "age") ? cmpAge
              : null;
      if(!cmp) return arr;
      arr.sort((a,b) => dir * cmp(a,b));
      return arr;
    };

    // Lineup / Bench assignment (FM-style slots)
    fm.lineup = fm.lineup || { activeSlot: null, assign: {} };
    const openGroups = new Set(fm.openGroups);

    const playsCL = !!club.playsCL || !!club.playsChampionsLeague || false;
    const players = club.players || club.squad || [];
    const staff = club.staff || club.coaches || [];
    const finance = club.finance || { budget: club.budget ?? null, wageBudget: club.wageBudget ?? null, transferBudget: club.transferBudget ?? null };
    const board = club.boardMeta || club.board || {};
    const objectives = board.objectives || club.objectives || state.career?.objectives || [];
    const pressure = club.pressure || state.career?.pressure || null;
    const primaryGoal = board.primaryGoal || state.career?.primaryGoal || null;

    const navModel = () => {
      const competitionsChildren = [
        { id:"comp.league", title:"Liga" },
        { id:"comp.cup", title:"Kup" },
      ];
      if(playsCL) competitionsChildren.push({ id:"comp.cl", title:"Liga šampiona" });

      return [
        { type:"item", id:"mail", icon:"📨", title:"Mejl" },

        { type:"group", id:"club", icon:"🏷", title:t("club"), children:[
          { id:"club.players", title:t("players") },
          { id:"club.staff", title:t("staff") },
          { id:"club.tactics", title:"Taktika" },
          { id:"club.matches", title:"Utakmice" },
        ]},

        { type:"group", id:"training", icon:"🏋", title:"Trening", children:[
          { id:"training.daily", title:"Dnevni trening" },
          { id:"training.weekly", title:"Nedeljni trening" },
          { id:"training.monthly", title:"Mesečni trening" },
        ]},

        { type:"item", id:"finance", icon:"💰", title:"Finansije" },

        { type:"group", id:"transfers", icon:"🔁", title:"Transferi", children:[
          { id:"transfers.players", title:t("players") },
          { id:"transfers.coaches", title:"Treneri" },
        ]},

        { type:"group", id:"competitions", icon:"🏆", title:"Takmičenja", children: competitionsChildren },

        { type:"group", id:"support", icon:"🤝", title:"Podrška", children:[
          { id:"support.board", title:"Uprava" },
          { id:"support.fans", title:"Navijači" },
        ]},
      ];
    };

    function navigate(route){
      fm.route = route;
      renderNav();
      renderScreen();
    }

    function renderNav(){
      const nav = mountEl.querySelector("#nav");
      if(!nav) return;
      nav.innerHTML = "";
      const tree = document.createElement("div");
      tree.className = "tree";

      for(const n of navModel()){
        if(n.type === "item"){
          const wrap = document.createElement("div");
          wrap.className = "item";
          const btn = document.createElement("button");
          btn.className = "itemBtn" + (fm.route === n.id ? " active" : "");
          btn.innerHTML = `<span class="groupIcon">${n.icon}</span><span class="groupTitle">${escapeHtml(n.title)}</span>`;
          btn.onclick = () => navigate(n.id);
          wrap.appendChild(btn);
          tree.appendChild(wrap);
          continue;
        }

        // group
        const group = document.createElement("div");
        const isOpen = openGroups.has(n.id);
        group.className = "group" + (isOpen ? " open" : "");

        const head = document.createElement("div");
        head.className = "groupHead";
        head.innerHTML = `
          <span class="groupIcon">${n.icon}</span>
          <span class="groupTitle">${escapeHtml(n.title)}</span>
          <span class="groupCaret">${isOpen ? "−" : "+"}</span>
        `;
        head.onclick = () => {
          if(openGroups.has(n.id)) openGroups.delete(n.id);
          else openGroups.add(n.id);
          fm.openGroups = Array.from(openGroups);
          renderNav();
        };

        const body = document.createElement("div");
        body.className = "groupBody";

        n.children.forEach(ch => {
          const b = document.createElement("div");
          b.className = "subBtn" + (fm.route === ch.id ? " active" : "");
          b.innerHTML = `<span class="subDot"></span><span>${escapeHtml(ch.title)}</span>`;
          b.onclick = () => navigate(ch.id);
          body.appendChild(b);
        });

        group.appendChild(head);
        group.appendChild(body);
        tree.appendChild(group);
      }

      nav.appendChild(tree);
    }

    function renderScreen(){
      const screen = mountEl.querySelector("#screen");
      const title = mountEl.querySelector("#screenTitle");
      const meta = mountEl.querySelector("#contentMeta");
      const teamStatusEl = mountEl.querySelector("#teamStatus");
      if(!screen || !title) return;

      // Update team status under club name (above slots)
      if(teamStatusEl){
        const teamStatusText = getTeamStatusText(club, players, pressure);
        const tone = getTeamStatusTone(teamStatusText, pressure);
        teamStatusEl.classList.remove("good","warn","bad");
        teamStatusEl.classList.add(tone);
        teamStatusEl.innerHTML = `${escapeHtml(t('team_status'))}: <b>${escapeHtml(teamStatusText)}</b>`;
      }

      // FM topbar: "Nastavi" dugme (prebacuje na globalni Napred)
      const contBtn = mountEl.querySelector('#fmContinueBtn');
      if(contBtn && !contBtn._hmBound){
        contBtn._hmBound = true;
        contBtn.onclick = ()=>{
          const gNext = document.getElementById('navNextBtn');
          if(gNext) gNext.click();
        };
      }

      // Privremeno dugme: TEST MEČ (Match Engine v1) — bez konzole
      const testBtn = mountEl.querySelector('#hmTestMatchBtn');
      if(testBtn && !testBtn._hmBound){
        testBtn._hmBound = true;
        testBtn.onclick = ()=>{
          try{
            if(!window.HM_MATCH || !window.HM_MATCH.simulateFromState){
              alert('Match Engine nije učitan (HM_MATCH). Proveri da li je uključen modules/match_engine.js u index.html.');
              return;
            }

            // Izaberi protivnika iz baze (prvi klub koji nije tvoj)
            const myKey = state?.career?.clubKey;
            const clubsObj = window.HM_DB?.clubs || {};
            const clubEntries = Object.keys(clubsObj).map(k=>({k, v: clubsObj[k]}));
            const oppEntry = clubEntries.find(e=> e.k !== myKey) || clubEntries[0] || null;
            const opponentTeam = oppEntry ? { ...oppEntry.v } : { name:'Test protivnik', teamPower: 12, defenseShape:'6-0', attackStyle:'balanced', players: [] };

            // Lagani overlay "razmišljanje" da deluje kao FM
            const thinking = mountEl.querySelector('#thinkingOverlay');
            if(thinking){ thinking.style.display = 'flex'; }

            setTimeout(()=>{
              let res;
              try{
                res = window.HM_MATCH.simulateFromState(state, opponentTeam, {
                  seed: 'test-' + Date.now(),
                  referee: { strictness: 60 },
                  tacticsA: getActiveTactics(club),
                  tacticsB: (opponentTeam && (opponentTeam.tacticsNext || opponentTeam.tacticsBase || opponentTeam.tactics)) || { defense: '6-0', defenseMode: 'standard', attack: 'balanced', tempo: 'normal' }
                });
              }catch(err){
                console.error(err);
                alert('Greška pri simulaciji meča. Otvori Console i pošalji mi crvenu poruku.');
                if(thinking){ thinking.style.display = 'none'; }
                return;
              }

              if(thinking){ thinking.style.display = 'none'; }

              // One-match override: after a played match, clear tacticsNext
              try{ if(club && club.tacticsNext){ club.tacticsNext = null; } }catch(e){}

              const autoReport = mountEl.querySelector('#autoReport');
              const autoTitle = mountEl.querySelector('#autoReportTitle');
              const autoBody = mountEl.querySelector('#autoReportBody');
              if(autoReport && autoTitle && autoBody){
                const tA = res?.teams?.[0] || 'Tim A';
                const tB = res?.teams?.[1] || 'Tim B';
                const scA = res?.score?.[0] ?? res?.stats?.score?.A ?? 0;
                const scB = res?.score?.[1] ?? res?.stats?.score?.B ?? 0;

                const s = res?.stats || {};
                const fmtShots = (side)=>{
                  const sh = s?.shots?.[side] || {};
                  const gl = s?.goals?.[side] || {};
                  const totalSh = Object.values(sh).reduce((a,b)=>a+(Number(b)||0),0);
                  const totalGl = Object.values(gl).reduce((a,b)=>a+(Number(b)||0),0);
                  return { totalSh, totalGl, sh, gl };
                };
                const A = fmtShots('A');
                const B = fmtShots('B');

                autoTitle.textContent = 'TEST MEČ — Match Engine (v1)';
                autoBody.innerHTML = `
                  <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:10px;">
                    <div style="font-weight:1000; font-size:18px;">${escapeHtml(tA)} <span style="opacity:.8">vs</span> ${escapeHtml(tB)}</div>
                    <div style="font-weight:1000; font-size:22px;">${scA} : ${scB}</div>
                  </div>
                  <div style="margin-top:10px; color:rgba(238,244,255,.75); font-size:12px;">Sudija (strogoća): <b>${Math.round(s?.meta?.referee?.strictness ?? 60)}</b> • Seed: <b>${escapeHtml(String(s?.meta?.seed || ''))}</b></div>

                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px;">
                    <div style="border:1px solid rgba(255,255,255,.10); border-radius:12px; padding:10px; background:rgba(0,0,0,.14)">
                      <div style="font-weight:1000; margin-bottom:6px;">${escapeHtml(tA)}</div>
                      <div style="font-size:12px; line-height:1.5">
                        Šutevi: <b>${A.totalSh}</b> • Golovi: <b>${A.totalGl}</b><br/>
                        7m: <b>${(s?.sevenM?.A||0)}</b> • 2 min: <b>${(s?.twoMin?.A||0)}</b><br/>
                        Greške: <b>${(s?.turnovers?.A?.total||0)}</b> • Ukradene: <b>${(s?.steals?.A||0)}</b> • Blokovi: <b>${(s?.blocks?.A||0)}</b>
                      </div>
                    </div>
                    <div style="border:1px solid rgba(255,255,255,.10); border-radius:12px; padding:10px; background:rgba(0,0,0,.14)">
                      <div style="font-weight:1000; margin-bottom:6px;">${escapeHtml(tB)}</div>
                      <div style="font-size:12px; line-height:1.5">
                        Šutevi: <b>${B.totalSh}</b> • Golovi: <b>${B.totalGl}</b><br/>
                        7m: <b>${(s?.sevenM?.B||0)}</b> • 2 min: <b>${(s?.twoMin?.B||0)}</b><br/>
                        Greške: <b>${(s?.turnovers?.B?.total||0)}</b> • Ukradene: <b>${(s?.steals?.B||0)}</b> • Blokovi: <b>${(s?.blocks?.B||0)}</b>
                      </div>
                    </div>
                  </div>

                  <div style="margin-top:10px; font-size:12px; color:rgba(238,244,255,.78)">
                    Napomena: Ovo je privremeni test (bez upisa u sezonu). Sledeći korak: povezivanje sa pravim rasporedom, formom, kondicijom i vestima.
                  </div>
                `;
                autoReport.style.display = 'block';
              }else{
                alert(`TEST MEČ: ${scA}:${scB}`);
              }
            }, 220);

          }catch(e){
            console.error(e);
            alert('Greška: test meč nije mogao da se pokrene.');
          }
        };
      }

      // Auto izbor dropdown (radi na svim FM ekranima)
      const autoSelTop = mountEl.querySelector("#autoSelect");
      const autoHintTop = mountEl.querySelector("#autoHint");
      const autoReportClose = mountEl.querySelector("#autoReportClose");
      const autoReport = mountEl.querySelector("#autoReport");
      if(autoReportClose && autoReport){
        autoReportClose.onclick = ()=>{ autoReport.style.display = "none"; };
        autoReport.onclick = (e)=>{ if(e.target === autoReport) autoReport.style.display = "none"; };
      }

      if(autoSelTop && !autoSelTop._hmBound){
        autoSelTop._hmBound = true;
        const hmAutoRun = (vRaw)=>{
          const v = vRaw || "";
          if(!v) return;

          // uvek ostaje naziv "auto izbor"
          try{ if(autoSelTop) autoSelTop.value = ""; }catch(_e){}

          // Jednim klikom obriši celu postavu (bez AI overlay-a)
          if(v === "clear_lineup"){
            try{
              const assign = fm.lineup.assign || (fm.lineup.assign = {});
              // očisti sve slotove (GK..PIV + SUB1..SUB9)
              const SLOTS_START = ["GK","LW","LB","CB","RB","RW","PIV"];
              const SLOTS_BENCH = Array.from({length:9}, (_,i)=>`SUB${i+1}`);
              for(const s of [...SLOTS_START, ...SLOTS_BENCH]){
                if(assign[s]) delete assign[s];
              }
              fm.lineup.activeSlot = null;
              if(autoHintTop) autoHintTop.textContent = "Postava obrisana.";
              render();
            }catch(e){
              console.error("Clear lineup error", e);
            }
            return;
          }

          const parts = v.split("_"); // who_ask
          const who = (parts[0] || "assistant").toLowerCase();
          const ask = (parts[1] || "team").toLowerCase(); // team | bench

          const whoLabel = (who==="assistant") ? "Pomoćni trener" : (who==="scout") ? "Skaut" : "Analitičar";
          const askLabel = (ask==="team") ? "razmišlja o sastavu celog tima..." : "razmišlja o sastavu izmena...";

          // --- Staff quality affects selection accuracy & analyst accuracy ---
          const roleName = (who==="assistant") ? "Pomoćni trener" : (who==="scout") ? "Skaut" : "Analitičar";
          const staffSkill = hmGetStaffSkill(club, roleName);
          const staffAcc = hmSkillToAccuracy(staffSkill);

          // Rotate selection model automatically (player can't choose)
          fm._autoPickCount = (fm._autoPickCount ?? 0) + 1;
          const modelIndex = (fm._autoPickCount + (String(club?.name||"").length)) % 5; // 0..4
          const modelLabel = ["Kondicija","Forma","Stabilnost (OVR)","Taktički matchup","Razvoj/rotacija"][modelIndex] || "OVR";


          const overlay = mountEl.querySelector("#thinkingOverlay");
          const overlayTxt = mountEl.querySelector("#thinkingOverlayText");
          if(overlayTxt) overlayTxt.textContent = `${whoLabel} ${askLabel}`;
          if(overlay) overlay.style.display = "flex";

          if(autoHintTop) autoHintTop.textContent = `${whoLabel} ${askLabel}`;

          autoSelTop.disabled = true;

          const SLOTS_START = ["GK","LW","LB","CB","RB","RW","PIV"];
          const SLOTS_BENCH = Array.from({length:9}, (_,i)=>`SUB${i+1}`);

          const getOverall = (p)=>{
            const x = (p && (p.overall ?? p.ovr ?? p.Ovr ?? p.rating ?? p.ocena ?? 0));
            const n = Number(x);
            return Number.isFinite(n) ? n : 0;
          };
          const getPos = (p)=> String(p?.pos ?? p?.position ?? p?.poz ?? "").toUpperCase();
          // IMPORTANT: FM 'assign' koristi playerKey (id/pid ili fallback name|pos|index)
          const getPk = (p,i)=>{
            const stableId = (p && (p.id ?? p.pid ?? p.playerId ?? p._id));
            if(stableId!=null) return String(stableId);
            const name = String(p?.name ?? p?.fullName ?? p?.ime ?? "P");
            const pos  = String(p?.pos ?? p?.position ?? p?.poz ?? "");
            const age  = String(p?.age ?? p?.years ?? p?.god ?? p?.godine ?? "");
            return `${name}|${pos}|${age}`;
          };
          const nameOf = (p)=> String(p?.name ?? p?.ime ?? p?.real ?? "Igrač");

          const squad = (club && Array.isArray(club.squad)) ? club.squad : [];
          const assign = fm.lineup.assign || (fm.lineup.assign = {});
          const used = new Set();

          
          const getFitness = (p)=> hmClamp(hmNum(p?.fitness ?? p?.condition ?? p?.kondicija ?? p?.cond, 70), 0, 100);
          const getForm = (p)=> hmClamp(hmNum(p?.form ?? p?.forma ?? p?.formLast5 ?? p?.matchForm, 6.5), 1, 10);
          const getPotential = (p)=> hmClamp(hmNum(p?.potential ?? p?.pot ?? p?.potencial, 10), 1, 20);
          const getDefense = (p)=> hmClamp(hmNum(p?.def ?? p?.defense ?? p?.defensive ?? p?.odbrana ?? p?.defRating, 10), 1, 20);

          const scorePlayer = (p)=>{
            const ovr = getOverall(p);
            const fit = getFitness(p);
            const form = getForm(p);
            const pot = getPotential(p);
            const def = getDefense(p);

            // Kompaktnost (1–20) utiče na izbor — različito po ulozi.
            const comp = computeCompactness(p, club);
            const compN = hmClamp(comp / 20, 0, 1);

            let base = 0;
            // 5 modela koji se rotiraju: 0 kondicija, 1 forma, 2 ovr, 3 matchup (def), 4 razvoj
            if(modelIndex===0) base = (fit*0.70) + (ovr*6.0) + (form*1.2);
            else if(modelIndex===1) base = (form*14.0) + (ovr*4.5) + (fit*0.20);
            else if(modelIndex===2) base = (ovr*10.0) + (fit*0.25) + (form*1.0);
            else if(modelIndex===3) base = (def*9.0) + (ovr*5.0) + (fit*0.20);
            else base = (pot*7.0) + (fit*0.30) + (ovr*5.0); // modelIndex===4

            // Uloga stručnjaka: pomoćni trener > analitičar > skaut (u smislu kompaktnosti)
            const whoW = (who==="assistant") ? 1.00 : (who==="analyst") ? 0.75 : 0.45;
            const askW = (ask==="team") ? 1.00 : 0.65;

            // Bonus/penal: -20..+20 (pre težine)
            const compDelta = (compN * 40) - 20;
            const compBonus = compDelta * whoW * askW;

            return base + compBonus;
          };

          // deterministic "random" based on club+who+ask+counter (da se ne menja na svaki render)
          let selSeed = 0;
          const seedStr = String(club?.name||"") + "|" + String(who) + "|" + String(ask) + "|" + String(fm._autoPickCount||0) + "|" + String(modelIndex);
          for(let i=0;i<seedStr.length;i++) selSeed = (selSeed*31 + seedStr.charCodeAt(i)) >>> 0;
          const rnd = ()=>{ selSeed = (selSeed*1664525 + 1013904223) >>> 0; return selSeed / 4294967296; };

          function pickBest(filterFn){
            const candidates = [];
            for(let i=0;i<squad.length;i++){
              const p = squad[i];
              const pk = getPk(p,i);
              if(used.has(pk)) continue;
              if(filterFn && !filterFn(p)) continue;
              candidates.push({ p, pk, i, score: scorePlayer(p), ovr: getOverall(p) });
            }
            candidates.sort((a,b)=> (b.score-a.score) || (b.ovr-a.ovr));
            if(!candidates.length) return null;

            // staff accuracy: ponekad promaši "najboljeg" (što je slabiji stručni štab)
            const missChance = hmClamp(1 - staffAcc, 0, 0.35);
            let pickIdx = 0;
            if(rnd() < missChance){
              const topK = Math.min(3, candidates.length);
              if(topK === 2) pickIdx = 1;
              else if(topK >= 3) pickIdx = (rnd() < 0.65) ? 1 : 2;
            }

            const chosen = candidates[pickIdx];
            used.add(chosen.pk);
            return chosen;
          }

          function autoPickFullTeam(){
            used.clear();
            const starters = {}; // slot -> {p,pk}
            for(const slot of SLOTS_START){
              const c = pickBest(pp => getPos(pp) === slot);
              if(c) starters[slot] = c;
            }
            // fallback popuna ako neka pozicija nema prirodnog igrača
            for(const slot of SLOTS_START){
              if(!starters[slot]){
                const c = pickBest(()=>true);
                if(c) starters[slot] = c;
              }
            }
            for(const slot of SLOTS_START){
              const c = starters[slot];
              if(c) assign[slot] = c.pk;
            }
            const bench = [];
            for(let i=0;i<SLOTS_BENCH.length;i++){
              const c = pickBest(()=>true);
              if(!c) break;
              bench.push(c.p);
              assign[SLOTS_BENCH[i]] = c.pk;
            }
            return { starters: Object.values(starters).map(c=>c.p), bench };
          }

          function autoPickBenchOnly(){
            used.clear();
            // startere tretiramo kao zauzete (da ne dupliramo na klupu)
            for(const slot of SLOTS_START){
              const pk = assign[slot];
              if(pk) used.add(String(pk));
            }
            const bench = [];
            for(let i=0;i<SLOTS_BENCH.length;i++){
              const c = pickBest(()=>true);
              if(!c) break;
              bench.push(c.p);
              assign[SLOTS_BENCH[i]] = c.pk;
            }
            return { bench };
          }

          function avgOvr(arr){
            if(!arr || !arr.length) return 0;
            const s = arr.reduce((a,p)=>a+getOverall(p),0);
            return Math.round((s/arr.length)*10)/10;
          }

          function showReport(data){
            const modal = mountEl.querySelector("#autoReport");
            const body = mountEl.querySelector("#autoReportBody");
            const titleEl = mountEl.querySelector("#autoReportTitle");
            if(!modal || !body || !titleEl) return;

            const now = new Date();
            const time = now.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});

            const starters = data.starters || [];
            const bench = data.bench || [];

            const avgFitness = (arr)=>{
              if(!arr || !arr.length) return 0;
              const s = arr.reduce((a,p)=>a + Math.max(0, Math.min(100, (p.fitness ?? p.condition ?? p.kondicija ?? p.cond ?? 50))), 0);
              return Math.round((s/arr.length)*10)/10;
            };

            const aStart = avgOvr(starters);
            const aBench = avgOvr(bench);
            const fStart = avgFitness(starters);
            const fBench = avgFitness(bench);

            const avgComp = (arr)=>{
              if(!arr || !arr.length) return 0;
              const s = arr.reduce((a,p)=>a + computeCompactness(p, club), 0);
              return Math.round((s/arr.length)*10)/10;
            };

            const cStart = avgComp(starters);
            const cBench = avgComp(bench);

            // TEAM_POWER (FM 2007 filozofija – jednostavno, stabilno):
            // Osnova: prosečan OVR startnih 7
            // Bonus: kompaktnost (taktička uigranost pojedinaca) + mali fit faktor
            const teamPowerBase = aStart;
            const teamPower = Math.round((teamPowerBase + ((cStart - 10) * 0.18) + ((fStart - 70) * 0.02)) * 10) / 10;


            
            // Analitičar može da pogreši u procenama (slabiji analitičar -> veća greška u brojkama)
            const repRoleName = whoLabel; // "Pomoćni trener" | "Skaut" | "Analitičar"
            const repSkill = hmGetStaffSkill(club, repRoleName);
            const repNoise = hmSkillToNoiseScale(repSkill);
            let nSeed=0; const nStr=String(club?.name||"")+"|"+String(repRoleName)+"|"+String(time); for(let i=0;i<nStr.length;i++) nSeed=(nSeed*31+nStr.charCodeAt(i))>>>0; const nRnd=()=>{nSeed=(nSeed*1664525+1013904223)>>>0; return nSeed/4294967296;};
            const noise = (range)=> (Math.round(((nRnd()*2-1) * range) * 10)/10);

            const showAStart = hmClamp(Math.round((aStart + (repRoleName==="Analitičar" ? noise(2.2*repNoise) : 0))*10)/10, 1, 20);
            const showABench = hmClamp(Math.round((aBench + (repRoleName==="Analitičar" ? noise(2.2*repNoise) : 0))*10)/10, 1, 20);
            const showFStart = hmClamp(Math.round((fStart + (repRoleName==="Analitičar" ? noise(10*repNoise) : 0))*10)/10, 0, 100);
            const showFBench = hmClamp(Math.round((fBench + (repRoleName==="Analitičar" ? noise(10*repNoise) : 0))*10)/10, 0, 100);

            const repAccPct = Math.round(hmSkillToAccuracy(repSkill)*100);
const top3 = (arr)=> [...arr].sort((a,b)=>getOverall(b)-getOverall(a)).slice(0,3);
            const listNames = (arr)=> arr.map(p=>`${escapeHtml(nameOf(p))} (${getPos(p)} ${getOverall(p)})`).join(", ") || "—";

            // 3-4 varijante izveštaja, stručan ton, kao pomoćni trener
            const keySeed = String(club?.name||"") + "|" + String(who) + "|" + String(ask) + "|" + String(now.getHours()) + String(now.getMinutes());
            let seed = 0; for(let i=0;i<keySeed.length;i++) seed = (seed*31 + keySeed.charCodeAt(i)) >>> 0;
            const pick = (n)=> (seed % n);

            const teamTemplates = [
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Fokus je bio da svaka linija ima najjaču moguću “osovinu” po <b>Prosečna ocena</b>, uz minimalan kompromis po pozicijama.</div>
                  <div style="margin-top:8px"><b>Metričke:</b> prva postava ${showAStart} OVR / ${showFStart}% kond • klupa ${showABench} OVR / ${showFBench}% kond</div>
                  <div style="margin-top:8px"><b>Ključni nosioci:</b> ${listNames(top3(starters))}</div>
                  <div style="margin-top:8px"><b>Napomena:</b> Ako neka pozicija nema prirodnog igrača, slot je popunjen najboljim raspoloživim igračem (OVR), da ne ostane “rupa” u strukturi.</div>
                </div>`,
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Sastav je složen po principu “sigurna kičma + brzina spolja”. Prvo sam zatvorio pozicije, pa dodao kvalitet.</div>
                  <ul style="margin:8px 0 0 18px; line-height:1.45">
                    <li><b>Pozicije</b>: prioritet da se GK/LW/LB/CB/RB/RW/PIV popune prirodnim rešenjima.</li>
                    <li><b>Kvalitet</b>: OVR je glavni kriterijum kad ima više opcija na istoj poziciji.</li>
                    <li><b>Rotacija</b>: klupa je birana po “impact” profilu — da imaš čime da menjaš tempo.</li>
                  </ul>
                  <div style="margin-top:8px"><b>Top igrači u prvoj postavi:</b> ${listNames(top3(starters))}</div>
                  <div style="margin-top:8px"><b>Prosek:</b> ${showAStart} OVR (start) • ${showABench} OVR (klupa)</div>
                </div>`,
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Uzeo sam “najbolje dostupno” po pozicijama, ali sam pazio da ne dupliram iste profile i da klupa bude jaka.</div>
                  <div style="margin-top:8px"><b>Šta je presudilo:</b></div>
                  <div style="margin-top:6px">1) Pozicija → 2) OVR → 3) kondicija (kao tie-break kad su blizu)</div>
                  <div style="margin-top:8px"><b>Nosilac(i):</b> ${listNames(top3(starters))}</div>
                  <div style="margin-top:8px"><b>Metričke:</b> start ${showAStart} OVR / ${showFStart}% • klupa ${showABench} OVR / ${showFBench}%</div>
                </div>`,
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Sastav je optimizovan za “realan FM pristup”: najjači na poziciji u startu, a na klupi maksimalna širina.</div>
                  <div style="margin-top:8px"><b>Plan izmene:</b> prva 2 SUB slota su najjači overall (momentum), ostali su “sigurna rotacija”.</div>
                  <div style="margin-top:8px"><b>Prosek prve postave:</b> ${showAStart} OVR • <b>Prosek klupe:</b> ${showABench} OVR</div>
                  <div style="margin-top:8px"><b>Najbolji izbori:</b> ${listNames(top3(starters))}</div>
                </div>`
            ];

            const benchTemplates = [
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Startere nisam dirao. Popunio sam samo <b>SUB1–SUB9</b> sa najboljim raspoloživim igračima po <b>Prosečna ocena</b>, bez dupliranja.</div>
                  <div style="margin-top:8px"><b>Najjače opcije sa klupe:</b> ${listNames(top3(bench))}</div>
                  <div style="margin-top:8px"><b>Prosek klupe:</b> ${showABench} OVR • ${showFBench}% kond</div>
                  <div style="margin-top:8px">Klupa je “kratka i oštra”: brze izmene bez pada kvaliteta.</div>
                </div>`,
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Cilj mi je bio da na klupi imaš rešenja za 3 scenarija: “jurimo rezultat”, “čuvamo prednost” i “rotiramo bez rizika”.</div>
                  <ul style="margin:8px 0 0 18px; line-height:1.45">
                    <li><b>SUB1–SUB3</b>: najjači po OVR (momentum i preokret)</li>
                    <li><b>SUB4–SUB6</b>: stabilna rotacija (bez pada)</li>
                    <li><b>SUB7–SUB9</b>: dubina i pokrivanje profila</li>
                  </ul>
                  <div style="margin-top:8px"><b>Top sa klupe:</b> ${listNames(top3(bench))}</div>
                  <div style="margin-top:8px"><b>Prosek klupe:</b> ${showABench} OVR</div>
                </div>`,
              ()=>`
                <div style="line-height:1.45">
                  <div><b>${whoLabel}:</b> Popunio sam izmene po “čistoj snazi” (OVR), ali sam pazio da ne uzmem igrače koji su već u startu.</div>
                  <div style="margin-top:8px"><b>Metričke:</b> klupa ${showABench} OVR / ${showFBench}% kond</div>
                  <div style="margin-top:8px"><b>Najbolji izbori:</b> ${listNames(top3(bench))}</div>
                  <div style="margin-top:8px">Ako želiš taktičku klupu (specijalisti), reci pa ubacujemo logiku profila.</div>
                </div>`
            ];

            titleEl.textContent = `${whoLabel} izveštaj (${time})`;
            body.innerHTML = `
              <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:10px">
                <span style="padding:6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(0,0,0,.18)"><b>Model izbora:</b> ${escapeHtml(modelLabel)}</span>
                <span style="padding:6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(0,0,0,.18)"><b>Kvalitet (${escapeHtml(repRoleName)}):</b> ${repSkill}/20</span>
                <span style="padding:6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(0,0,0,.18)"><b>Pouzdanost:</b> ${repAccPct}%</span>
                <span style="padding:6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(0,0,0,.18)"><b>Kompaktnost (XI):</b> ${cStart}/20</span>
                <span style="padding:6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:999px; background:rgba(0,0,0,.18)"><b>TEAM_POWER:</b> ${teamPower}</span>

              </div>
            ` + ((ask==="team")
              ? teamTemplates[pick(teamTemplates)]()
              : benchTemplates[pick(benchTemplates)]());

            modal.style.display = "block";
          }
          window.setTimeout(()=>{
            let data = null;
            try{
              data = (ask==="team") ? autoPickFullTeam() : autoPickBenchOnly();
            }catch(e){
              console.error("Auto izbor error", e);
            }

            if(overlay) overlay.style.display = "none";
            if(autoHintTop) autoHintTop.textContent = "";

            autoSelTop.disabled = false;

            // osveži ekran da prikaže novi sastav/izmene
            try{ renderScreen(); }catch(e){}

            if(data){ try{ showReport(data); }catch(e){ console.error("Auto izbor report error", e);} }
          }, 4000);
        };
        
        // Bind stable handler for Auto izbor (used by delegated listener too)
        autoSelTop._hmAutoHandler = ()=>hmAutoRun((autoSelTop && autoSelTop.value) || "");
        window.__hmAutoHandler = hmAutoRun;

const __hmAutoFire = ()=>{ 
          try{ autoSelTop._hmAutoHandler(); }
          catch(e){
            console.error("Auto izbor handler error", e);
            if(autoHintTop) autoHintTop.textContent = "Greška u auto izboru. Pogledaj konzolu.";
            const overlay = mountEl.querySelector("#thinkingOverlay");
            if(overlay) overlay.style.display = "none";
            autoSelTop.disabled = false;
          }
        };
        autoSelTop.addEventListener("change", __hmAutoFire);
        autoSelTop.addEventListener("input", __hmAutoFire);
     }


      // meta pills
      if(meta){
        meta.innerHTML = `
          <span class="pill">Sezona: 2026/27</span>
          <span class="pill">${pressure ? ("Pritisak: " + escapeHtml(String(pressure))) : "Pritisak: ?"}</span>
          ${club && typeof club.pressureProgress==="number" ? `<div class="fm-progress ${club.pressureProgress<30?"low":""}" style="width:140px; display:inline-block; vertical-align:middle; margin-left:10px;"><span style="width:${Math.max(0,Math.min(100,club.pressureProgress))}%"></span></div>` : ""}
        `;
      }

      
      // Clear screen before route render (prevents stale content if something throws)
      screen.innerHTML = "";
      if(meta) meta.textContent = "";

if(fm.route === "mail"){
        title.textContent = "Mejl";
        const news = club.news || state.career?.news || [];
        screen.innerHTML = `
          <div class="tableTitleRow">
            <div>
              <div style="font-weight:1000">News / Vesti</div>
              <div class="sub">Poruke i obaveštenja</div>
            </div>
            <span class="tagMini">${news.length} poruka</span>
          </div>
          <div style="padding:10px 6px 2px 6px">
            ${news.map(n => `
              <div style="border:1px solid rgba(255,255,255,.10); background:rgba(0,0,0,.14); border-radius:16px; padding:12px; margin-bottom:10px;">
                <div style="font-weight:1000">${escapeHtml(n.h || n.title || "Poruka")}</div>
                <div style="color:rgba(238,244,255,.72); font-size:12px; margin-top:4px; line-height:1.35">${escapeHtml(n.m || n.msg || n.body || "")}</div>
              </div>
            `).join("")}
          </div>
        `;

      return;
      }

      if(fm.route === "club.players"){
        title.textContent = "Igrači";

        const dayIndex = Number(state?.career?.dayIndex ?? state?.career?.day ?? fm?.dayIndex ?? 0) || 0;

        const SLOTS_START = ["GK","LW","LB","CB","RB","RW","PIV"];
        const SLOTS_BENCH = Array.from({length:9}, (_,i)=>`SUB${i+1}`);
        const SLOTS_ALL = [...SLOTS_START, ...SLOTS_BENCH];

        const assign = fm.lineup.assign || (fm.lineup.assign = {});
        const activeSlot = fm.lineup.activeSlot;

        // IMPORTANT: playerKey MUST be stable across sorting.
        // Never include row index from the current view (it changes when you sort).
        const playerKey = (p,i) => {
          const stableId = (p && (p.id ?? p.pid ?? p.playerId));
          if(stableId!=null) return String(stableId);
          // Fallback: deterministic signature (no view index)
          const name = String(p?.name ?? p?.fullName ?? "P");
          const pos  = String(p?.pos ?? p?.position ?? p?.poz ?? "");
          const age  = String(p?.age ?? p?.years ?? p?.god ?? p?.godine ?? "");
          return `${name}|${pos}|${age}`;
        };

        // reverse lookup: playerKey -> slot
        const assignedSlotByPlayer = {};
        for(const s of Object.keys(assign)){
          const pk = assign[s];
          if(pk) assignedSlotByPlayer[pk] = s;
        }

        // players view (sorted). We keep references to original player objects,
        // but store real index so clicks/assignments are always correct.
        const playersView = sortPlayersView([...(players||[])]);

        const renderSlotChip = (s) => {
          const isActive = activeSlot === s;
          const isFilled = !!assign[s];
          return `<button class="hmSlotChip ${isActive?'active':''} ${isFilled?'filled':''}" data-slot="${s}" type="button">${s}</button>`;
        };

        screen.innerHTML = `
          <div class="tableTitleRow">
            <div style="display:flex; flex-direction:column; gap:8px;">
              <div class="hmScreenHeadline">Igrači</div>
              <div class="hmLineupBar">
                <div class="hmLineupGroup">
                  ${SLOTS_START.map(renderSlotChip).join("")}
                </div>
                <div class="hmLineupSep"></div>
                <div class="hmLineupGroup">
                  ${SLOTS_BENCH.map(renderSlotChip).join("")}
                </div>
              </div>
              <div class="sub">Klikni slot gore, pa klikni kvadratić pored igrača da dodeliš (FM 2007).</div>
            </div>
            <div class="hmAutoTools">
              <select class="topSelect hmAutoSelect" id="autoSelect">
                <option value="" selected>auto izbor</option>
                <optgroup label="Postava">
                  <option value="clear_lineup">Obriši celu postavu</option>
                </optgroup>
                <optgroup label="Pitaj pomoćnika">
                  <option value="assistant_team">Sastav celog tima</option>
                  <option value="assistant_bench">Sastav izmena</option>
                </optgroup>
                <optgroup label="Pitaj skauta">
                  <option value="scout_team">Sastav celog tima</option>
                  <option value="scout_bench">Sastav izmena</option>
                </optgroup>
                <optgroup label="Pitaj analitičara">
                  <option value="analyst_team">Sastav celog tima</option>
                  <option value="analyst_bench">Sastav izmena</option>
                </optgroup>
              </select>
              <div class="autoHint" id="autoHint">${escapeHtml(fm.autoHint || "")}</div>
              <span class="tagMini">${playersView.length} igrača</span>
            </div>
          </div>
          <div class="tableWrap">
            <table aria-label="Igrači">
              <thead>
                <tr>
                  <th style="width:4%"></th>
                  <th class="hmSort ${(fm.squadSort && fm.squadSort.key==="name") ? "active" : ""}" data-sort="name" style="width:34%">${t("name")} <span class="sortInd">${getSortInd("name")}</span></th>
                  <th class="hmSort ${(fm.squadSort && fm.squadSort.key==="position") ? "active" : ""}" data-sort="position" style="width:8%">${t("position")} <span class="sortInd">${getSortInd("position")}</span></th>
                  <th class="hmSort ${(fm.squadSort && fm.squadSort.key==="morale") ? "active" : ""}" data-sort="morale" style="width:10%">
                    Moral <span class="hmQMark hmTip" data-tip="MORAL (1–25)\n\n• 1–5 loš\n• 5–10 nizak\n• 10–15 srednji\n• 15–20 dobar\n• 20–25 odličan\n\nVeći moral = stabilniji učinak.">?</span>
                    <span class="sortInd">${getSortInd("morale")}</span>
                  </th>
                  <th class="hmSort ${(fm.squadSort && fm.squadSort.key==="condition") ? "active" : ""}" data-sort="condition" style="width:14%">
                    <span class="hmTip fitness-head" data-tip="KONDICIJA — šta znači?\n\nKondicija je trenutna fizička spremnost igrača (0–100%).\n\n• Viša kondicija = veći intenzitet i stabilniji učinak\n• Niska kondicija = pad performansi + veći rizik povrede">${t("condition")} <span class="hmQMark">?</span></span>
                    <span class="sortInd">${getSortInd("condition")}</span>
                  </th>
                  <th class="hmSort ${(fm.squadSort && fm.squadSort.key==="form") ? "active" : ""}" data-sort="form" style="width:14%">${t("form")} <span class="sortInd">${getSortInd("form")}</span></th>
<th class="hmSort ${(fm.squadSort && fm.squadSort.key==="rating") ? "active" : ""}" data-sort="rating" style="width:14%">Prosečna ocena <span class="sortInd">${getSortInd("rating")}</span></th>
<th style="width:12%"><span class="hmTip compactHead" data-tip="🧩 KOMPAKTNOST — šta znači?

Kompaktnost pokazuje koliko je igrač taktički usklađen sa timom.

• Pozicioniranje + disciplina
• Timska odbrana + anticipacija
• Stabilnost koncentracije

Veća kompaktnost = stabilnija timska igra i bolji TEAM_POWER.

U auto izboru, pomoćni trener je najviše vrednuje.">${t("cohesion")} <span class="hmQMark">?</span></span></th><th class="hmSort colAge ${(fm.squadSort && fm.squadSort.key==="age") ? "active" : ""}" data-sort="age" style="width:6%">${t("age")} <span class="sortInd">${getSortInd("age")}</span></th>

                </tr>
              </thead>
              <tbody>
                ${playersView.map((p,i)=>{
                  const ri = Math.max(0, (players||[]).indexOf(p));
                  const pk = playerKey(p,ri);
                  const as = assignedSlotByPlayer[pk] || "";
                  return `
                    <tr class="${(as?'hmRowSelected':'')} ${(fm.lineup.flashPk===pk && Date.now() < (fm.lineup.flashUntil||0))?'hmFlash':''}" data-ri="${ri}" data-pk="${escapeHtml(pk)}">
                      <td>
                        <button class="hmAssignBox ${as?'filled':''}" data-ri="${ri}" data-pk="${escapeHtml(pk)}" type="button">${escapeHtml(as)}</button>
                      </td>
                      <td><span class="linkLike">${escapeHtml(p.name)}</span></td>
                      <td>${escapeHtml(p.pos || p.position || "")}</td>
                      <td>${(()=>{
                        const mVal = ensureMorale(p, club);
                        const a = moraleToArrow(mVal);
                        const face = (mVal<=5)?"😡":(mVal<=10)?"😕":(mVal<=15)?"😐":(mVal<=20)?"🙂":"😎";
                        return `<span class="moraleChip hmTip ${a.cls}" data-tip="${escapeAttr(psychTooltip(p, club, as))}">
                                  <span class="moraleArrow ${a.cls}">${a.arrow}</span>
                                  <span class="moraleFloat">${Math.round(Number(mVal)||0)}/25</span>
                                </span>`;
                      })()}</td>
                      <td>${renderFitnessBar(p, dayIndex)}</td>
                      <td>${escapeHtml(p.formText || p.form || "")}</td>
                      <td>${renderOVRBar(p)}</td>
                      <td class="num">${(()=>{
                        const c = computeCompactness(p, club);
                        const mt = compactnessToMeter(c);
                        const tipMain = escapeAttr(compactTooltip(p, club));
                        const tipBreak = escapeAttr(compactBreakdownTooltip(p, club));
                        return `
                          <span class="cmpCell compactCell">
                            <b class="hmTip" data-tip="${tipMain}">${c}</b>
                            <span class="cmpMini hmTip" data-tip="${tipBreak}" aria-hidden="true">
                              <span style="width:${mt.pct}%"></span>
                            </span>
                          </span>`;
                      })()}</td>
                      <td class="colAge">${ensureAge(p)}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `;


        // Column sorting (left click on headers)
        const thead = screen.querySelector("thead");
        if(thead && !thead._hmSortBound){
          thead._hmSortBound = true;
          thead.addEventListener("click", (e) => {
            const th = e.target.closest("[data-sort]");
            if(!th) return;
            const key = th.getAttribute("data-sort");
            if(!key) return;

            fm.squadSort = fm.squadSort || { key: null, dir: 1 };
            if(fm.squadSort.key === key){
              fm.squadSort.dir = (fm.squadSort.dir === 1) ? -1 : 1;
            }else{
              fm.squadSort.key = key;
              fm.squadSort.dir = SORT_DEFAULT_DIR[key] ?? 1;
            }
            render();
          });
        }

        // Slot selection
        screen.querySelectorAll(".hmSlotChip").forEach(btn => {
          btn.addEventListener("click", (e) => {
            const s = btn.getAttribute("data-slot");
            fm.lineup.activeSlot = (fm.lineup.activeSlot === s) ? null : s;
            render();
          });
        });


        // Desni klik na PRAZAN kvadratić -> automatski popuni slotove po redosledu pozicija (GK,LW,LB,CB,RB,RW,PIV, pa SUB1–SUB9)
        function autoFillSlotsByPositionOrder(){
          const squad = (club && Array.isArray(club.squad)) ? club.squad : [];
          const used = new Set();
          const getOverall = (p)=>{
            const x = (p && (p.overall ?? p.ovr ?? p.Ovr ?? p.rating ?? p.ocena ?? 0));
            const n = Number(x);
            return Number.isFinite(n) ? n : 0;
          };
          const getPos = (p)=> String(p?.pos ?? p?.position ?? p?.poz ?? "").toUpperCase();
          const getPk = (p,i)=> playerKey(p,i);

          function pickBest(filterFn){
            let best = null; // {p,pk,i,ovr}
            let bestOvr = -1;
            for(let i=0;i<squad.length;i++){
              const p = squad[i];
              const pk = getPk(p,i);
              if(used.has(pk)) continue;
              if(filterFn && !filterFn(p)) continue;
              const o = getOverall(p);
              if(o > bestOvr){ bestOvr = o; best = { p, pk, i, ovr:o }; }
            }
            if(best) used.add(best.pk);
            return best;
          }

          // očisti postojeće mapiranje za sve slotove koje ovde kontrolišemo
          for(const s of SLOTS_ALL){
            if(assign[s]) delete assign[s];
          }

          const starters = {};
          for(const slot of SLOTS_START){
            const c = pickBest(pp => getPos(pp) === slot);
            if(c) starters[slot] = c;
          }
          // fallback ako nema prirodnog igrača za poziciju
          for(const slot of SLOTS_START){
            if(!starters[slot]){
              const c = pickBest(()=>true);
              if(c) starters[slot] = c;
            }
          }
          for(const slot of SLOTS_START){
            const c = starters[slot];
            if(c) assign[slot] = c.pk;
          }
          for(let i=0;i<SLOTS_BENCH.length;i++){
            const c = pickBest(()=>true);
            if(!c) break;
            assign[SLOTS_BENCH[i]] = c.pk;
          }

          fm.lineup.activeSlot = null;
          render();
        }

        // Assignment boxes (FM 2007 click-click)
        screen.querySelectorAll(".hmAssignBox").forEach(btn => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const ri = Number(btn.getAttribute("data-ri"));
            const p = players[ri];
            if(!p) return;
            const pk = btn.getAttribute("data-pk") || playerKey(p,ri);

            const curSlot = assignedSlotByPlayer[pk] || null;
            const s = fm.lineup.activeSlot;

            // If no active slot: clicking a filled box clears it
            if(!s){
              if(curSlot){
                delete assign[curSlot];
                fm.lineup.flashPk = pk;
                fm.lineup.flashUntil = Date.now() + 650;
                render();
              }
              return;
            }

            // If this player already has a different slot, clear it first
            if(curSlot && curSlot !== s){
              delete assign[curSlot];
            }

            // If slot already used by another player, clear that mapping
            if(assign[s] && assign[s] !== pk){
              const otherPk = assign[s];
              // remove reverse mapping handled by rebuild on render
              assign[s] = null;
            }

            assign[s] = pk;
            fm.lineup.flashPk = pk;
            fm.lineup.flashUntil = Date.now() + 650;
            render();
          });

            // Desni klik (FM-style):
  // - ako je slot popunjen (igrač već ima dodeljenu poziciju) -> obriši samo taj slot
  // - ako je slot prazan -> dodeli SLEDEĆI slobodan slot po redu (GK, LW, LB, CB, RB, RW, PIV, SUB1..)
  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const ri = Number(btn.getAttribute("data-ri"));
    const p = players[ri];
    if(!p) return;
    const pk = btn.getAttribute("data-pk") || playerKey(p,ri);

    const curSlot = assignedSlotByPlayer[pk] || null;

    // 1) Desni klik na već postavljenu poziciju -> obriši samo tu poziciju
    if(curSlot){
      delete assign[curSlot];
      fm.lineup.flashPk = pk;
      fm.lineup.flashUntil = Date.now() + 650;
      fm.lineup.activeSlot = null;
      render();
      return;
    }

    // 2) Desni klik na prazan slot -> dodeli sledeći slobodan slot po redu
    const nextFree = SLOTS_ALL.find(s2 => !!s2 && !assign[s2]);
    if(!nextFree){
      // nema slobodnih slotova
      return;
    }
    assign[nextFree] = pk;
    fm.lineup.flashPk = pk;
    fm.lineup.flashUntil = Date.now() + 650;
    fm.lineup.activeSlot = null;
    render();
  });
});

// Row click -> profile
        screen.querySelectorAll("tbody tr").forEach(tr => {
          tr.addEventListener("click", (e) => {
            const idx = Number(tr.getAttribute("data-ri"));
            if(typeof window.openPlayerCard === "function"){
              window.openPlayerCard("CAREER", idx);
            } else {
              alert("Profil: " + (players[idx]?.name||""));
            }
          });
        });

        return;
      }

      if(fm.route === "club.staff"){
        title.textContent = "Stručni štab";
        try{

        // --- Staff hub state ---
        fm.staffHub = fm.staffHub || { selected:"", last:{}, ignores:0, accepts:0 };
        const hub = fm.staffHub;

        const clubKey = String(state?.career?.clubKey ?? club?.key ?? club?.id ?? club?.name ?? "club");

        const rawStaff = (club.staff || club.coaches || []).slice().filter(Boolean);

        function norm(s){ return String(s||"").toLowerCase(); }
        function roleOf(s){ if(!s) return ""; return (s.role || s.title || s.position || ""); }
        function findRole(pred){
          return rawStaff.find(s=> pred(norm(roleOf(s)))) || null;
        }
        // Prefer exact Serbian role names, fallback by keywords
        // role picks by keywords (DB-safe)
        // U FM fazi TI si glavni trener, pa ne prikazujemo "glavnog trenera" u štabu.
        const assistant = findRole(r=> r.includes("pomo") && r.includes("trener")) || findRole(r=> r.includes("assistant")) || null;
        const analyst   = findRole(r=> r.includes("analiti")) || findRole(r=> r.includes("analyst")) || null;
        const physio    = findRole(r=> r.includes("fizio")) || findRole(r=> r.includes("physio")) || findRole(r=> r.includes("medical")) || null;
        const scout     = findRole(r=> r.includes("skaut")) || findRole(r=> r.includes("scout")) || null;
        const fitnessC  = findRole(r=> r.includes("kondic")) || findRole(r=> r.includes("fitness")) || null;

const core = [
          { key:"assist",  label:"Pomoćnik",         person: assistant, roleGuess:"pomoćni trener" },
          { key:"analyst", label:"Analitičar",       person: analyst,   roleGuess:"analitičar" },
          { key:"physio",  label:"Fizioterapeut",    person: physio,    roleGuess:"fizioterapeut" },
          { key:"scout",   label:"Skaut",            person: scout,     roleGuess:"skaut" },
          { key:"fitness", label:"Kondicioni",       person: fitnessC,  roleGuess:"kondicioni trener" },
        ];

        // Ensure selected role exists
        const firstKey = (core.find(c=>c.person)?.key) || (core[0]?.key) || "assist";
        if(!hub.selected) hub.selected = firstKey;
        const sel = hub.selected;


        // NOTE: Glavni trener ne postoji u FM fazi — TI si glavni trener.
        

        // Deterministic spec/weakness (no new data hardcoded)
        const SPECS = {
          assist: ["Rotacije","Priprema meča","Rad sa mladima","Disciplina"],
          analyst:["Čitanje protivnika","Video analiza","Taktička preciznost","Statistička procena"],
          physio: ["Prevencija povreda","Oporavak","Tretmani","Rano otkrivanje zamora"],
          scout:  ["Procena potencijala","Procena kvaliteta","Mreža kontakata","Pronalazak talenata"],
          fitness:["Intenzitet treninga","Zamor kontrola","Fizička priprema","Snaga i brzina"],
        };

        const WEAKS = {
          assist: ["Loša komunikacija","Previše oprezan","Ne voli promene","Kasni sa korekcijama"],
          analyst:["Previše teorije","Fokus na detalje","Kasni sa izveštajem","Slab pod pritiskom"],
          physio: ["Previše oprezan","Spor oporavak","Slab individualni plan","Previše odmora"],
          scout:  ["Previše optimista","Slab filter","Kasni sa preporukama","Pogrešna procena karaktera"],
          fitness:["Pretera sa opterećenjem","Slab individualni rad","Ne voli rotacije","Rizikuje povrede"],
        };
        function pick(arr, seed){
          if(!arr || !arr.length) return "";
          const i = seed % arr.length;
          return arr[i];
        }
        function staffName(s){ return s ? (s.name || s.fullName || s.ime || "—") : "Nije postavljen"; }
        function staffAge(s){ return s ? (s.age || s.godine || "—") : "—"; }
        function staffFlag(s){ return s ? (s.flag || s.countryFlag || s.nationFlag || "") : ""; }
        function staffWage(s){
          if(!s) return "—";
          const w = s.wage || s.salary || s.plata || "";
          return w ? String(w) : "—";
        }
        function staffContract(s){
          if(!s) return "—";
          const c = s.contractUntil || s.contractEnd || s.ugovor || "";
          return c ? String(c) : "—";
        }

        // Influence baseline from skills (simple and transparent)
        const skHead    = hmGetStaffSkill(club, "glavni trener");
        const skAssist  = hmGetStaffSkill(club, "pomoćni trener");
        const skFitness = hmGetStaffSkill(club, "kondicioni trener");
        const skAnalyst = hmGetStaffSkill(club, "analitičar");

        const baseInfluence = {
          morale:  Math.round((skHead-10)/2),
          cohesionPct: Math.round((skAssist-10)*0.6),
          pressure: Math.round((skHead-10)*0.5 + (skAnalyst-10)*0.3),
          injuryRiskPct: -Math.round((skFitness-10)*0.7),
          tacticsPct: Math.round((skAssist-10)*0.4 + (skAnalyst-10)*0.6),
        };

        // Clamp for display
        function infClamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
        const inf = {
          morale: infClamp(baseInfluence.morale, -5, 8),
          cohesionPct: infClamp(baseInfluence.cohesionPct, -8, 12),
          pressure: infClamp(baseInfluence.pressure, -6, 10),
          injuryRiskPct: infClamp(baseInfluence.injuryRiskPct, -18, 10),
          tacticsPct: infClamp(baseInfluence.tacticsPct, -8, 14),
        };

        // If player ignores advice // Option B: ignorisanje saveta slabi odnos SA ŠTABOM (ne menja moral ekipe ovde)
        const totalIgnores = Number(hub.ignores||0);
        const comm = clamp(100 - totalIgnores*6, 40, 100); // komunikacija
        function staffAvgMorale(){
          const vals = Object.values(hub.staffMorale||{}).map(v=>Number(v)||0).filter(v=>v>0);
          if(!vals.length) return 0;
          return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
        }
        const avgM = staffAvgMorale();

        function moraleDeltaText(roleKey, delta){
          const sign = delta>0?"+":"";
          return `Moral: ${sign}${delta}`;
        }

        
        // === Staff suggestions system (season + match) ===
        if(!hub.sugg) hub.sugg = { perRole:{}, seasonGenerated:false, lastMatchToken:null, log:[] };

        function pkPlayer(p){
          if(!p) return "";
          return String(p.id ?? p.pid ?? p.playerId ?? p._id ?? `${p.name||p.ime||""}|${p.position||p.pos||p.poz||""}|${p.age||p.godine||""}`);
        }
        function getPlayersList(){
          const arr = (club.players || club.squad || state._careerPlayers || []);
          return Array.isArray(arr) ? arr : [];
        }
        function numForm(p){
          const v = Number(p.form ?? p.avgRating ?? p.rating ?? p.ocena ?? p.prosecnaOcena ?? p.prosecna_ocena);
          return isFinite(v) ? v : 0;
        }
        function numFitness(p){
          const v = Number(p.fitness ?? p.condition ?? p.kondicija ?? p.cond);
          return isFinite(v) ? v : 0;
        }
        function numMorale(p){
          const v = Number(p.morale ?? p.moral);
          return isFinite(v) ? v : 0;
        }
        function gamesInRow(p){
          const v = Number(p.gamesInRow ?? p.gir ?? p.streakGames ?? (p.recent && p.recent.gamesInRow));
          return isFinite(v) ? v : 0;
        }
        function minutesLast3(p){
          const v = Number(p.minutesLast3 ?? (p.recent && p.recent.minutesLast3));
          return isFinite(v) ? v : 0;
        }

        function ensureRoleBucket(roleKey){
          if(!hub.sugg.perRole[roleKey]) hub.sugg.perRole[roleKey] = { queue:[], active:[] };
          return hub.sugg.perRole[roleKey];
        }
        function newSugId(roleKey, type){
          // stable-ish id for session
          return `${type}:${roleKey}:${Date.now()}:${Math.floor(Math.random()*1e9)}`;
        }
        function pushSug(roleKey, type, title, text){
          const bucket = ensureRoleBucket(roleKey);
          const sug = {
            id: newSugId(roleKey, type),
            type,
            author: roleKey,
            title,
            text,
            status: "pending"
          };
          bucket.queue.push(sug);

          // Mirror to top-level state (for future engine/hooks) WITHOUT duplicates per session
          if(type === "season"){
            state.seasonSuggestions = state.seasonSuggestions || [];
            state.seasonSuggestions.push(sug);
          } else if(type === "match"){
            state.matchSuggestions = state.matchSuggestions || [];
            state.matchSuggestions.push(sug);
          }
        }
        function fillActive(roleKey){
          const bucket = ensureRoleBucket(roleKey);
          while(bucket.active.length < 3 && bucket.queue.length){
            bucket.active.push(bucket.queue.shift());
          }
        }
        function removeActive(roleKey, id, status){
          const bucket = ensureRoleBucket(roleKey);
          const idx = bucket.active.findIndex(s=>s.id===id);
          if(idx<0) return;
          const sug = bucket.active[idx];
          sug.status = status;
          bucket.active.splice(idx,1);

          // Update mirrored arrays in state
          const upd = (arr)=>{
            if(!Array.isArray(arr)) return;
            const it = arr.find(x=>x && x.id===id);
            if(it) it.status = status;
          };
          upd(state.seasonSuggestions);
          upd(state.matchSuggestions);

          hub.sugg.log.push({ ...sug, decidedAt: Date.now(), clubKey });
          fillActive(roleKey);
        }

        // --- Season suggestions (only once per season) ---
        function ensureSeasonSuggestions(){
          const seasonNum = Number(state?.career?.season ?? 1);
          const tag = `${clubKey}:S${seasonNum}`;
          if(hub.sugg.seasonGenerated === tag) return;

          // reset buckets for new season but keep log
          hub.sugg.perRole = hub.sugg.perRole || {};
          ["assist","analyst","physio","scout","fitness"].forEach(r=>{
            if(!hub.sugg.perRole[r]) hub.sugg.perRole[r] = { queue:[], active:[] };
          });

          // Assistant – squad balance / rotations / identity
          pushSug("assist","season","Plan balansa postave",
            "Predlažem stabilnu hijerarhiju u postavi: 6–7 nosilaca, 4–5 rotacionih i 3 razvojna igrača. Tako izbegavamo oscilacije i održavamo disciplinu u ključnim minutima.");
          pushSug("assist","season","Plan rotacija tokom sezone",
            "Predlažem unapred definisane rotacije po pozicijama (krila i bekovi najviše trpe). Cilj je da kondicija ostane iznad 75% pre završnica, uz minimalan pad uigranosti.");
          pushSug("assist","season","Taktički identitet",
            "Predlažem da izaberemo primarni identitet (npr. čvrsta 6-0 + kontrolisan napad) i da ga forsiramo prvih 6–8 kola radi uigravanja. Promene uvodimo postepeno.");

          // Analyst – data focus
          pushSug("analyst","season","Fokus na analitiku protivnika",
            "Predlažem da pre svakog meča imamo kratak ‘3 tačke’ izveštaj: glavna pretnja, najslabija zona i preporučena korekcija. To smanjuje taktičke greške pod pritiskom.");
          pushSug("analyst","season","Kontrola izgubljenih lopti",
            "Predlažem cilj: -2 izgubljene lopte po meču u odnosu na prosek. To direktno smanjuje kontre protivnika i stabilizuje rezultat u egalu.");

          // Physio – prevention / recovery
          pushSug("physio","season","Plan prevencije povreda",
            "Predlažem nedeljni mini-protokol: mobilnost + stabilizacija + kontrola opterećenja. Tako smanjujemo kumulativni zamor i rizik povreda u zgusnutom rasporedu.");
          pushSug("physio","season","Protokol oporavka posle meča",
            "Predlažem standard: regeneracija u roku 12h, istezanje, hidratacija i individualne korekcije za igrače sa padom kondicije.");

          // Scout – youth / minutes / market
          pushSug("scout","season","Fokus na razvoj mladih",
            "Predlažem da 1–2 mlada igrača dobiju ciljanu minutažu u ‘sigurnim’ momentima. Tako dobijamo razvoj bez pada rezultata.");
          pushSug("scout","season","Plan skautiranja tržišta",
            "Predlažem listu 3 pozicije za praćenje (po budžetu): jedna hitna, jedna rotaciona i jedna perspektivna. Time smanjujemo rizik pogrešnog transfera.");

          // Fitness – training focus
          pushSug("fitness","season","Plan trening fokusa",
            "Predlažem ciklus: 2 nedelje baza (izdržljivost), 2 nedelje brzina/eksplozivnost, pa održavanje. Tako postižemo vrhunac forme u važnom delu sezone.");
          pushSug("fitness","season","Kontrola zamora i intenziteta",
            "Predlažem da posle svake 3 utakmice ubacimo rasterećenje (1 lakši dan). To čuva kondiciju i smanjuje pad učinka u završnicama.");

          // fill actives
          ["assist","analyst","physio","scout","fitness"].forEach(r=> fillActive(r));
          hub.sugg.seasonGenerated = tag;
        }

        function buildRotationSuggestion(){
          const players = getPlayersList();
          if(!players.length) return null;

          // candidates by rule
          const tired = players
            .map(p=>{
              const f = numFitness(p);
              const fr = numForm(p);
              const gir = gamesInRow(p);
              const ml3 = minutesLast3(p);
              const cond = (f>0?f:70);
              const form = (fr>0?fr:7.0);
              const trigger = (cond < 70) || (form < 6.5) || (gir >= 3);
              return { p, cond, form, gir, ml3, trigger };
            })
            .filter(x=>x.trigger);

          if(!tired.length) return null;

          tired.sort((a,b)=> (a.cond - b.cond) || (a.form - b.form));
          const out = tired.slice(0,2);

          function posOf(p){ return String(p.position || p.pos || p.poz || "").toUpperCase(); }
          function nmOf(p){ return String(p.name || p.ime || ""); }

          // pick replacements: same pos, better condition, not same player
          const usedOut = new Set(out.map(x=>pkPlayer(x.p)));
          const replacements = out.map(x=>{
            const pos = posOf(x.p);
            const cand = players
              .filter(p=> !usedOut.has(pkPlayer(p)) && posOf(p) === pos)
              .map(p=>({p, cond:(numFitness(p)||70), form:(numForm(p)||7.0)}))
              .sort((a,b)=> (b.cond - a.cond) || (b.form - a.form))[0];
            return cand ? cand.p : null;
          });

          const linesOut = out.map(x=>{
            const p = x.p;
            const pos = posOf(p) || "—";
            const reasons = [];
            if(x.cond < 70) reasons.push(`kondicija ${Math.round(x.cond)}%`);
            if(x.form < 6.5) reasons.push(`forma ${x.form.toFixed(1)}`);
            if(x.gir >= 3) reasons.push(`3 utakmice zaredom`);
            return `- ${nmOf(p)} (${pos}) — ${reasons.join(", ")}`;
          }).join("\n");

          const linesIn = replacements.map((p,i)=>{
            if(!p) return `- (nema idealne zamene za ${posOf(out[i].p)})`;
            return `- ${nmOf(p)} (${posOf(p)||"—"})`;
          }).join("\n");

          const text =
`Predlažem rotaciju:
${linesOut}

Umesto njih:
${linesIn}

Obrazloženje: rizik zamora i pad koncentracije rastu kada kondicija padne ispod 70% ili forma ispod 6.5. Rotacijom čuvamo intenzitet i stabilnost u završnici.`;

          return { title:"Rotacija zbog zamora", text };
        }

        // --- Match suggestions (generated when a match is recorded) ---
        function ensureMatchSuggestions(){
          const tok = state?.career?.lastMatchToken ?? state?.career?.lastMatch?.token ?? null;
          if(!tok) return;
          if(hub.sugg.lastMatchToken === tok) return;

          // Domain-limited match suggestions
          const rot = buildRotationSuggestion();
          if(rot) pushSug("assist","match", rot.title, rot.text);

          // Analyst match-type: lost balls / opponent shooter
          pushSug("analyst","match","Korekcija: izgubljene lopte",
            "Uočen je rast izgubljenih lopti pod pritiskom. Predlažem smanjenje rizika u pas-igri i više napada sa jasnim završetkom (bez forsiranja kroz sredinu).");

          // Physio match-type: recovery note
          pushSug("physio","match","Oporavak posle utakmice",
            "Predlažem regeneracioni protokol u narednih 12–24h za igrače sa padom kondicije, uz individualno rasterećenje na treningu.");

          // Fitness match-type: load adjust
          pushSug("fitness","match","Korekcija opterećenja",
            "Ako je zamor visok, predlažem smanjenje intenziteta sledećeg treninga i uvođenje kratkih sprinteva umesto duge serije ponavljanja.");

          // Scout match-type: if results poor -> market note (neutral)
          pushSug("scout","match","Praćenje pozicija za pojačanje",
            "Na osnovu trenutnih slabosti, predlažem da prioritetno pratimo igrače na 1–2 kritične pozicije u naredne 2–3 nedelje, pre nego što donesemo odluku.");

          ["assist","analyst","physio","scout","fitness"].forEach(r=> fillActive(r));
          hub.sugg.lastMatchToken = tok;
        }

        ensureSeasonSuggestions();
        ensureMatchSuggestions();

        // Suggestions visible for selected role
        const bucketSel = ensureRoleBucket(sel);
        const suggestions = bucketSel.active || [];

        // Staff morale (1–25) stored per club
        if(!hub.staffMorale) hub.staffMorale = {};
        if(!hub.staffStats) hub.staffStats = {};
        function initStaffMorale(roleKey, person){
          if(hub.staffMorale[roleKey] != null) return;
          const base = 14 + (seedFrom(staffName(person)+"|"+roleKey) % 7); // 14–20
          hub.staffMorale[roleKey] = clamp(base, 1, 25);
        }
        core.forEach(c=> initStaffMorale(c.key, c.person||{}));
        screen.innerHTML = `
          <div class="staffHub">
            <div class="staffLeft">
              <div class="staffHubTitle">
                <div class="big">${escapeHtml(club.name)} • Stručni štab</div>
                <div class="sub">Interaktivno • na težem nivou ignorisanje saveta ima posledice</div>
              </div>

              <div class="staffCards">
                ${core.map(c=>{
                  const s = c.person;
                  const nm = staffName(s);
                  const roleTxt = c.label;
                  const seed = seedFrom(nm+"|"+roleTxt);
                  const spec = pick(SPECS[c.key]||[], seed);
                  const weak = pick(WEAKS[c.key]||[], seedFrom("w|"+nm+"|"+roleTxt));
                  const active = (hub.selected===c.key) ? "active":"";
                  const flag = staffFlag(s);
                  const age = staffAge(s);
                  const wage = staffWage(s);
                  const con = staffContract(s);
                  const mval = hub.staffMorale?.[c.key];
                  const mArrow = moraleToArrow(mval);

                  return `
                    <div class="staffCard ${active}" data-role="${c.key}">
                      <div class="staffCardTop">
                        <div class="staffCardName">
                          <div class="nm">${escapeHtml(nm)}</div>
                          <div class="rl">${escapeHtml(roleTxt)} ${flag?`<span class="flag">${escapeHtml(flag)}</span>`:""}</div>
                        </div>
                        <div class="staffMini">
                          <div>${escapeHtml(String(age))} god</div>
                          <div>Ugovor: ${escapeHtml(String(con))}</div>
                          <div class="staffMorale ${mArrow.cls}">Moral: ${escapeHtml(mArrow.arrow)} ${escapeHtml(String(mval))}</div>
                        </div>
                      </div>
                      <div class="staffTraits">
                        <div class="trait"><span>⭐</span><b>${escapeHtml(spec||"—")}</b></div>
                        <div class="trait weak"><span>⚠</span><b>${escapeHtml(weak||"—")}</b></div>
                      </div>
                      <div class="staffCardBtns">
                        <button class="btnSm" data-talk="1">Razgovaraj</button>
                        <button class="btnSm ghost" data-open="1">Profil</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>

            <div class="staffRight">
              <div class="decisionPanel">
                <div class="panelTitle">
                  <span class="dot"></span>
                  <b>${escapeHtml(core.find(x=>x.key===sel)?.label || "Stručni štab")} kaže:</b>
                </div>
                <div class="panelBody">
                  <div class="miniNote">Svako daje savet samo u svom domenu. Prihvatanje/odbijanje utiče na <b>moral tog člana štaba</b> (ne na moral ekipe).</div>

                  <div class="sugList">
                    ${suggestions.length ? suggestions.map((sug)=>`
                      <div class="sugItem">
                        <div class="sugTitle">${escapeHtml(sug.title)}</div>
                        <div class="sugWhy">${escapeHtml(sug.text || sug.why || "")}</div>
                        <div class="sugBtns">
                          <button class="btnPrimary" data-accept-id="${escapeHtml(sug.id)}">Prihvati</button>
                          <button class="btnSecondary" data-ignore-id="${escapeHtml(sug.id)}">Ignoriši</button>
                        </div>
                      </div>
                    `).join("") : `<div class="miniNote">Izaberi člana štaba levo da dobiješ predloge.</div>`}
                  </div>

                  <div class="panelBtns">
                    <button class="btnSecondary" id="staffIgnore">Ignoriši sve</button>
                    <button class="btnSecondary ghost" id="staffDefer">Odloži</button>
                  </div>

                  ${hub.ignores>=3 ? `<div class="warn">⚠ Komunikacija sa štabom slabi (ignorisano: ${hub.ignores}x)</div>` : ``}
                </div>
              </div>


              <div class="impactPanel">
                <div class="panelTitle"><b>Moral stručnog štaba (live)</b></div>
                <div class="impactGrid">
                  <div class="impRow ${moraleToArrow(avgM).cls}"><span>Prosek morala štaba</span><b>${escapeHtml(moraleToArrow(avgM).arrow)} ${escapeHtml(String(avgM))}</b></div>
                  <div class="impRow ${comm>=70?'pos':(comm>=55?'neu':'neg')}"><span>Komunikacija</span><b>${escapeHtml(String(comm))}%</b></div>
                  ${core.map(c=>{
                    const mv = hub.staffMorale?.[c.key] ?? 0;
                    const ma = moraleToArrow(mv);
                    return `<div class="impRow ${ma.cls}"><span>${escapeHtml(c.label)} moral</span><b>${escapeHtml(ma.arrow)} ${escapeHtml(String(mv))}</b></div>`;
                  }).join("")}
                </div>
                <div class="miniNote">Prihvatanje saveta povećava moral tog člana. Ignorisanje smanjuje moral i komunikaciju. Ovo je oslonac na težem nivou.</div>
              </div>
            </div>
          </div>
        `;

        // Wire card clicks
        
        // ---- TALK PANEL (Razgovaraj) ----
        function __hmTalkData(roleKey){
          const roleLabel = (core.find(x=>x.key===roleKey)?.label) || roleKey;
          const person = (core.find(x=>x.key===roleKey)?.person) || {};
          const nm = staffName(person);
          const morale = hub.staffMorale?.[roleKey];
          const mArrow = moraleToArrow(morale);
          const domains = {assistant:"tactic", analyst:"analysis", scout:"scouting", physio:"medical", fitness:"conditioning"};
          const domain = domains[roleKey] || "other";
          const Q = {
            assist: [
              {id:"identity", q:"Kako da postavimo identitet igre u narednih 6 nedelja?",
               a:"Predlažem da zaključamo jedan primarni identitet i izbegnemo česte promene. Ako idemo na čvrstu 6–0, tražiću zatvaranje centralnog koridora i kontrolisan napad sa jasnim završnicama. Rotacije: 6–7 nosilaca + 4–5 rotacionih, da forma ne oscilira. Korekcije uvodimo tek kad uigranost postane stabilna.",
               effect:"Taktika: identitet (6 nedelja)"},
              {id:"risk", q:"Šta je najveći rizik u našoj postavi trenutno?",
               a:"Najveći rizik je preopterećenje iste osovine u ključnim minutima, što vodi padu koncentracije i greškama u povratku. Drugi rizik je neujednačena minutaža koja ruši disciplinu. Rešenje: jasna hijerarhija i pravilo zamena po pozicijama, posebno za bekove i krila.",
               effect:"Rotacije: smanjenje rizika (6 nedelja)"},
              {id:"rotation", q:"Kako da upravljamo rotacijom tokom gustog rasporeda?",
               a:"Rotiramo planski po pozicijama, ne ad hoc. Krila i bekovi nose najveći energetski trošak, zato njima uvodimo obavezne predaha cikluse. Cilj je da kondicija ostane iznad 75% pre završnica, uz minimalan pad uigranosti. U teškim sedmicama: kraće, kvalitetnije izmene.",
               effect:"Rotacije: široko/jezgro (6 nedelja)"}
            ],
            analyst: [
              {id:"kpi", q:"Koja su 3 ključna pokazatelja da dobijamo utakmice?",
               a:"Tri ključne metrike su: efikasnost šuta (posebno bekovi), broj tehničkih grešaka i učinak golmana. Ako greške smanjimo za 10–15% i držimo šut stabilnim, dobijamo i protiv jačih. Treći faktor je tranzicija — primljeni golovi iz kontre su najskuplji.",
               effect:"Analiza: KPI fokus (6 nedelja)"},
              {id:"prep", q:"Kako da se pripremimo za sledećeg protivnika?",
               a:"Identifikujem njihove obrasce: gde završavaju akcije (pivot/spoljašnji šut) i kako reaguju posle primljenog gola. Predlažem 2–3 ciljana podešavanja, ne revoluciju. Najbitnije: menjamo samo ono što donosi najveći efekat uz najmanji rizik.",
               effect:"Analiza: priprema meča (6 nedelja)"},
              {id:"turnovers", q:"Gde najviše gubimo posed?",
               a:"Najčešće u rizičnim dodavanjima na krilo bez pripreme i u forsiranju pivota bez stvaranja ugla. Predlog: pravilo ‘2 sigurna pasa pre rizika’ i jasne tačke ulaza. Druga stavka su pasovi u kretanju bez stabilne osnove — tu tražim korekciju tajminga.",
               effect:"Analiza: smanjenje grešaka (6 nedelja)"}
            ],
            scout: [
              {id:"need", q:"Da li nam treba gotov igrač ili talent?",
               a:"Ako jurimo rezultat odmah, treba nam stabilan igrač za 25–30 minuta bez pada. Ako gradimo, tražimo 19–22 sa jasnom specijalnošću (šut/duel/1 na 1) i prostorom za razvoj. Idealno je balans: jedan ‘siguran’, jedan ‘razvojni’.",
               effect:"Skauting: profil cilja (6 nedelja)"},
              {id:"critical", q:"Koje pozicije su nam najkritičnije?",
               a:"Kritične su pozicije gde nemamo drugu opciju istog nivoa: centralni bek (organizacija), pivot (dueli) i golman (stabilnost). Ako tu nemamo dubinu, sezona se lomi na umoru i povredama. Prioritet je obezbediti minimum 2 opcije po kritičnoj roli.",
               effect:"Skauting: prioritet pozicija (6 nedelja)"},
              {id:"profile", q:"Koji profil igrača da ciljamo?",
               a:"Ciljamo profil, ne ime: bek sa šutom iz bloka i dobrim povratkom, krilo sa završnicom iz teških uglova, pivot sa ‘screen’ kvalitetom. Ako ciljamo sve — promašimo. Ako ciljamo profil — dobijemo ono što timu realno fali.",
               effect:"Skauting: filter profila (6 nedelja)"}
            ],
            physio: [
              {id:"risk", q:"Ko je trenutno u najvećem riziku od povrede?",
               a:"Najveći rizik imaju igrači sa visokim minutima i naglim skokovima opterećenja, posebno bekovi i krila. Predlažem ‘crvenu zonu’: kad padne svežina ili poraste opterećenje, smanjujemo intenzitet i ubacujemo aktivni oporavak. To je najbrži put da smanjimo sitne povrede.",
               effect:"Medicina: rizik povreda (6 nedelja)"},
              {id:"return", q:"Da li da forsiramo brži povratak ili pun oporavak?",
               a:"Brži povratak daje kratkoročno, ali rizik recidiva raste. Za nosioce je pametniji pun oporavak uz postepenu minutažu. Za rotacione može ranije, ali uz limit. Predlažem standardni protokol da ne lutamo od slučaja do slučaja.",
               effect:"Medicina: protokol povratka (6 nedelja)"},
              {id:"prevention", q:"Kako da smanjimo sitne povrede tokom sezone?",
               a:"Mikro-umor je glavni uzrok. Rešenje je periodizacija: lakši dan posle utakmice, kontrola opterećenja i planirana rotacija. Plus disciplina u recovery rutini (hlađenje, mobilnost). Sa time se broj ‘sitnih’ povreda značajno spušta.",
               effect:"Medicina: prevencija (6 nedelja)"}
            ],
            fitness: [
              {id:"intensity", q:"Koji intenzitet treninga predlažeš narednih 6 nedelja?",
               a:"Ako je raspored gust, prejak intenzitet jede svežinu. Predlažem srednji intenzitet sa jasno definisanim blokovima: izdržljivost + kratki intervali brzine. Cilj je rast forme bez pada kondicije ispod praga za završnice.",
               effect:"Kondicija: intenzitet (6 nedelja)"},
              {id:"focus", q:"Na šta da stavimo fokus: snaga, brzina ili izdržljivost?",
               a:"Ako gubimo duele — snaga. Ako kasnimo u povratku — brzina. Ako padamo poslednjih 10 minuta — izdržljivost. Moj predlog je ciklus: 2 nedelje izdržljivost, 2 brzina, 2 stabilizacija, uz kontrolu umora.",
               effect:"Kondicija: fokus (6 nedelja)"},
              {id:"midseason", q:"Kako da izbegnemo pad forme sredinom sezone?",
               a:"Pad forme dolazi kad intenzitet ostane isti dok umor raste. Rešenje: periodizacija i planirane ‘deload’ nedelje — tada držimo taktički rad, a fizički smanjujemo. Tako održavamo svežinu i smanjujemo povrede.",
               effect:"Kondicija: periodizacija (6 nedelja)"}
            ]
          };
          const list = Q[roleKey] || [];
          return {roleKey, roleLabel, nm, morale, mArrow, domain, list};
        }

        function __hmOpenTalk(roleKey){
          try{
            const d = __hmTalkData(roleKey);
            let panel = document.getElementById("hmTalkPanel");
            if(!panel){
              panel = document.createElement("div");
              panel.id = "hmTalkPanel";
              panel.className = "hmTalkPanel";
              document.body.appendChild(panel);
            }
            const optHtml = d.list.map((it,i)=>`<option value="${escapeAttr(it.id)}"${i===0?" selected":""}>${escapeHtml(it.q)}</option>`).join("");
            panel.innerHTML = `
              <div class="hmTalkHdr">
                <div class="ttl">🗣 Razgovor: ${escapeHtml(d.roleLabel)}</div>
                <div class="sub">${escapeHtml(d.nm)} • Moral: ${escapeHtml(d.mArrow.arrow)} ${escapeHtml(String(d.morale??"—"))}</div>
              </div>
              <div class="hmTalkBody">
                <div class="hmTalkLbl">Izaberi pitanje (1):</div>
                <select class="hmTalkSelect" id="hmTalkQ">${optHtml}</select>
                <div class="hmTalkLbl">Stručni odgovor:</div>
                <div class="hmTalkAnswer" id="hmTalkA"></div>
                <div class="hmTalkMeta" id="hmTalkE"></div>
              </div>
              <div class="hmTalkBtns">
                <button class="btnSm ghost" id="hmTalkCancel">Otkaži</button>
                <button class="btnSm" id="hmTalkOk">Potvrdi</button>
              </div>
            `;
            function setTyping(on){
              const aEl = panel.querySelector("#hmTalkA");
              if(on){
                aEl.classList.add("typing");
                aEl.textContent = "…";
              } else {
                aEl.classList.remove("typing");
              }
            }
            function renderQAAnimated(initial=false){
              const qid = panel.querySelector("#hmTalkQ").value;
              const it = d.list.find(x=>x.id===qid) || d.list[0];
              const aEl = panel.querySelector("#hmTalkA");
              const eEl = panel.querySelector("#hmTalkE");
              if(initial){
                // Na otvaranju: prvo postavi pitanje, pa tek onda odgovor (kad korisnik izabere).
                aEl.textContent = "Izaberi pitanje iz menija iznad.";
                eEl.textContent = "";
                return;
              }
              // Animacija: kratko "kucanje" pa odgovor
              setTyping(true);
              eEl.textContent = "";
              const ans = it?.a || "";
              const eff = "Efekat (nevidljivo): " + (it?.effect || "—");
              window.clearTimeout(panel.__hmTalkTimer);
              panel.__hmTalkTimer = window.setTimeout(()=>{
                setTyping(false);
                aEl.textContent = ans;
                eEl.textContent = eff;
              }, 650);
            }
            renderQAAnimated(true);
            panel.querySelector("#hmTalkQ").addEventListener("change", ()=>renderQAAnimated(false));
            panel.querySelector("#hmTalkCancel").addEventListener("click", ()=>{
              panel.classList.remove("open");
            });
            panel.querySelector("#hmTalkOk").addEventListener("click", ()=>{
              try{
                const qid = panel.querySelector("#hmTalkQ").value;
                const it = d.list.find(x=>x.id===qid) || d.list[0];
                if(!state.teamContext) state.teamContext = {};
                if(!state.teamContext.bias) state.teamContext.bias = {};
                state.teamContext.bias[d.domain] = { role: d.roleKey, qid: it?.id, ts: Date.now(), durationDays: 42 };
              }catch(e){}
              panel.classList.remove("open");
            });
            panel.classList.add("open");
          }catch(e){}
        }

        const cards = screen.querySelectorAll(".staffCard");
        cards.forEach(card=>{
          const roleKey = card.getAttribute("data-role");
          card.addEventListener("click",(e)=>{
            const t = e.target;
            // buttons
            if(t && t.matches && t.matches('[data-open="1"]')){
              // open profile if available
              const idx = core.findIndex(c=>c.key===roleKey);
              const person = core[idx]?.person;
              if(person && typeof window.openStaffCard === "function"){
                // try to find this person index in rawStaff for existing viewer
                const ridx = rawStaff.indexOf(person);
                if(ridx>=0) window.openStaffCard("CAREER", ridx);
              } else {
                alert("Profil: " + (person?.name||"Nije postavljen"));
              }
              e.stopPropagation();
              return;
            }
            if(t && t.matches && t.matches('[data-talk="1"]')){
              __hmOpenTalk(roleKey);
              e.stopPropagation();
              return;
            }
            hub.selected = roleKey || "assist";
            // re-render just this route
            window.renderFMSkin(state, mountEl);
          });
        });


        // Accept / Ignore individual suggestion cards (per staff member)
        const acceptBtns = screen.querySelectorAll('[data-accept-id]');
        acceptBtns.forEach(btn=>{
          btn.addEventListener("click",()=>{
            const id = String(btn.getAttribute("data-accept-id")||"");
            const role = sel;

            if(!hub.staffStats[role]) hub.staffStats[role] = { accepts:0, ignores:0 };
            hub.staffStats[role].accepts++;

            // morale up for that staff member
            const cur = Number(hub.staffMorale?.[role]) || 14;
            hub.staffMorale[role] = clamp(cur + 1, 1, 25);


            // If suggestion contains a concrete tactical proposal: apply as NEXT (one-match override)
            try{
              ensureTacticsModel(club);
              const bucket = ensureRoleBucket(role);
              const sug = (bucket.active||[]).find(s=>String(s.id)===id) || (bucket.queue||[]).find(s=>String(s.id)===id) || null;
              if(sug){
                const blob = (`${sug.title||""} ${sug.text||""}`).toLowerCase();

                const patch = {};
                if(blob.includes("3-2-1")) patch.defense = "3-2-1";
                else if(blob.includes("5-1")) patch.defense = "5-1";
                else if(blob.includes("6-0") || blob.includes("6:0")) patch.defense = "6-0";

                if(blob.includes("dutch")) patch.defenseMode = "dutch";
                else if(blob.includes("ofanz") || blob.includes("offensive")) patch.defenseMode = "offensive";
                else if(patch.defense) patch.defenseMode = "standard";

                if(blob.includes("4 beka") || blob.includes("4-backs") || blob.includes("four backs")) patch.attack = "4-backs";
                else if((blob.includes("pivot") || blob.includes("piv") ) && (blob.includes("9m") || blob.includes("9 m") || blob.includes("devet"))) patch.attack = "pivot-screen";
                else if(blob.includes("iza prvog") || blob.includes("behind") || blob.includes("protiv 5-1")) patch.attack = "behind-front";

                if(blob.includes("brz") || blob.includes("tempo brzo")) patch.tempo = "fast";
                else if(blob.includes("spor") || blob.includes("tempo sporo")) patch.tempo = "slow";

                if(Object.keys(patch).length){
                  club.tacticsNext = { ...(club.tacticsBase||{}), ...(club.tacticsNext||{}), ...patch, _source:{ role, sugId:id, day: state.career?.day||0 } };
                }
              }
            }catch(e){}

            removeActive(role, id, "accepted");
            hub.last = { action:"accept", role, sugId:id, day: state.career?.day||0 };
            window.renderFMSkin(state, mountEl);
          });
        });

        const ignoreBtns = screen.querySelectorAll('[data-ignore-id]');
        ignoreBtns.forEach(btn=>{
          btn.addEventListener("click",()=>{
            const id = String(btn.getAttribute("data-ignore-id")||"");
            const role = sel;

            if(!hub.staffStats[role]) hub.staffStats[role] = { accepts:0, ignores:0 };
            hub.staffStats[role].ignores++;
            hub.ignores = (hub.ignores||0) + 1;

            // morale down for that staff member (slightly harsher if često ignorišeš)
            const cur = Number(hub.staffMorale?.[role]) || 14;
            const extra = (hub.ignores>=3) ? 1 : 0;
            hub.staffMorale[role] = clamp(cur - (1+extra), 1, 25);

            removeActive(role, id, "ignored");
            hub.last = { action:"ignore", role, sugId:id, day: state.career?.day||0 };
            window.renderFMSkin(state, mountEl);
          });
        });

        const btnI = screen.querySelector("#staffIgnore");
        const btnD = screen.querySelector("#staffDefer");
        if(btnI) btnI.addEventListener("click",()=>{
          const role = sel;
          const bucket = ensureRoleBucket(role);
          const ids = (bucket.active||[]).map(s=>s.id);
          ids.forEach(id=>{
            // apply per-suggestion ignore impact
            if(!hub.staffStats[role]) hub.staffStats[role] = { accepts:0, ignores:0 };
            hub.staffStats[role].ignores++;
            hub.ignores = (hub.ignores||0) + 1;
            const cur = Number(hub.staffMorale?.[role]) || 14;
            const extra = (hub.ignores>=3) ? 1 : 0;
            hub.staffMorale[role] = clamp(cur - (1+extra), 1, 25);
            removeActive(role, id, "ignored");
          });
          hub.last = { action:"ignore_all", role, day: state.career?.day||0 };
          window.renderFMSkin(state, mountEl);
        });
        if(btnD) btnD.addEventListener("click",()=>{
          hub.last = { action:"defer", role:sel, day: state.career?.day||0 };
          window.renderFMSkin(state, mountEl);
        });


	        return;
        }catch(e){
          console.error("StaffHub render error", e);
          screen.innerHTML = `
            <div class="tabCard">
              <div class="tabTitle">Stručni štab</div>
              <div class="miniNote">Greška pri prikazu stručnog štaba. Ovo je debug poruka da ne ostane prazan ekran.</div>
              <pre class="miniNote" style="white-space:pre-wrap;opacity:.9;margin-top:10px">${escapeHtml(String(e && (e.stack||e.message||e)))}</pre>
            </div>
          `;
          return;
        }
      }

      if(fm.route === "club.tactics"){
        title.textContent = "Taktika";

        // ensure model exists
        ensureTacticsModel(club);
        fm.tacticsUI = fm.tacticsUI || { editTarget: "base", subTab: "def" };
        fm.tacticsUI.subTab = fm.tacticsUI.subTab || "def";
        const subTab = fm.tacticsUI.subTab;
        const editTarget = fm.tacticsUI.editTarget || "base";

        const base = club.tacticsBase || {};
        const next = (club.tacticsNext && typeof club.tacticsNext === "object") ? club.tacticsNext : null;
        const active = getActiveTactics(club);

        // --- Lineup slots -> names on tactics pitch ---
        const squadForTactics = (club.players || club.squad || []);
        const lineupAssign = (fm.lineup && fm.lineup.assign) ? fm.lineup.assign : {};
        function pkPlayerT(p){
          if(!p) return "";
          return String(p.id ?? p.pid ?? p.playerId ?? p._id ?? `${p.name||p.ime||""}|${p.position||p.pos||p.poz||""}|${p.age||p.godine||""}`);
        }
        function playerFullName(p){
          if(!p) return "";
          const direct = String(p.name || p.imePrezime || p.fullName || "").trim();
          if(direct) return direct;
          const first = String(p.firstName || p.ime || "").trim();
          const last = String(p.lastName || p.prezime || "").trim();
          return `${first} ${last}`.trim();
        }
        function slotPlayerName(slot){
          const pk = lineupAssign ? lineupAssign[slot] : null;
          if(!pk) return "";
          const found = Array.isArray(squadForTactics) ? squadForTactics.find(p => pkPlayerT(p) === String(pk)) : null;
          return playerFullName(found);
        }
        const tacPlayerName = {
          GK: slotPlayerName("GK"),
          LW: slotPlayerName("LW"),
          LB: slotPlayerName("LB"),
          CB: slotPlayerName("CB"),
          RB: slotPlayerName("RB"),
          RW: slotPlayerName("RW"),
          PIV: slotPlayerName("PIV"),
        };

        function optSel(v, cur){ return String(v)===String(cur) ? 'selected' : ''; }
        const badgeNext = next ? `<span class="tagMini" style="margin-left:8px; background:rgba(255,210,120,.16); border-color:rgba(255,210,120,.28)">Sledeći meč: AKTIVNO</span>` : `<span class="tagMini" style="margin-left:8px; opacity:.75">Sledeći meč: nema</span>`;

        // NOTE: We render ONE tactics page and then (depending on subTab)
        // replace the main content area. This prevents the pitch from appearing
        // on the Ofanzivna tab while keeping the FM UI stable.

screen.innerHTML = `
          <div class="tableTitleRow">
            <div>
              <div style="font-weight:1000">Taktika • ${escapeHtml(club.name)}</div>
              <div class="sub">Sezonska taktika (BASE) + plan za sledeći meč (OVERRIDE iz stručnog štaba)</div>
            </div>
            ${badgeNext}
          </div>

          <div class="subTabs" id="tacticsSubTabs">
            <button class="subTabBtn ${subTab==='off'?'active':''}" data-subtab="off">Ofanzivna</button>
            <button class="subTabBtn ${subTab==='def'?'active':''}" data-subtab="def">Defanzivna</button>
            <button class="subTabBtn ${subTab==='pitch'?'active':''}" data-subtab="pitch">Teren</button>
          </div>

          <div class="panel" style="padding:8px; margin-top:10px">
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
              <button class="topBtn" id="tacEditBase" type="button" style="padding:8px 10px; ${editTarget==='base'?'border-color:rgba(180,210,255,.55)':''}">Sezonska taktika</button>
              <button class="topBtn" id="tacEditNext" type="button" style="padding:8px 10px; ${editTarget==='next'?'border-color:rgba(255,210,120,.55)':''}">Sledeći meč</button>
              <div style="margin-left:auto; font-size:12px; opacity:.8">
                Aktivno u engine-u: <b>${escapeHtml(String(active.defense||"—"))}</b> / <b>${escapeHtml(String(active.attack||"—"))}</b> / <b>${escapeHtml(String(active.tempo||"—"))}</b>
              </div>
          <div id="tacTabs" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px">
<div style="margin-left:auto; font-size:12px; opacity:.75">Sve u ovoj sekciji utiče na match engine.</div>
          </div>

          <div id="tacTabRoles" style="margin-top:10px">
            <div style="display:grid; grid-template-columns: 1.05fr .75fr .95fr; gap:10px">
              <div class="panel" style="padding:12px">
                <div style="font-weight:950; margin-bottom:8px">Teren (FM stil)</div>
                <div class="miniNote" style="margin:0 0 10px 0; opacity:.85">Klikni poziciju na terenu da izabereš ulogu. Uloga utiče na engine (šut, prodor, asistencije, screen…).</div>

                <div class="fm-pitch tacPitch" id="tacPitch">

                  <svg class="pitch-svg" viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true">
                    <rect x="2" y="2" width="196" height="96" rx="10" ry="10" class="p-outline"/>
                    <rect x="90" y="2" width="20" height="5" class="p-goal"/>
                    <line x1="2" y1="8" x2="198" y2="8" class="p-line"/>
                    <path d="M 62 8 A 38 38 0 0 1 138 8" class="p-line"/>
                    <path d="M 43 8 A 57 57 0 0 1 157 8" class="p-dash"/>
                    <line x1="97" y1="29.3" x2="103" y2="29.3" class="p-line"/>
                    <line x1="96" y1="45.3" x2="104" y2="45.3" class="p-line"/>
                    <line x1="2" y1="98" x2="198" y2="98" class="p-line p-faint"/>
                    <circle cx="100" cy="98" r="1.4" class="p-dot"/>
                  </svg>
                  <div class="pitch-layer">
<button class="tacNode" data-pos="GK" style="--x:50%; --y:24%">
                    <div class="tacPos">GK</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).GK)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.GK ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.GK || "—")}</div>
                  </button>

                  <button class="tacNode" data-pos="LW" style="--x:10%; --y:64%">
                    <div class="tacPos">LW</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).LW)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.LW ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.LW || "—")}</div>
                  </button>
                  <button class="tacNode" data-pos="LB" style="--x:28%; --y:52%">
                    <div class="tacPos">LB</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).LB)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.LB ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.LB || "—")}</div>
                  </button>
                  <button class="tacNode" data-pos="CB" style="--x:50%; --y:48%">
                    <div class="tacPos">CB</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).CB)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.CB ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.CB || "—")}</div>
                  </button>
                  <button class="tacNode" data-pos="RB" style="--x:72%; --y:52%">
                    <div class="tacPos">RB</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).RB)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.RB ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.RB || "—")}</div>
                  </button>
                  <button class="tacNode" data-pos="RW" style="--x:90%; --y:64%">
                    <div class="tacPos">RW</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).RW)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.RW ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.RW || "—")}</div>
                  </button>

                  <button class="tacNode" data-pos="PIV" style="--x:50%; --y:62%">
                    <div class="tacPos">PIV</div>
                    <div class="tacRole">${escapeHtml(String(((active.roles||{}).PIV)||"—"))}</div>
                    <div class="tacPlayer ${(tacPlayerName.PIV ? "" : "tacEmpty")}">${escapeHtml(tacPlayerName.PIV || "—")}</div>
                  </button>
                  </div>
                </div>

                <div class="miniNote" style="margin-top:10px; opacity:.8">
                  <b>Napomena:</b> Ako uređuješ “Sledeći meč”, uloge važe samo za narednu utakmicu (posle meča se brišu).
                </div>
              </div>

              <div class="panel" style="padding:12px">
                <div style="font-weight:950; margin-bottom:8px">Uloga pozicije</div>
                <div class="miniNote" style="margin:0 0 10px 0; opacity:.85">Izaberi jednu od 3 uloge. Objašnjenja su na srpskom.</div>

                <div id="tacRoleEditor" class="tableWrap" style="padding:10px; border-radius:14px">
                  <div style="opacity:.8">Klikni poziciju na terenu.</div>
                </div>

                <div style="margin-top:10px">
                  <button class="topBtn" id="tacRoleReset" type="button" style="padding:8px 10px">Vrati podrazumevane uloge</button>
                </div>
              </div>
              <div class="panel" style="padding:12px">
                <div style="font-weight:950; margin-bottom:8px">Timska taktika</div>
                <div class="miniNote" style="margin:0 0 10px 0; opacity:.85">Ovo su timska podešavanja koja direktno utiču na match engine (tempo, izbor odbrane/napada, tranzicija).</div>
                <div class="panel" style="padding:10px; margin:0 0 10px 0; border-radius:14px; background: rgba(255,255,255,.03)">
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px">
                    <div style="font-weight:900">Taktički identitet</div>
                    <div class="miniNote" style="margin:0; opacity:.85">Pregled šta će engine “forsirati”.</div>
                  </div>
                  <div class="idGrid" style="display:grid; grid-template-columns:1fr 1fr; gap:10px">
                    <div>
                      <div class="miniNote" style="margin:0 0 6px 0">Tempo</div>
                      <div class="bar"><div class="fill" id="tacIdTempo" style="width:50%"></div></div>
                    </div>
                    <div>
                      <div class="miniNote" style="margin:0 0 6px 0">Rizik</div>
                      <div class="bar"><div class="fill" id="tacIdRisk" style="width:50%"></div></div>
                    </div>
                    <div>
                      <div class="miniNote" style="margin:0 0 6px 0">Agresija</div>
                      <div class="bar"><div class="fill" id="tacIdAgg" style="width:50%"></div></div>
                    </div>
                    <div>
                      <div class="miniNote" style="margin:0 0 6px 0">Stabilnost</div>
                      <div class="bar"><div class="fill" id="tacIdStab" style="width:50%"></div></div>
                    </div>
                  </div>
                </div>


                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px">
                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0">Odbrana</div>
                    <select class="topSelect" id="tacDefense">
                      <option value="6-0">6-0</option>
                      <option value="5-1">5-1</option>
                      <option value="3-2-1">3-2-1</option>
                    </select>
                    <div class="miniNote" style="margin:8px 0 6px 0">Mod odbrane</div>
                    <select class="topSelect" id="tacDefenseMode">
                      <option value="standard">Standard</option>
                      <option value="offensive">Ofanzivna 6-0</option>
                      <option value="dutch">Dutch 6-0</option>
                    </select>
                  </div>

                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0">Napad</div>
                    <select class="topSelect" id="tacAttack">
                      <option value="balanced">Balanced</option>
                      <option value="4-backs">4 beka</option>
                      <option value="pivot-screen">Pivot pomoć (9m)</option>
                      <option value="fast-switch">Fast switch</option>
                      <option value="behind-front">Iza prvog (vs 5-1)</option>
                    </select>

                    <div class="miniNote" style="margin:8px 0 6px 0">Tempo</div>
                    <select class="topSelect" id="tacTempo">
                      <option value="slow">Sporo</option>
                      <option value="normal">Normalno</option>
                      <option value="fast">Brzo</option>
                    </select>
                  </div>
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:12px">
                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="Levo: skoro nikad ne igramo na pivota. Desno: često tražimo pivota (screen/6m), više faulova i 7m, ali i više kontakta.">Pivot fokus (0–100): <b id="tacPivotVal">50</b></div>
                    <input class="range" id="tacPivotFocus" type="range" min="0" max="100" step="1" value="50">
                  </div>
                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="Levo: mirniji napad. Desno: više križanja/rotacija – više otvaranja, ali i više rizika (greške).">Križanja (0–100): <b id="tacCrossVal">55</b></div>
                    <input class="range" id="tacCrossFreq" type="range" min="0" max="100" step="1" value="55">
                  </div>

                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="1: pasivnije i sigurnije. 5: više presinga/izlazaka – više ukradenih i kontri, ali i više 2 minuta.">Agresivnost (1–5): <b id="tacAggVal">3</b></div>
                    <input class="range" id="tacAgg" type="range" min="1" max="5" step="1" value="3">
                  </div>
                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="1: šire (čuva krila). 5: zbijeno (zatvara sredinu) – protivnik dobija više šuteva sa krila.">Kompaktnost (1–5): <b id="tacCompVal">3</b></div>
                    <input class="range" id="tacComp" type="range" min="1" max="5" step="1" value="3">
                  </div>

                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="1: kontrola, manje trčanja. 5: forsira kontru – više lakih golova, ali i veći rizik povratka.">Kontra intenzitet (1–5): <b id="tacFBVal">3</b></div>
                    <input class="range" id="tacFB" type="range" min="1" max="5" step="1" value="3">
                  </div>
                  <div>
                    <div class="miniNote" style="margin:0 0 6px 0" title="1: spor povratak (više primljenih kontri). 5: prioritet povratak (stabilnije, ali manje 'all-in').">Povratak (1–5): <b id="tacRecVal">3</b></div>
                    <input class="range" id="tacRec" type="range" min="1" max="5" step="1" value="3">
                  </div>
                </div>

                <div style="display:flex; gap:8px; align-items:center; margin-top:12px; flex-wrap:wrap">
                  <button class="topBtn" id="tacSave" type="button">Sačuvaj ${editTarget==='next' ? 'plan za sledeći meč' : 'sezonsku taktiku'}</button>
                  ${editTarget==='next' ? `<button class="topBtn" id="tacResetNext" type="button">Resetuj sledeći meč</button>` : ``}
                </div>

                <div class="miniNote" style="margin-top:10px; opacity:.78">
                  <b>Tip:</b> Ako prihvatiš predlog stručnog štaba, ovde ćeš odmah videti promenu (Sledeći meč) – ali samo ako klikneš <b>Prihvati</b>.
                </div>
              </div>

            </div>

          </div>

          <div id="tacTabSettings" style="display:none">
            <div class="panel" style="padding:12px">
              <div style="font-weight:950; margin-bottom:8px">Podešavanja (detaljno)</div>
              <div class="miniNote" style="margin:0; opacity:.85">Za sada su timska podešavanja u kartici “Formacija & uloge” (desno). Ovde ćemo kasnije dodati napredne instrukcije (zona presinga, fokus šuta, rotacije…).</div>
            </div>
          </div>
            <div style="margin-top:10px; font-size:12px; opacity:.8; line-height:1.35">
              <b>Važno:</b> Promene u “Sledeći meč” važe samo za narednu utakmicu (posle meča se brišu). Predlozi stručnog štaba menjaju taktički panel <u>samo ako klikneš Prihvati</u>.
            </div>
          </div>

          
          <div style="margin-top:10px">
            <div class="panel" style="padding:12px">
                          <div style="font-weight:950; margin-bottom:8px">Pregled</div>
                          <div style="font-size:12px; opacity:.85; line-height:1.45">
                            <div><b>BASE:</b> ${escapeHtml(String(base.defense||"—"))} / ${escapeHtml(String(base.attack||"—"))} / ${escapeHtml(String(base.tempo||"—"))}</div>
                            <div style="margin-top:6px"><b>Sledeći meč:</b> ${next ? `${escapeHtml(String(next.defense||"—"))} / ${escapeHtml(String(next.attack||"—"))} / ${escapeHtml(String(next.tempo||"—"))}` : "—"}</div>
                          </div>
                          <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.10)">
                            <div style="font-weight:900; margin-bottom:6px">Mišljenje asistenta</div>
                            <div id="tacAssistantSummary" style="font-size:12px; opacity:.9; line-height:1.45"></div>
                          </div>
                        </div>
          </div>
</div>
        </div>

      </div>
    `;

        // Sub-tabovi u taktici (Ofanzivna / Defanzivna)
        const subTabsEl = screen.querySelector('#tacticsSubTabs');
        if(subTabsEl && !subTabsEl._hmBound){
          subTabsEl._hmBound = true;
          subTabsEl.querySelectorAll('[data-subtab]').forEach(btn=>{
            btn.onclick = ()=>{
              fm.tacticsUI.subTab = btn.getAttribute('data-subtab') || 'def';
              renderScreen();
            };
          });
        }

        // ===============================
        // OFANZIVA TAB = ONLY SETTINGS (NO PITCH)
        // Single source of truth: window.gameState.tactics.offense
        // Updates must immediately re-render (via window.updateOffenseSetting)
        // ===============================
        if(subTab === 'off'){
          const o = (window.gameState && window.gameState.tactics && window.gameState.tactics.offense) ? window.gameState.tactics.offense : { focus:'balanced', tempo:5, passRisk:5, width:5, pressAfterGoal:false };
          const rolesRoot = screen.querySelector('#tacTabRoles');
          if(rolesRoot){
            rolesRoot.style.marginTop = '10px';
            rolesRoot.innerHTML = `
              <div class="panel" style="padding:12px">
                <div style="font-weight:950; margin-bottom:8px">Ofanzivna taktika</div>
                <div class="miniNote" style="margin:0 0 12px 0; opacity:.85">
                  Ova kartica je <b>samo podešavanje</b>. Promene ovde su jedini source of truth i odmah utiču na <b>Teren</b> (crvene kuglice) i <b>match engine</b>.
                </div>

                <div class="panel" style="padding:12px; border-radius:14px; background:rgba(255,255,255,.03); max-height: 62vh; overflow:auto">

                  <div style="font-weight:900; margin-bottom:10px">Završnica i ritam</div>

                  <div class="formRow">
                    <label>Fokus završnice</label>
                    <div class="seg">
                      <button class="segBtn ${(String(o.focus||'balanced')==='balanced')?'on':''}" data-offkey="focus" data-offval="balanced">Balanced</button>
                      <button class="segBtn ${(String(o.focus||'balanced')==='pivot')?'on':''}" data-offkey="focus" data-offval="pivot">Pivot</button>
                      <button class="segBtn ${(String(o.focus||'balanced')==='wings')?'on':''}" data-offkey="focus" data-offval="wings">Krila</button>
                      <button class="segBtn ${(String(o.focus||'balanced')==='backcourt')?'on':''}" data-offkey="focus" data-offval="backcourt">9m</button>
                    </div>
                  </div>

                  <div class="formRow">
                    <label>Tempo (1–10)</label>
                    <input type="range" min="1" max="10" step="1" value="${Number(o.tempo ?? 5)}" data-offkey="tempo" data-offtype="range">
                    <div class="sub" data-offread="tempo">${Number(o.tempo ?? 5)}</div>
                  </div>

                  <div class="formRow">
                    <label>Rizik pasa (1–10)</label>
                    <input type="range" min="1" max="10" step="1" value="${Number(o.passRisk ?? 5)}" data-offkey="passRisk" data-offtype="range">
                    <div class="sub" data-offread="passRisk">${Number(o.passRisk ?? 5)}</div>
                  </div>

                  <div class="formRow">
                    <label>Širina (1–10)</label>
                    <input type="range" min="1" max="10" step="1" value="${Number(o.width ?? 5)}" data-offkey="width" data-offtype="range">
                    <div class="sub" data-offread="width">${Number(o.width ?? 5)}</div>
                  </div>

                  <div class="formRow">
                    <label>Strpljenje u napadu (1–10)</label>
                    <input type="range" min="1" max="10" step="1" value="${Number(o.patience ?? 6)}" data-offkey="patience" data-offtype="range">
                    <div class="sub" data-offread="patience">${Number(o.patience ?? 6)}</div>
                  </div>

                  <div style="height:10px"></div>
                  <div style="font-weight:900; margin:6px 0 10px 0">Preferencije završnice (0–100)</div>

                  <div class="formRow">
                    <label title="Koliko često tražimo pivota (screen/6m).">Pivot uključenost</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.pivotBias ?? 55)}" data-offkey="pivotBias" data-offtype="range">
                    <div class="sub" data-offread="pivotBias">${Number(o.pivotBias ?? 55)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Koliko često forsiramo krila (brza realizacija, ugao).">Krila uključenost</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.wingBias ?? 50)}" data-offkey="wingBias" data-offtype="range">
                    <div class="sub" data-offread="wingBias">${Number(o.wingBias ?? 50)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Koliko često dopuštamo šuteve spolja (9m).">9m šut (bekovi)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.backcourtBias ?? 55)}" data-offkey="backcourtBias" data-offtype="range">
                    <div class="sub" data-offread="backcourtBias">${Number(o.backcourtBias ?? 55)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Češće ulazimo 1-na-1 u sredini/na beku.">Prodori (1-na-1)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.dribbleBias ?? 45)}" data-offkey="dribbleBias" data-offtype="range">
                    <div class="sub" data-offread="dribbleBias">${Number(o.dribbleBias ?? 45)}</div>
                  </div>

                  <div style="height:10px"></div>
                  <div style="font-weight:900; margin:6px 0 10px 0">Kretanje i kombinacije</div>

                  <div class="formRow">
                    <label title="Više ukrštanja/rotacija → više otvaranja, ali i više grešaka.">Ukrštanja (0–100)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.crossFreq ?? 55)}" data-offkey="crossFreq" data-offtype="range">
                    <div class="sub" data-offread="crossFreq">${Number(o.crossFreq ?? 55)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Pivot češće postavlja screen na 9m/6m.">Screen upotreba (0–100)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.screenUse ?? 60)}" data-offkey="screenUse" data-offtype="range">
                    <div class="sub" data-offread="screenUse">${Number(o.screenUse ?? 60)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Učestalost ulaska drugog pivota/2PV momenata.">Drugi pivot (0–100)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.secondPivot ?? 25)}" data-offkey="secondPivot" data-offtype="range">
                    <div class="sub" data-offread="secondPivot">${Number(o.secondPivot ?? 25)}</div>
                  </div>

                  <div class="formRow">
                    <label title="Koliko često igramo brzu tranziciju u napad iz postavljenog.">Brzi nastavak (0–100)</label>
                    <input type="range" min="0" max="100" step="1" value="${Number(o.quickRestart ?? 40)}" data-offkey="quickRestart" data-offtype="range">
                    <div class="sub" data-offread="quickRestart">${Number(o.quickRestart ?? 40)}</div>
                  </div>

                  <div style="height:10px"></div>
                  <div style="font-weight:900; margin:6px 0 10px 0">Dodatno</div>

                  <div class="formRow" style="align-items:center">
                    <label>Presing posle gola</label>
                    <input type="checkbox" ${(!!o.pressAfterGoal) ? 'checked' : ''} data-offkey="pressAfterGoal" data-offtype="check">
                  </div>

                  <div class="formRow" style="align-items:center">
                    <label title="Ako je uključeno, tim će češće ići na 7v6 (napadački all-in).">Češće 7v6</label>
                    <input type="checkbox" ${(!!o.use7v6) ? 'checked' : ''} data-offkey="use7v6" data-offtype="check">
                  </div>

                  <div class="formRow">
                    <label>Varijacije akcija (1–10)</label>
                    <input type="range" min="1" max="10" step="1" value="${Number(o.variation ?? 6)}" data-offkey="variation" data-offtype="range">
                    <div class="sub" data-offread="variation">${Number(o.variation ?? 6)}</div>
                  </div>

                  <div class="miniNote" style="margin-top:12px; opacity:.85">
                    <b>Tip:</b> idi na karticu <b>Teren</b> da odmah vidiš kako se crvene kuglice pomeraju dok menjaš ove parametre.
                  </div>
                </div>
              </div>
            `;

            // bind offense setters (NO local state)
            rolesRoot.querySelectorAll('[data-offkey="focus"][data-offval]').forEach(btn=>{
              btn.addEventListener('click', ()=>{
                const v = btn.getAttribute('data-offval');
                if(window.updateOffenseSetting) window.updateOffenseSetting('focus', v);
              });
            });
            rolesRoot.querySelectorAll('input[data-offkey][data-offtype="range"]').forEach(inp=>{
              const syncRead = ()=>{
                const k = inp.getAttribute('data-offkey');
                const read = rolesRoot.querySelector(`[data-offread="${k}"]`);
                if(read) read.textContent = String(inp.value);
              };
              inp.addEventListener('input', ()=>{
                syncRead();
                const k = inp.getAttribute('data-offkey');
                const v = Number(inp.value);
                if(window.updateOffenseSetting) window.updateOffenseSetting(k, v);
              });
              inp.addEventListener('change', ()=>{
                syncRead();
                const k = inp.getAttribute('data-offkey');
                const v = Number(inp.value);
                if(window.updateOffenseSetting) window.updateOffenseSetting(k, v);
              });
              syncRead();
            });
            rolesRoot.querySelectorAll('input[data-offkey][data-offtype="check"]').forEach(ch=>{
              ch.addEventListener('change', ()=>{
                const k = ch.getAttribute('data-offkey');
                const v = !!ch.checked;
                if(window.updateOffenseSetting) window.updateOffenseSetting(k, v);
              });
            });

            // Hide other tactic panels on this tab (Ofanziva must be settings-only)
            const tabsRow = screen.querySelector('#tacTabs');
            if(tabsRow) tabsRow.style.display = 'none';
            const note = Array.from(screen.querySelectorAll('div')).find(d=> (d.textContent||'').includes('Važno: Promene u “Sledeći meč”'));
            if(note) note.style.display = 'none';
            const summary = screen.querySelector('#tacAssistantSummary');
            if(summary){
              const p = summary.closest('.panel');
              if(p) p.style.display = 'none';
              const wrap = p ? p.parentElement : null;
              if(wrap && wrap.style) wrap.style.display = 'none';
            }
          }
        }


        function targetObj(){
          return (fm.tacticsUI.editTarget === "next") ? (club.tacticsNext && typeof club.tacticsNext === "object" ? club.tacticsNext : (club.tacticsNext = { ...club.tacticsBase })) : club.tacticsBase;
        }
        function loadToUI(src){
          const d = screen.querySelector("#tacDefense");
          const dm = screen.querySelector("#tacDefenseMode");
          const a = screen.querySelector("#tacAttack");
          const tp = screen.querySelector("#tacTempo");

          const pf = screen.querySelector("#tacPivotFocus");
          const cf = screen.querySelector("#tacCrossFreq");
          const ag = screen.querySelector("#tacAgg");
          const co = screen.querySelector("#tacComp");
          const fb = screen.querySelector("#tacFB");
          const rc = screen.querySelector("#tacRec");

          if(d) d.value = String(src.defense ?? "6-0");
          if(dm) dm.value = String(src.defenseMode ?? "standard");
          if(a) a.value = String(src.attack ?? "balanced");
          if(tp) tp.value = String(src.tempo ?? "normal");

          if(pf) pf.value = String(src.pivotFocus ?? 50);
          if(cf) cf.value = String(src.crossFrequency ?? 55);
          if(ag) ag.value = String(src.aggression ?? 3);
          if(co) co.value = String(src.compactness ?? 3);
          if(fb) fb.value = String(src.fastBreakIntensity ?? 3);
          if(rc) rc.value = String(src.defensiveRecovery ?? 3);

          const setTxt = (id, val)=>{ const el = screen.querySelector(id); if(el) el.textContent = String(val); };
          setTxt("#tacPivotVal", pf?pf.value:50);
          setTxt("#tacCrossVal", cf?cf.value:55);
          setTxt("#tacAggVal", ag?ag.value:3);
          setTxt("#tacCompVal", co?co.value:3);
          setTxt("#tacFBVal", fb?fb.value:3);
          setTxt("#tacRecVal", rc?rc.value:3);
          updateIdentityUI(src);
        }


        function updateIdentityUI(src){
          const tempo = String(src.tempo ?? "normal");
          const cross = Number(src.crossFrequency ?? 55);
          const aggr = Number(src.aggression ?? 3);
          const fb = Number(src.fastBreakIntensity ?? 3);
          const rec = Number(src.defensiveRecovery ?? 3);
          const comp = Number(src.compactness ?? 3);

          const tempoPct = (tempo==="slow") ? 35 : (tempo==="fast" ? 80 : 55);

          const riskScore = Math.max(0, Math.min(1,
            (cross/100)*0.45 +
            (tempo==="fast" ? 0.20 : tempo==="slow" ? -0.05 : 0.10) +
            ((aggr-1)/4)*0.20 +
            ((fb-1)/4)*0.20
          ));
          const riskPct = 25 + riskScore*70;

          const agPct = 20 + ((aggr-1)/4)*70;

          const stabScore = Math.max(0, Math.min(1,
            ((rec-1)/4)*0.55 +
            ((comp-1)/4)*0.20 +
            (1-riskScore)*0.25
          ));
          const stabPct = 25 + stabScore*70;

          const setW = (id, pct)=>{
            const el = screen.querySelector(id);
            if(el) el.style.width = Math.max(6, Math.min(100, pct)) + "%";
          };
          setW("#tacIdTempo", tempoPct);
          setW("#tacIdRisk", riskPct);
          setW("#tacIdAgg", agPct);
          setW("#tacIdStab", stabPct);

          // --- Asistent: sveobuhvatno mišljenje o celoj taktici ---
          const sumEl = screen.querySelector("#tacAssistantSummary");
          if(sumEl){
            const d = String(src.defense ?? "6-0");
            const dm = String(src.defenseMode ?? "standard");
            const a = String(src.attack ?? "balanced");

            const lbl = {
              tempo: { slow:"sporo", normal:"normalno", fast:"brzo" },
              defenseMode: { standard:"standard", offensive:"ofanzivna", dutch:"dutch" },
              attack: {
                "balanced":"uravnotežen napad",
                "4-backs":"napad sa 4 beka (više 9m i 1-na-1)",
                "pivot-screen":"napad kroz pivota (screen/9m pomoć)",
                "fast-switch":"brzo prebacivanje strane (fast switch)",
                "behind-front":"napad iza isturenog (vs 5-1)"
              }
            };

            const riskWord = riskScore < 0.40 ? "nizak" : (riskScore < 0.62 ? "umeren" : "visok");
            const stabWord = stabScore < 0.40 ? "nestabilniji" : (stabScore < 0.62 ? "stabilan" : "vrlo stabilan");
            const agWord = aggr <= 2 ? "kontrolisana" : (aggr === 3 ? "balansirana" : "vrlo agresivna");
            const compWord = comp <= 2 ? "šira" : (comp === 3 ? "srednje zbijena" : "zbijena");
            const fbWord = fb <= 2 ? "selektivna" : (fb === 3 ? "balansirana" : "izražena");

            const pivot = Math.max(0, Math.min(100, Number(src.pivotFocus ?? 50)));
            const crossClamped = Math.max(0, Math.min(100, Number(src.crossFrequency ?? 55)));

            // Preporuke/arhetipovi (kratko, ali sveobuhvatno)
            let rosterHint = "";
            if(d === "3-2-1" || d === "5-1" || dm === "offensive"){
              rosterHint = "Tražiš brze i pokretne braniče (izlasci, povratak) i golmana koji čita igru.";
            } else {
              rosterHint = "Ovo najbolje leži ekipama sa čvrstom 6-0 bazom i dobrim kontaktom na 6m.";
            }
            if(a === "pivot-screen" || pivot >= 60) rosterHint += " U napadu posebno vrednuješ jakog pivota (screen, iznuđeni faulovi/7m).";
            if(a === "4-backs" || (tempo === "fast" && crossClamped >= 65)) rosterHint += " Potrebni su pouzdani bekovi sa dobrim donošenjem odluka (da rizik ne ode u greške).";

            // Glavni rizici (jedna rečenica)
            let riskHint = "";
            if(riskScore >= 0.62) riskHint = "Glavni rizik su tehničke greške i kazne (2 min) ako ritam ode u " + (tempo === "fast" ? "prebrzo" : "previše rizično") + ".";
            else if(stabScore <= 0.40) riskHint = "Glavni rizik je kasni povratak i lom ritma (primljene kontre) ako izgubiš posed.";
            else riskHint = "Rizik je pod kontrolom – fokus je na kontinuitetu i disciplini.";

            const tLabel = lbl.tempo[tempo] || tempo;
            const dmLabel = lbl.defenseMode[dm] || dm;
            const aLabel = lbl.attack[a] || a;

            // Jedinstven, sveobuhvatan sažetak cele taktike (ne po stavkama, već kao celina)
            const html = `
              Postavio si <b>${escapeHtml(d)}</b> (${escapeHtml(dmLabel)}) kao odbrambenu bazu i <b>${escapeHtml(aLabel)}</b> u napadu, uz <b>${escapeHtml(tLabel)}</b> tempo. Identitet je <b>${escapeHtml(stabWord)}</b> uz <b>${escapeHtml(riskWord)}</b> rizik: napad ide ka ${pivot >= 60 ? "pivotskoj saradnji i kontaktu" : pivot <= 40 ? "širini i bekovskim rešenjima" : "balansu pivota i bekova"}, a sa križanjima na <b>${escapeHtml(String(crossClamped))}</b>/100 dobijaš ${crossClamped >= 65 ? "više otvaranja, ali veću varijansu" : crossClamped <= 40 ? "više kontrole i manje grešaka" : "umerenu kreativnost"}.
              <br><br>
              U celini, to je ${escapeHtml(agWord)} odbrana sa ${escapeHtml(compWord)} postavkom i ${escapeHtml(fbWord)} tranzicijom: agresivnost <b>${escapeHtml(String(aggr))}</b>/5 + kontra <b>${escapeHtml(String(fb))}</b>/5 teže da ti donesu lakše golove, dok povratak <b>${escapeHtml(String(rec))}</b>/5 drži strukturu da ne izgubiš stabilnost.
              <br><br>
              ${escapeHtml(rosterHint)} ${escapeHtml(riskHint)}
            `;
            sumEl.innerHTML = html;
          }
        }

        // init UI with edit target
        loadToUI(editTarget==="next" ? (next || base) : base);

        // handlers
        const b1 = screen.querySelector("#tacEditBase");
        const b2 = screen.querySelector("#tacEditNext");
        if(b1) b1.addEventListener("click", ()=>{ fm.tacticsUI.editTarget="base"; window.renderFMSkin(state, mountEl); });
        if(b2) b2.addEventListener("click", ()=>{ fm.tacticsUI.editTarget="next"; window.renderFMSkin(state, mountEl); });

        // --- Taktika: kartice + uloge (FM-style) ---
        fm.tacticsUI.activeTab = fm.tacticsUI.activeTab || "roles";
        fm.tacticsUI.selectedPos = fm.tacticsUI.selectedPos || null;

        const ROLE_DEFS = {
          GK: [
            { key:"Branilac šuteva", desc:"Fokus na odbranama (9m/6m). Stabilan, manje rizikuje." },
            { key:"Libero golman", desc:"Brže istrčavanje i pokrivanje prostora. Više presecanja, ali i više rizika." },
            { key:"Distributor", desc:"Brže izvođenje lopte i početak kontre. Više lakih golova iz tranzicije." }
          ],
          LW: [
            { key:"Završnica", desc:"Prioritet realizacija sa krila i iz kontre. Manje ulaza ka sredini." },
            { key:"Invertno krilo", desc:"Češće ulazi ka sredini i u dupli pas. Više prodora, ali i više kontakta." },
            { key:"Širi teren", desc:"Drži širinu, otvara prostor bekovima. Više asistencija, manje šuteva." }
          ],
          RW: [
            { key:"Završnica", desc:"Prioritet realizacija sa krila i iz kontre. Manje ulaza ka sredini." },
            { key:"Invertno krilo", desc:"Češće ulazi ka sredini i u dupli pas. Više prodora, ali i više kontakta." },
            { key:"Širi teren", desc:"Drži širinu, otvara prostor bekovima. Više asistencija, manje šuteva." }
          ],
          LB: [
            { key:"Snažan šuter", desc:"Više 9m šuteva (power). Veća varijansa i blok rizik." },
            { key:"Prodor", desc:"Fokus na 1-na-1 i ulaze u 2–3/3–4. Više 7m iznuđuje." },
            { key:"Razigravač", desc:"Više dodavanja i organizacije. Manje šuteva, više asistencija." }
          ],
          RB: [
            { key:"Snažan šuter", desc:"Više 9m šuteva (power). Veća varijansa i blok rizik." },
            { key:"Prodor", desc:"Fokus na 1-na-1 i ulaze u 2–3/3–4. Više 7m iznuđuje." },
            { key:"Razigravač", desc:"Više dodavanja i organizacije. Manje šuteva, više asistencija." }
          ],
          CB: [
            { key:"Organizator", desc:"Kontrola tempa i sigurna rešenja. Manje grešaka." },
            { key:"Kreator igre", desc:"Rizičnija dodavanja i kreativnost. Više asistencija, ali i više tehničkih." },
            { key:"Dvosmerna pretnja", desc:"Balans šuta i asistencija. Teže za odbranu, varijansa." }
          ],
          PIV: [
            { key:"Target pivot", desc:"Screen + zadržavanje + borba na 6m. Više faulova i 7m." },
            { key:"Pokretni pivot", desc:"Više kretanja, saradnja u križanjima. Više asistencija." },
            { key:"Završnica pivot", desc:"Prioritet realizacija na 6m. Manje screen-a, više završnice." }
          ]
        };

        function defaultRoles(){
          return {
            GK: "Branilac šuteva",
            LW: "Završnica",
            LB: "Snažan šuter",
            CB: "Organizator",
            RB: "Prodor",
            RW: "Završnica",
            PIV:"Target pivot"
          };
        }
        function ensureRolesObj(obj){
          if(!obj) return;
          if(!obj.roles || typeof obj.roles !== "object") obj.roles = defaultRoles();
          // fill missing keys
          const def = defaultRoles();
          Object.keys(def).forEach(k=>{ if(!obj.roles[k]) obj.roles[k] = def[k]; });
        }

        ensureRolesObj(club.tacticsBase);
        if(club.tacticsNext) ensureRolesObj(club.tacticsNext);

        function setTab(tab){
          fm.tacticsUI.activeTab = tab;
          const r = screen.querySelector("#tacTabRoles");
          const s = screen.querySelector("#tacTabSettings");
if(r) r.style.display = (tab==="roles") ? "" : "none";
          if(s) s.style.display = (tab==="settings") ? "" : "none";
}
setTab(fm.tacticsUI.activeTab);

        function renderRoleEditor(pos){
          fm.tacticsUI.selectedPos = pos;
          const wrap = screen.querySelector("#tacRoleEditor");
          if(!wrap) return;
          if(!ROLE_DEFS[pos]){
            wrap.innerHTML = `<div style="opacity:.8">Nepoznata pozicija.</div>`;
            return;
          }
          const tgt = targetObj();
          ensureRolesObj(tgt);
          const current = tgt.roles[pos];
          const titleMap = {GK:"Golman", LW:"Levo krilo", LB:"Levi bek", CB:"Centralni bek", RB:"Desni bek", RW:"Desno krilo", PIV:"Pivot"};
          const list = ROLE_DEFS[pos].map((r,i)=> {
            const checked = (String(current)===String(r.key)) ? "checked" : "";
            return `
              <label style="display:block; padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:12px; margin:8px 0; cursor:pointer">
                <div style="display:flex; gap:10px; align-items:flex-start">
                  <input type="radio" name="rolePick" value="${escapeAttr(r.key)}" ${checked} style="margin-top:4px">
                  <div>
                    <div style="font-weight:900">${escapeHtml(r.key)}</div>
                    <div style="font-size:12px; opacity:.8; line-height:1.35; margin-top:3px">${escapeHtml(r.desc)}</div>
                  </div>
                </div>
              </label>
            `;
          }).join("");
          wrap.innerHTML = `
            <div style="font-weight:900; margin-bottom:6px">Pozicija: ${escapeHtml(titleMap[pos]||pos)}</div>
            <div style="font-size:12px; opacity:.8; margin-bottom:10px">Biraj ulogu (menja ponašanje u match engine-u).</div>
            ${list}
          `;

          // wire radios
          wrap.querySelectorAll('input[name="rolePick"]').forEach(inp=>{
            inp.addEventListener("change", ()=>{
              const val = inp.value;
              const tgt2 = targetObj();
              ensureRolesObj(tgt2);
              tgt2.roles[pos] = val;
              // update pitch label without rerender
              const node = screen.querySelector(`.tacNode[data-pos="${pos}"] .tacRole`);
              if(node) node.textContent = val;
            });
          });
        }

        // click on pitch nodes
        screen.querySelectorAll(".tacNode").forEach(btn=>{
          btn.addEventListener("click", ()=>{
            const pos = btn.getAttribute("data-pos");
            renderRoleEditor(pos);
          });
        });

        // reset roles button
        const btnRoleReset = screen.querySelector("#tacRoleReset");
        if(btnRoleReset) btnRoleReset.addEventListener("click", ()=>{
          const tgt = targetObj();
          tgt.roles = defaultRoles();
          // update pitch labels
          Object.keys(tgt.roles).forEach(p=>{
            const node = screen.querySelector(`.tacNode[data-pos="${p}"] .tacRole`);
            if(node) node.textContent = tgt.roles[p];
          });
          // refresh editor
          if(fm.tacticsUI.selectedPos) renderRoleEditor(fm.tacticsUI.selectedPos);
        });

        // auto-open editor on last selected position
        if(fm.tacticsUI.selectedPos){
          renderRoleEditor(fm.tacticsUI.selectedPos);
        }


        function readTacticsFromUI(){
          const getV = (id)=> (screen.querySelector(id)?.value ?? "");
          return {
            defense: getV("#tacDefense") || "6-0",
            defenseMode: getV("#tacDefenseMode") || "standard",
            attack: getV("#tacAttack") || "balanced",
            tempo: getV("#tacTempo") || "normal",
            pivotFocus: Number(getV("#tacPivotFocus")||50),
            crossFrequency: Number(getV("#tacCrossFreq")||55),
            aggression: Number(getV("#tacAgg")||3),
            compactness: Number(getV("#tacComp")||3),
            fastBreakIntensity: Number(getV("#tacFB")||3),
            defensiveRecovery: Number(getV("#tacRec")||3),
          };
        }


        // =========================================
        // FM teren u taktici: promena rasporeda po formaciji odbrane
        // (Ne diramo engine, samo UI prikaz na terenu)
        // =========================================
        function setDefenseFormationOnTacPitch(def){
          const pitchEl = screen.querySelector("#tacPitch");
          if(!pitchEl) return;

          // Rasporedi su procenti (left/top). Gol je GORE, pa je GK na gol-liniji.
const layouts = {
  "6-0": {
    labels: { GK:"GK", LW:"LW", LB:"LB", CB:"CB", RB:"RB", RW:"RW" },
    pos: {
      GK:{left:50, top:12},
      LW:{left:15, top:74},
      LB:{left:32, top:72},
      CB:{left:50, top:74},
      RB:{left:68, top:72},
      RW:{left:85, top:74}
    }
  },
  "5-1": {
    labels: { GK:"GK", LW:"LW", LB:"LB", CB:"CB1", RB:"CB2", RW:"RW", PIV:"F1" },
    pos: {
      GK:{left:50, top:18},
      LW:{left:18, top:46},
      LB:{left:32, top:48},
      CB:{left:50, top:49},
      RB:{left:68, top:48},
      RW:{left:82, top:46},
      PIV:{left:50, top:60}
    }
  },
  "3-2-1": {
    labels: { GK:"GK", LW:"L3", CB:"C3", RW:"R3", LB:"L2", RB:"R2", PIV:"F1" },
    pos: {
      GK:{left:50, top:18},
      LW:{left:28, top:48},
      CB:{left:50, top:50},
      RW:{left:72, top:48},
      LB:{left:38, top:58},
      RB:{left:62, top:58},
      PIV:{left:50, top:66}
    }
  }
};

          const layout = layouts[String(def||"6-0")] || layouts["6-0"];

          // Primeni pozicije (ne menjamo data-pos, samo pomeramo)
          Object.keys(layout.pos).forEach(k=>{
            const el = pitchEl.querySelector(`.tacNode[data-pos="${k}"]`);
            if(!el) return;
            el.style.left = layout.pos[k].left + "%";
            el.style.top  = layout.pos[k].top  + "%";
          });

          
          // Sakrij sve node-ove koji nisu u ovom rasporedu (npr. Pivot u defanzivi 6-0)
          pitchEl.querySelectorAll(".tacNode").forEach(node=>{
            const p = node.getAttribute("data-pos");
            if(layout.pos[p]){
              node.style.display = "";
            } else {
              node.style.display = "none";
            }
          });

// Ažuriraj prikazane oznake pozicija (tekst), ali data-pos ostaje isti
          Object.keys(layout.labels).forEach(k=>{
            const el = pitchEl.querySelector(`.tacNode[data-pos="${k}"] .tacPos`);
            if(!el) return;
            el.textContent = layout.labels[k];
          });
        }

        
        function setAttackSixZeroOnTacPitch(){
          const pitchEl = screen.querySelector("#tacPitch");
          if(!pitchEl) return;

          const pos = {
            LW:{left:8, top:58},
            LB:{left:25, top:50},
            CB:{left:50, top:46},
            RB:{left:75, top:50},
            RW:{left:92, top:58},
            PIV:{left:50, top:64}
          };

          // Prikaži samo napadačke pozicije (bez GK u napadu)
          pitchEl.querySelectorAll(".tacNode").forEach(node=>{
            const p=node.getAttribute("data-pos");
            if(pos[p]){
              node.style.display="";
              node.style.left = pos[p].left + "%";
              node.style.top  = pos[p].top  + "%";
              const lab=node.querySelector(".tacPos");
              if(lab) lab.textContent = p === "PIV" ? "Pivot" : p;
            } else {
              node.style.display="none";
            }
          });
        }

function wireRange(id, outId){
          const el = screen.querySelector(id);
          const out = screen.querySelector(outId);
          if(!el) return;
          el.addEventListener("input", ()=>{ if(out) out.textContent = el.value; updateIdentityUI(readTacticsFromUI()); });
        }
        wireRange("#tacPivotFocus", "#tacPivotVal");
        wireRange("#tacCrossFreq", "#tacCrossVal");
        wireRange("#tacAgg", "#tacAggVal");
        wireRange("#tacComp", "#tacCompVal");
        wireRange("#tacFB", "#tacFBVal");
        wireRange("#tacRec", "#tacRecVal");

        ["#tacDefense","#tacDefenseMode","#tacAttack","#tacTempo"].forEach(id=>{
          const el = screen.querySelector(id);
          if(el) el.addEventListener("change", ()=> updateIdentityUI(readTacticsFromUI()));
        });

        // Kad se promeni formacija odbrane, odmah pomeri igrače na terenu
        const defSel = screen.querySelector("#tacDefense");
        if(defSel){
          defSel.addEventListener("change", ()=> setDefenseFormationOnTacPitch(defSel.value));
                    // inicijalno: prikaz napada (6-0 napad ka gore)
          setAttackSixZeroOnTacPitch();
}

        const attSel = screen.querySelector("#tacAttack");
        if(attSel){
          attSel.addEventListener("change", ()=> setAttackSixZeroOnTacPitch());
        }

const btnSave = screen.querySelector("#tacSave");
        if(btnSave) btnSave.addEventListener("click", ()=>{
          const tgt = targetObj();
          const getV = (id)=> (screen.querySelector(id)?.value ?? "");
          tgt.defense = getV("#tacDefense") || "6-0";
          tgt.defenseMode = getV("#tacDefenseMode") || "standard";
          tgt.attack = getV("#tacAttack") || "balanced";
          tgt.tempo = getV("#tacTempo") || "normal";
          tgt.pivotFocus = Number(getV("#tacPivotFocus")||50);
          tgt.crossFrequency = Number(getV("#tacCrossFreq")||55);
          tgt.aggression = Number(getV("#tacAgg")||3);
          tgt.compactness = Number(getV("#tacComp")||3);
          tgt.fastBreakIntensity = Number(getV("#tacFB")||3);
          tgt.defensiveRecovery = Number(getV("#tacRec")||3);
          // mirror legacy
          club.tactics = club.tacticsBase;
          window.renderFMSkin(state, mountEl);
        });

        const btnReset = screen.querySelector("#tacResetNext");
        if(btnReset) btnReset.addEventListener("click", ()=>{
          club.tacticsNext = null;
          window.renderFMSkin(state, mountEl);
        });

        return;
      }

      if(fm.route === "finance"){
        title.textContent = "Finansije";
        screen.innerHTML = `
          <div class="tableTitleRow">
            <div>
              <div style="font-weight:1000">Finansije • ${escapeHtml(club.name)}</div>
              <div class="sub">Budžeti i pregled</div>
            </div>
            <span class="tagMini">Klub</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px">
            <div class="panel" style="padding:12px">
              <div style="font-weight:950">Ukupan budžet</div>
              <div style="margin-top:6px;opacity:.85">${finance.budget!=null ? escapeHtml(String(finance.budget)) : "—"}</div>
            </div>
            <div class="panel" style="padding:12px">
              <div style="font-weight:950">Budžet plata</div>
              <div style="margin-top:6px;opacity:.85">${finance.wageBudget!=null ? escapeHtml(String(finance.wageBudget)) : "—"}</div>
            </div>
            <div class="panel" style="padding:12px">
              <div style="font-weight:950">Transfer budžet</div>
              <div style="margin-top:6px;opacity:.85">${finance.transferBudget!=null ? escapeHtml(String(finance.transferBudget)) : "—"}</div>
            </div>
          </div>
        `;
        return;
      }

      if(fm.route === "support.board"){
        title.textContent = "Uprava";

        // Objectives come from DB (generated in FAZA 1 and stored on clubRef)
        const objList = Array.isArray(objectives) ? objectives : [];
        const goalProg = (club && typeof club.goalProgress === "number") ? club.goalProgress : 50;
        const pressProg = (club && typeof club.pressureProgress === "number") ? club.pressureProgress : 50;

        const renderBar = (val)=>`<div class="fm-progress ${val<30?"low":""}"><span style="width:${Math.max(0,Math.min(100,val))}%"></span></div>`;

        const renderObj = (o)=>{
          if(o && typeof o === "object"){
            const k = o.k ?? o.key ?? o.label ?? "";
            const v = o.v ?? o.value ?? o.target ?? "";
            const line = `${k ? `<b>${escapeHtml(String(k))}:</b> ` : ""}${escapeHtml(String(v))}`;
            return `<li style="margin:6px 0">${line}</li>`;
          }
          return `<li style="margin:6px 0">${escapeHtml(String(o))}</li>`;
        };

        screen.innerHTML = `
          <div class="tableTitleRow">
            <div>
              <div style="font-weight:1000">Uprava • ${escapeHtml(club.name)}</div>
              <div class="sub">Ciljevi, očekivanja i sastav uprave</div>
            </div>
            <span class="tagMini">Ciljevi</span>
          </div>

          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:12px">
            <div class="panel" style="padding:12px">
              <div style="font-weight:950">Primarni cilj</div>
              <div style="margin-top:6px;opacity:.85">${primaryGoal ? escapeHtml(String(primaryGoal)) : "—"}</div>
              <div style="margin-top:10px;opacity:.9;font-size:12px">Ispunjenost ciljeva</div>
              ${renderBar(goalProg)}
            </div>

            <div class="panel" style="padding:12px">
              <div style="font-weight:950">Pritisak javnosti</div>
              <div style="margin-top:6px;opacity:.85">${pressure ? escapeHtml(String(pressure)) : "—"}</div>
              <div style="margin-top:10px;opacity:.9;font-size:12px">Trenutni nivo pritiska</div>
              ${renderBar(pressProg)}
            </div>
          </div>

          <div class="panel" style="padding:12px; margin-top:10px">
            <div style="font-weight:950; margin-bottom:8px">Ciljevi</div>
            ${objList.length ? `
              <ul style="margin:0; padding-left:18px">
                ${objList.map(renderObj).join("")}
              </ul>
            ` : `<div style="opacity:.8">—</div>`}
          </div>

          <div class="panel" style="padding:12px; margin-top:10px">
            <div style="font-weight:950; margin-bottom:8px">Sastav uprave</div>
            <div class="tableWrap" style="margin-top:8px">
              <table>
                <thead><tr><th style="width:55%">Ime</th><th>Uloga</th></tr></thead>
                <tbody>
                  ${(Array.isArray(club.board) ? club.board : []).map((b,i)=>`
                    <tr>
                      <td>${escapeHtml(b.name || "")}</td>
                      <td>${escapeHtml(b.role || "")}</td>
                    </tr>
                  `).join("") || `<tr><td colspan="2">—</td></tr>`}
                </tbody>
              </table>
            </div>
          </div>
        `;
        return;
      }

      // generic placeholder for other routes
      const map = {
        "club.tactics":"Taktika",
        "club.matches":"Utakmice",
        "training.daily":"Dnevni trening",
        "training.weekly":"Nedeljni trening",
        "training.monthly":"Mesečni trening",
        "transfers.players":"Transferi • Igrači",
        "transfers.coaches":"Transferi • Treneri",
        "comp.league":"Takmičenja • Liga",
        "comp.cup":"Takmičenja • Kup",
        "comp.cl":"Takmičenja • Liga šampiona",
        "support.fans":"Podrška • Navijači",
      };
      const screenTitle = map[fm.route] || "Ekran";
      title.textContent = screenTitle;

      screen.innerHTML = `
        <div class="tableTitleRow">
          <div>
            <div style="font-weight:1000">${escapeHtml(screenTitle)}</div>
            <div class="sub">Placeholder ekran — popunjavamo sledeće</div>
          </div>
          <span class="tagMini">U izradi</span>
        </div>
        <div style="padding:10px 6px 2px 6px">
          <div style="border:1px solid rgba(255,255,255,.10); background:rgba(0,0,0,.14); border-radius:16px; padding:12px;">
            <div style="font-weight:1000">Sledeći korak</div>
            <div style="color:rgba(238,244,255,.72); font-size:12px; margin-top:4px; line-height:1.35">
              Ovaj ekran ćemo povezati sa podacima i logikom (match engine / ciljevi / moral).
            </div>
          </div>
        </div>
      `;
    }

    // Build markup (DO NOT change skin structure)
    mountEl.innerHTML = `
      <header class="topbar">
        <div class="top-left">
          <div class="logo">🤾</div>
        </div>

        <div class="top-center">
          <div class="clubName" id="clubName">${escapeHtml(club.name)}</div>
          <div class="clubSub" id="clubSub">${escapeHtml(club.leagueName || state.career?.leagueName || "Klub • Senior tim")}</div>
          <div class="teamStatus" id="teamStatus"></div>
        </div>

        <div class="top-right">
          <button class="topSelect topBtn" id="fmContinueBtn" type="button">Nastavi ▶</button>
          <button class="topSelect topBtn" id="hmTestMatchBtn" type="button" title="Privremeni test meča (Match Engine)">Test meč ⚡</button>
          <select class="topSelect"><option>Opcije</option><option>Sačuvaj</option><option>Izlaz</option></select>
        </div>
      </header>

      
      <div id="thinkingOverlay" style="display:none; position:fixed; inset:0; background:rgba(5,8,15,.72); z-index:9999; align-items:center; justify-content:center;">
        <div class="thinkingCard">
          <div class="thinkingDots" aria-label="Analiza u toku">
            <span></span><span></span><span></span>
          </div>
        </div>
      </div>

      <div id="autoReport" style="display:none; position:fixed; inset:0; background:rgba(5,8,15,.72); z-index:9998;">
        <div style="max-width:720px; margin:7vh auto 0; background:rgba(14,20,34,.98); border:1px solid rgba(180,210,255,.18); border-radius:12px; padding:16px; width:min(720px, 94vw); box-shadow:0 20px 50px rgba(0,0,0,.45);">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
            <div id="autoReportTitle" style="font-weight:1000;">Izveštaj</div>
            <button id="autoReportClose" style="cursor:pointer; background:rgba(255,255,255,.10); color:#eef4ff; border:1px solid rgba(255,255,255,.14); padding:6px 10px; border-radius:10px;">Zatvori</button>
          </div>
          <div id="autoReportBody" style="margin-top:10px;"></div>
        </div>
      </div>

      <div class="layout">
        <aside class="sidebar">
          <div class="sideHeader">
            <div class="sideTitle">Prečice</div>
            <div class="sideHint">FM šema • moderan skin</div>
          </div>

          <nav id="nav"></nav>

          <div class="sideFooter">
            <button class="softBtn" id="btnContinue">Nastavi ▶</button>
          </div>
        </aside>

        <main class="content">
          <div class="contentHeader">
            <div class="contentTitle" id="screenTitle">Prvi dan u klubu</div>
            <div class="contentMeta" id="contentMeta"></div>
          </div>

          <section class="panel" id="screen"></section>
        </main>
      </div>
    `;

    // wire continue
    const btn = mountEl.querySelector("#btnContinue");
    if(btn) btn.addEventListener("click", () => {
      alert("Nastavi ▶ (sledeći korak: Inbox + događaji dana + trening)");
    });

    renderNav();
    renderScreen();
    // default: players screen
    if(!fm.route) fm.route = "club.players";
    navigate(fm.route || "club.players");
  
};
})();

// ===============================
// FINAL TACTIC PITCH OVERRIDE
// ===============================

// Helpers (safe if already exist)
if (typeof escapeHtml !== "function") {
  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, s=>({
      "&":"&amp;","<":"&lt;",">":"&gt;",
      '"':"&quot;","'":"&#39;"
    })[s]);
  }
}
if (typeof escapeAttr !== "function") {
  function escapeAttr(str){
    return escapeHtml(str);
  }
}



// ======================
// HM: Realistic full-court (parquet) + position balls overlay (Teren tab)
// ======================

function renderHMRealisticCourtWithBalls(defKey){
  try{
    const key = (defKey && FORMATION_PRESETS[defKey]) ? defKey : "6-0";
    const slots = (FORMATION_PRESETS[key] && Array.isArray(FORMATION_PRESETS[key].slots)) ? FORMATION_PRESETS[key].slots : [];

    // Defense (left) = blue, Attack (right) = red (6-0 calibrated)
    const clamp = (v, a, b)=>Math.max(a, Math.min(b, v));
    const clampY = (y)=>clamp(y, 10, 90);

    // Hard clamp per half (never cross x=50)
    const clampXDef = (x)=>clamp(x, 10, 40);
    const clampXAtk = (x)=>clamp(x, 60, 92);

    const makeToken = (cls, lab, x, y)=>{
      const PAD = 4; // %
      const clamp = (v, a, b)=>Math.max(a, Math.min(b, v));

      // Base clamp (keep away from outer lines)
      let xx = clamp(Number(x) || 50, PAD, 100-PAD);
      let yy = clamp(Number(y) || 50, PAD, 100-PAD);

      // Half clamp (never cross midfield)
      if(cls === "hmTokenDef"){
        xx = clamp(xx, PAD, 50-PAD);
      }else{
        xx = clamp(xx, 50+PAD, 100-PAD);
      }

      return `<div class="hmToken pitch-dot ${cls}" title="${escapeAttr(lab)}" style="left:${xx}%; top:${yy}%"><span>${escapeHtml(lab)}</span></div>`;
    };

    // ODBRANA 6-0 (PLAVO, levo) — kalibrisano
    const layout6Def = [
      // ODBRANA 6-0 (PLAVO, levo) — raspored po luku (između 6m i 9m), kao na slici
      // GK tačno ispred gola (centar gola), ostali ne dirati
      {lab:"GK", x:6, y:50},

      {lab:"LW", x:20, y:18},
      {lab:"LB", x:25, y:32},
      {lab:"CB", x:28, y:45},
      {lab:"CB2",x:28, y:55},
      {lab:"RB", x:25, y:68},
      {lab:"RW", x:20, y:82},
    ];

    // NAPAD (CRVENO, desno) — bez GK
    // Bazne koordinate + modifikatori iz gameState.tactics.offense (focus + width)
    const offense = (window.gameState && window.gameState.tactics && window.gameState.tactics.offense) ? window.gameState.tactics.offense : { focus:"balanced", width:5 };

    const baseAtk = {
      RW:{ x:92,  y:14 },
      RB:{ x:73,  y:34 },
      CB:{ x:70.5,y:50 },
      LB:{ x:73,  y:66 },
      LW:{ x:92,  y:86 },
      PV:{ x:85,  y:50 }
    };

    const wid = hmClamp(hmNum(offense.width, 5), 1, 10);
    const widN = (wid - 5) / 5; // -0.8..+1
    // width affects vertical spread (wider -> closer to corners)
    const wingYTop = 14 - 6*widN;   // wider -> 8.., narrower -> 18..
    const wingYBot = 86 + 6*widN;   // wider -> 92.., narrower -> 82..
    const backYTop = 34 - 4*widN;
    const backYBot = 66 + 4*widN;

    // focus affects depth (x) and centralization
    const f = String(offense.focus || "balanced");
    let dPVx=0, dCBx=0, dBackx=0, dWingx=0;
    if(f==="pivot"){
      dPVx = +3;   // deeper toward goal
      dCBx = -1;   // CB slightly out
      dBackx = -1;
    }else if(f==="wings"){
      dWingx = +2;
      dBackx = -0.5;
      dPVx = -1.5;
    }else if(f==="backcourt"){
      dBackx = -3; // backs further from goal (more 9m)
      dCBx = -2;
      dPVx = -2;
    }

    const layout6Atk = [
      {lab:"RW", x: baseAtk.RW.x + dWingx, y: wingYTop},
      {lab:"RB", x: baseAtk.RB.x + dBackx, y: backYTop},
      {lab:"CB", x: baseAtk.CB.x + dCBx, y: 50},
      {lab:"LB", x: baseAtk.LB.x + dBackx, y: backYBot},
      {lab:"LW", x: baseAtk.LW.x + dWingx, y: wingYBot},
      {lab:"PV", x: baseAtk.PV.x + dPVx, y: 50},
    ];

    let ballsDef = "";
    let ballsAtk = "";

    if(key === "6-0"){
      // If CB2 missing in label set, still render as provided; UI can ignore if needed
      ballsDef = layout6Def.map(p=>makeToken("hmTokenDef", p.lab, p.x, p.y)).join("");
      ballsAtk = layout6Atk.map(p=>makeToken("hmTokenAtk", p.lab, p.x, p.y)).join("");
    }else{
      // Fallback to presets, but keep hard clamped per half
      ballsDef = slots.map(s=>{
        const x = (Number(s.x) || 50) * 0.5;           // left half
        const y = (Number(s.y) || 50);
        const lab = (s.label || s.pos || "").toUpperCase();
        return makeToken("hmTokenDef", lab, x, y);
      }).join("");

      ballsAtk = slots.map(s=>{
        const x = 50 + (Number(s.x) || 50) * 0.5;      // right half
        const y = (Number(s.y) || 50);
        const lab = (s.label || s.pos || "").toUpperCase();
        // Skip GK on attack half
        if(lab === "GK") return "";
        return makeToken("hmTokenAtk", lab, x, y);
      }).join("");
    }

return `
      <div class="fm-pitch hmCourtFM">
        <svg class="hmCourtSVG" viewBox="0 0 200 100" preserveAspectRatio="none" aria-label="Rukometni teren">
          <defs>
            <!-- purple pitch shading -->
            <linearGradient id="hmPurpleGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#7b48da"/>
              <stop offset="50%" stop-color="#6f3fd0"/>
              <stop offset="100%" stop-color="#6235c2"/>
            </linearGradient>
            <linearGradient id="hmVignette" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="rgba(0,0,0,0.22)"/>
              <stop offset="40%" stop-color="rgba(0,0,0,0.0)"/>
              <stop offset="100%" stop-color="rgba(0,0,0,0.18)"/>
            </linearGradient>
            <pattern id="hmSubtleLines" width="16" height="16" patternUnits="userSpaceOnUse">
              <rect width="16" height="16" fill="transparent"/>
              <line x1="0" y1="8" x2="16" y2="8" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
            </pattern>
          </defs>

          <!-- pitch -->
          <rect x="0" y="0" width="200" height="100" fill="url(#hmPurpleGrad)"/>
          <rect x="0" y="0" width="200" height="100" fill="url(#hmSubtleLines)"/>
          <rect x="0" y="0" width="200" height="100" fill="url(#hmVignette)"/>

          <!-- outer boundary -->
          <rect x="4" y="4" width="192" height="92" rx="0" ry="0" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="2.2"/>

          <!-- center line -->
          <line x1="100" y1="4" x2="100" y2="96" stroke="rgba(255,255,255,.88)" stroke-width="1.6"/>
          <!-- center circle (thin like reference) -->
          <circle cx="100" cy="50" r="10.5" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.2"/>
          <circle cx="100" cy="50" r="1.4" fill="rgba(255,255,255,.82)"/>

          <!-- LEFT goal frame -->
          <rect x="1.2" y="43.5" width="2.2" height="13" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.2"/>
          <!-- 6m arc (solid, thick) center at (4,50) -->
          <path d="M 4 20 A 30 30 0 0 1 4 80" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="3.0" stroke-linecap="round"/>
          <!-- 9m arc (dashed) -->
          <path d="M 4 5 A 45 45 0 0 1 4 95" fill="none" stroke="rgba(255,255,255,.78)" stroke-width="2.0" stroke-dasharray="6 10" stroke-linecap="round"/>
          <!-- 7m mark -->
          <circle cx="39" cy="50" r="1.6" fill="rgba(255,255,255,.82)"/>
          <!-- 4m GK line -->
          <line x1="24" y1="45" x2="24" y2="55" stroke="rgba(255,255,255,.78)" stroke-width="2.0" stroke-linecap="round"/>
          <!-- 7m short line (tiny) -->
          <line x1="39" y1="46.7" x2="39" y2="53.3" stroke="rgba(255,255,255,.55)" stroke-width="1.0" stroke-linecap="round"/>

          <!-- RIGHT goal frame -->
          <rect x="196.6" y="43.5" width="2.2" height="13" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="1.2"/>
          <!-- 6m -->
          <path d="M 196 20 A 30 30 0 0 0 196 80" fill="none" stroke="rgba(255,255,255,.92)" stroke-width="3.0" stroke-linecap="round"/>
          <!-- 9m -->
          <path d="M 196 5 A 45 45 0 0 0 196 95" fill="none" stroke="rgba(255,255,255,.78)" stroke-width="2.0" stroke-dasharray="6 10" stroke-linecap="round"/>
          <!-- 7m -->
          <circle cx="161" cy="50" r="1.6" fill="rgba(255,255,255,.82)"/>
          <!-- 4m -->
          <line x1="176" y1="45" x2="176" y2="55" stroke="rgba(255,255,255,.78)" stroke-width="2.0" stroke-linecap="round"/>
          <line x1="161" y1="46.7" x2="161" y2="53.3" stroke="rgba(255,255,255,.55)" stroke-width="1.0" stroke-linecap="round"/>
        </svg>

        <div class="hmBallsLayer">
          ${ballsDef}
          ${ballsAtk}
        </div>
      </div>
    `;
  }catch(e){
    return `<div class="sub" style="opacity:.8">Greška u prikazu terena.</div>`;
  }
}


const FORMATION_PRESETS = {
  "6-0": {
    slots: [
      { pos:"GK",  x:50, y:24, label:"GK"  },
      { pos:"LW",  x:10, y:66, label:"LW"  },
      { pos:"LB",  x:26, y:56, label:"LB"  },
      { pos:"CB",  x:44, y:52, label:"CB"  },
      { pos:"CB2", x:56, y:52, label:"CB2" },
      { pos:"RB",  x:74, y:56, label:"RB"  },
      { pos:"RW",  x:90, y:66, label:"RW"  }
    ]
  },
  "5-1": {
    slots: [
      { pos:"GK",  x:50, y:24, label:"GK"  },
      { pos:"LW",  x:12, y:68, label:"LW"  },
      { pos:"LB",  x:30, y:60, label:"LB"  },
      { pos:"CB",  x:50, y:62, label:"CB"  },
      { pos:"RB",  x:70, y:60, label:"RB"  },
      { pos:"RW",  x:88, y:68, label:"RW"  },
      { pos:"PIV", x:50, y:48, label:"F1"  }
    ]
  },
  "3-2-1": {
    slots: [
      { pos:"GK",  x:50, y:24, label:"GK" },
      { pos:"LW",  x:18, y:74, label:"L3" },
      { pos:"CB",  x:50, y:74, label:"C3" },
      { pos:"RW",  x:82, y:74, label:"R3" },
      { pos:"LB",  x:34, y:64, label:"L2" },
      { pos:"RB",  x:66, y:64, label:"R2" },
      { pos:"PIV", x:50, y:54, label:"1"  }
    ]
  }
};

function renderPitchOverride(activeLike, tacNames){
  const def = String(activeLike?.defense || "6-0");
  const slots = (FORMATION_PRESETS[def]||FORMATION_PRESETS["6-0"]).slots;
  const roles = activeLike?.roles || {};
  const names = tacNames || {};
  return `
    <div class="fm-pitch tacPitch" id="tacPitch">
      <div class="pitch-layer">
        ${slots.map(s=>`
          <button class="tacNode" data-pos="${escapeAttr(s.pos)}"
            style="--x:${s.x}%; --y:${s.y}%">
            <div class="tacPos">${escapeHtml(s.label||s.pos)}</div>
            <div class="tacRole">${escapeHtml(roles[s.pos]||"—")}</div>
            <div class="tacPlayer">${escapeHtml(names[s.pos]||"—")}</div>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

window.__HM_renderPitchOverride = renderPitchOverride;
