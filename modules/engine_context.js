
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
