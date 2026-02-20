/* =========================================================
   HM_MATCH_ENGINE (v1)
   - Backend-only match simulation (no UI)
   - FM 2007 vibe: attribute-driven, tactics as modifiers, referee strictness
   - Safe to include in existing project: does not touch DOM

   Public API:
     window.HM_MATCH.simulateMatch(teamA, teamB, options)
     window.HM_MATCH.simulateFromState(state, opponentTeam, options)
     window.HM_MATCH.defaults

   Notes:
   - This is a FIRST VERSION. It focuses on stability + believable outputs.
   - It is intentionally conservative to avoid breaking anything.
   ========================================================= */
(function(){
  "use strict";

  // --------------------------
  // Utils
  // --------------------------
  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
  function toNum(x, d){ const n = Number(x); return Number.isFinite(n) ? n : d; }

  // Deterministic PRNG (Mulberry32)
  function seedFromString(str){
    const s = String(str ?? "");
    let h = 2166136261;
    for(let i=0;i<s.length;i++){
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0);
  }
  function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function pickWeighted(rng, items){
    // items: [{k, w}] or [[k,w]]
    const arr = (items||[]).map(it => Array.isArray(it) ? ({k:it[0], w:it[1]}) : it);
    let sum = 0;
    for(const it of arr){ sum += Math.max(0, Number(it.w)||0); }
    if(sum <= 0) return arr[0]?.k;
    let r = rng() * sum;
    for(const it of arr){
      r -= Math.max(0, Number(it.w)||0);
      if(r <= 0) return it.k;
    }
    return arr[arr.length-1]?.k;
  }


  // --------------------------
  // Tactic Mods (KORAK 1)
  // --------------------------
  // buildTacticMods(tactics) vraća numeričke multiplikatore koji utiču na match engine.
  // Ne menja UI/skin – samo logiku.
  function buildTacticMods(tactics){
    const t = (tactics && typeof tactics === 'object') ? tactics : {};

    // Defaulti
    const defenseFormation = String(t.defenseFormation ?? t.defense ?? t.defSystem ?? '6-0');
    const agresivnostRaw = toNum(t.agresivnost ?? t.aggression ?? t.aggr ?? 3, 3);
    const agresivnost = clamp(Math.round(agresivnostRaw), 1, 5);

    // Osnovni multiplikatori po formaciji odbrane
    let tempoMul=0.95, stealMul=0.85, turnoverMul=0.95, twoMinMul=0.95, sevenMMul=0.95; // 6-0 default
    const d = String(defenseFormation).trim();
    if(d === '5-1'){
      tempoMul=1.05; stealMul=1.20; turnoverMul=1.10; twoMinMul=1.15; sevenMMul=1.05;
    } else if(d === '3-2-1'){
      tempoMul=1.10; stealMul=1.25; turnoverMul=1.15; twoMinMul=1.10; sevenMMul=1.10;
    } else {
      // 6-0 ili fallback
      tempoMul=0.95; stealMul=0.85; turnoverMul=0.95; twoMinMul=0.95; sevenMMul=0.95;
    }

    // Slider "Agresivnost (1–5)" (baza 3)
    const aggrFactor = 1 + (agresivnost - 3) * 0.08;
    stealMul *= aggrFactor;
    twoMinMul *= (1 + (agresivnost - 3) * 0.10);
    sevenMMul *= (1 + (agresivnost - 3) * 0.05);

    // Clamp svih multiplikatora u opsegu 0.7 – 1.4
    tempoMul = clamp(tempoMul, 0.7, 1.4);
    stealMul = clamp(stealMul, 0.7, 1.4);
    turnoverMul = clamp(turnoverMul, 0.7, 1.4);
    twoMinMul = clamp(twoMinMul, 0.7, 1.4);
    sevenMMul = clamp(sevenMMul, 0.7, 1.4);

    return { defenseFormation: d, agresivnost, tempoMul, stealMul, turnoverMul, twoMinMul, sevenMMul };
  }

  function getPlayerOVR(p){
    const raw = p?.ovr ?? p?.overall ?? p?.rating ?? p?.avgRating ?? 10;
    return clamp(Math.round(toNum(raw, 10)), 1, 20);
  }
  function getFitness(p){
    const raw = p?.fitness ?? p?.condition ?? p?.kondicija ?? p?.cond ?? 70;
    return clamp(toNum(raw, 70), 0, 100);
  }
  function getMorale(p){
    const raw = p?.morale ?? p?.moral ?? 13;
    return clamp(toNum(raw, 13), 0, 25);
  }
  function posKey(p){
    return String(p?.pos ?? p?.position ?? p?.poz ?? "").toUpperCase();
  }

  function safeAttrs(p){
    return (p && p.attributes && typeof p.attributes === 'object') ? p.attributes : {};
  }
  function aNum(v, d){
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function attr(p, group, key, fallback){
    const at = safeAttrs(p);
    const g = at[group] || {};
    return clamp(aNum(g[key], fallback), 1, 20);
  }

  function teamName(t){ return t?.name ?? t?.clubName ?? t?.title ?? 'Team'; }
  function playersOf(t){
    if(Array.isArray(t?.players)) return t.players;
    if(Array.isArray(t?.squad)) return t.squad;
    return [];
  }

  // Pick a "best 7" with rough position preference.
  function selectLineup(players){
    const list = (players||[]).slice();
    // Ensure OVR is there
    list.forEach(p=>{ if(p && p.ovr == null) p.ovr = getPlayerOVR(p); });

    const gks = list.filter(p=>posKey(p)==='GK').sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a));
    const piv = list.filter(p=>posKey(p)==='PIV').sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a));
    const wings = list.filter(p=>posKey(p)==='LW' || posKey(p)==='RW').sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a));
    const backs = list.filter(p=>!['GK','PIV','LW','RW'].includes(posKey(p))).sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a));

    const start = [];
    if(gks[0]) start.push(gks[0]);
    if(piv[0]) start.push(piv[0]);
    if(wings[0]) start.push(wings[0]);
    if(wings[1]) start.push(wings[1]);

    // Fill remaining with best backs
    for(const b of backs){
      if(start.length>=7) break;
      if(!start.includes(b)) start.push(b);
    }
    // If still short, fill with best overall
    if(start.length<7){
      const rest = list.slice().sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a));
      for(const p of rest){
        if(start.length>=7) break;
        if(!start.includes(p)) start.push(p);
      }
    }

    // Bench top 7 others
    const bench = list.filter(p=>!start.includes(p)).sort((a,b)=>getPlayerOVR(b)-getPlayerOVR(a)).slice(0,7);
    return { start, bench };
  }

  // --------------------------
  // Tactics (lightweight v1)
  // --------------------------
  function normalizeDefense(def){
    const d = String(def||'6-0').toLowerCase().replace(/\s+/g,'');
    if(d.includes('321') || d.includes('3-2-1')) return '3-2-1';
    if(d.includes('51') || d.includes('5-1')) return '5-1';
    return '6-0';
  }
  function normalizeAttack(att){
    const a = String(att||'balanced').toLowerCase();
    if(a.includes('4')) return '4-backs';
    if(a.includes('pivot')) return 'pivot-screen';
    if(a.includes('switch')) return 'fast-switch';
    if(a.includes('behind')) return 'behind-front';
    return 'balanced';
  }

  function defenseProfile(defShape, mode){
    const d = normalizeDefense(defShape);
    const m = String(mode||'standard').toLowerCase();
    // Output values ~0..1 modifiers
    if(d==='3-2-1'){
      return {
        pressure: 0.78,
        intercept: 0.18,
        gapRisk: 0.22,
        block: 0.07,
        wingOpen: 0.12,
        fastBreak: 0.18,
        foul: 0.19,
      };
    }
    if(d==='5-1'){
      return {
        pressure: 0.62,
        intercept: 0.14,
        gapRisk: 0.16,
        block: 0.09,
        wingOpen: 0.10,
        fastBreak: 0.14,
        foul: 0.17,
      };
    }
    // 6-0
    if(m.includes('offen') || m.includes('ball') || m.includes('dutch')){
      // Offensive 6-0: more pressure + interceptions, but more gaps
      const dutch = m.includes('dutch');
      return {
        pressure: dutch ? 0.62 : 0.58,
        intercept: dutch ? 0.13 : 0.15,
        gapRisk: dutch ? 0.12 : 0.17,
        block: dutch ? 0.13 : 0.12,
        wingOpen: dutch ? 0.10 : 0.12,
        fastBreak: dutch ? 0.12 : 0.15,
        foul: dutch ? 0.16 : 0.18,
      };
    }
    // Standard 6-0
    return {
      pressure: 0.46,
      intercept: 0.08,
      gapRisk: 0.10,
      block: 0.14,
      wingOpen: 0.09,
      fastBreak: 0.09,
      foul: 0.16,
    };
  }

  function attackPlanAgainst(defShape, attackStyle){
    const d = normalizeDefense(defShape);
    const a = normalizeAttack(attackStyle);
    // return plan key used for probabilities
    if(d==='5-1'){
      if(a==='behind-front') return 'BEHIND_FRONT';
      if(a==='fast-switch') return 'FAST_SWITCH';
      return 'BEHIND_FRONT';
    }
    if(d==='6-0'){
      if(a==='4-backs') return 'FOUR_BACKS';
      if(a==='pivot-screen') return 'PIVOT_SCREEN_9M';
      if(a==='fast-switch') return 'FAST_SWITCH';
      return 'FOUR_BACKS';
    }
    // 3-2-1
    if(a==='fast-switch') return 'FAST_SWITCH';
    return 'SAFE_CIRCULATION';
  }

  // --------------------------
  // Team strength from players + staff multipliers
  // --------------------------
  function computeTeamRatings(team, engineCtx){
    const pl = playersOf(team);
    const { start, bench } = selectLineup(pl);
    const avg = (arr)=>{
      const nums = (arr||[]).map(getPlayerOVR);
      return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : 10;
    };
    const avgFit = (arr)=>{
      const nums = (arr||[]).map(getFitness);
      return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : 70;
    };
    const avgMor = (arr)=>{
      const nums = (arr||[]).map(getMorale);
      return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : 13;
    };

    const startOVR = avg(start);
    const benchOVR = avg(bench);
    const fit = avgFit(start);
    const mor = avgMor(start);

    const staffMult = engineCtx?.combined?.mult?.match ?? 1;
    const mentalMult = engineCtx?.combined?.mult?.mental ?? 1;

    // Convert fitness/morale into small multipliers
    const fitMult = clamp(0.92 + (fit/100)*0.16, 0.90, 1.08); // 50% -> 1.00
    const morMult = clamp(0.94 + ((mor-13)/12)*0.08, 0.88, 1.08);

    const base = (startOVR*0.86 + benchOVR*0.14);

    return {
      start, bench,
      startOVR, benchOVR,
      fit, mor,
      mult: {
        staff: clamp(staffMult, 0.90, 1.10),
        mental: clamp(mentalMult, 0.90, 1.10),
        fit: fitMult,
        morale: morMult
      },
      teamPower: clamp(base * staffMult * fitMult * morMult, 1, 20)
    };
  }

  // --------------------------
  // Referee layer (B mode)
  // --------------------------
  function resolveReferee(options, rng){
    const strict = clamp(toNum(options?.referee?.strictness ?? 50, 50), 0, 100);
    const adv = clamp(toNum(options?.referee?.advantage_bias ?? 55, 55), 0, 100);
    const passive = clamp(toNum(options?.referee?.passive_strictness ?? 55, 55), 0, 100);
    const lineTol = clamp(toNum(options?.referee?.line_tolerance ?? (100-strict), 50), 0, 100);
    return {
      strictness: strict,
      advantage_bias: adv,
      passive_strictness: passive,
      line_tolerance: lineTol,
      // small per-match variance
      jitter: (rng()-0.5)*0.08
    };
  }

  function foulToCardChance(ref, foulSeverity, isClearChance){
    // severity 0..1
    const s = clamp(foulSeverity, 0, 1);
    const base = 0.08 + s*0.28; // 8%..36%
    const strictBoost = (ref.strictness/100)*0.18; // up to +18%
    const clearBoost = isClearChance ? 0.10 : 0;
    return clamp(base + strictBoost + clearBoost + ref.jitter, 0.05, 0.65);
  }
  function foulTo7mChance(ref, isClearChance){
    if(!isClearChance) return 0;
    const base = 0.74; // clear chance -> mostly 7m
    const strictBoost = (ref.strictness/100)*0.12;
    return clamp(base + strictBoost + ref.jitter, 0.55, 0.92);
  }

  // --------------------------
  // Possession resolution
  // --------------------------
  function chooseShooter(lineupStart, shotType, rng){
    const start = (lineupStart||[]);
    const gk = start.find(p=>posKey(p)==='GK');
    const pivot = start.find(p=>posKey(p)==='PIV');
    const wings = start.filter(p=>posKey(p)==='LW' || posKey(p)==='RW');
    const backs = start.filter(p=>!['GK','PIV','LW','RW'].includes(posKey(p)));

    if(shotType==='7m'){
      // best decision + technique among backs
      const cand = backs.length? backs : start.filter(p=>p!==gk);
      return cand.slice().sort((a,b)=>{
        const sa = (attr(a,'mental','odlucivanje',12)+attr(a,'offense','sut',12))/2;
        const sb = (attr(b,'mental','odlucivanje',12)+attr(b,'offense','sut',12))/2;
        return sb-sa;
      })[0] || start[0];
    }
    if(shotType==='wing'){
      if(wings.length) return wings[Math.floor(rng()*wings.length)];
    }
    if(shotType==='6m'){
      if(pivot) return pivot;
    }
    // 9m / fastbreak: pick one of backs, else best non-gk
    if(backs.length){
      // weight by ovr and shot
      const items = backs.map(p=>({k:p, w: (getPlayerOVR(p)*0.7 + attr(p,'offense','sut',12)*0.3)}));
      return pickWeighted(rng, items);
    }
    const cand = start.filter(p=>p!==gk);
    return cand[Math.floor(rng()*Math.max(1,cand.length))] || start[0];
  }

  function goalkeeper(teamRating){
    const gk = teamRating.start.find(p=>posKey(p)==='GK');
    return gk || teamRating.start[0] || null;
  }

  function resolveShot(rng, shooter, gk, shotType, attackBoost, defenseProf, ref, goalScale){
    const gs = (typeof goalScale==="number" && isFinite(goalScale)) ? goalScale : 1.0;
    const ovrS = getPlayerOVR(shooter);
    const fitS = getFitness(shooter);
    const morS = getMorale(shooter);

    const ovrG = gk ? getPlayerOVR(gk) : 12;

    // Base quality by shot type
    let baseQ;
    if(shotType==='fastbreak') baseQ = 0.74;
    else if(shotType==='6m') baseQ = 0.66;
    else if(shotType==='wing') baseQ = 0.54;
    else if(shotType==='7m') baseQ = 0.76;
    else baseQ = 0.48; // 9m

    // Shooter skill factor (0..1)
    const shotSkill = clamp((ovrS-8)/12, 0, 1);
    const fitMult = clamp(0.85 + (fitS/100)*0.25, 0.80, 1.05);
    const morMult = clamp(0.92 + ((morS-13)/12)*0.12, 0.80, 1.08);
    const shooterQ = baseQ * (0.72 + 0.40*shotSkill) * fitMult * morMult;

    // Defense effects
    let blockPenalty = 0;
    if(shotType==='9m') blockPenalty = defenseProf.block * 0.18;
    if(shotType==='wing') blockPenalty = defenseProf.wingOpen * -0.10; // wingOpen helps shooter
    const pressurePenalty = defenseProf.pressure * 0.10;

    // Referee line tolerance slightly affects contact -> shot quality
    const contactAdj = (50 - ref.line_tolerance) / 500; // -0.1 .. +0.1

    // GK factor
    const gkSkill = clamp((ovrG-8)/12, 0, 1);
    const gkSaveBoost = 0.10 + 0.18*gkSkill; // 0.10..0.28

    let goalProb = shooterQ + attackBoost - pressurePenalty - blockPenalty - contactAdj - gkSaveBoost;
    // Global calibration to keep typical handball scores realistic (approx. 55–60 total goals)
    goalProb = goalProb * clamp(gs, 0.80, 1.25);
    goalProb = clamp(goalProb, 0.06, 0.90);

    const isGoal = rng() < goalProb;
    const isBlock = (!isGoal && shotType==='9m' && rng() < clamp(defenseProf.block*0.55, 0.02, 0.18));
    return { isGoal, isBlock, goalProb };
  }

  function resolvePossession(rng, att, def, ctx){
    const { ref, attRating, defRating, defProf, plan, state2min, tacticModsDef } = ctx;

    // Tactic mods (odbrana protivnika) – default neutral
    const tModsDef = (tacticModsDef && typeof tacticModsDef==='object') ? tacticModsDef : { tempoMul:1, stealMul:1, turnoverMul:1, twoMinMul:1, sevenMMul:1 };

    // Base probabilities
    let pTurn = 0.12;
    let pFoul = defProf.foul; // roughly 0.16..0.19
    let pShot = 1 - pTurn - pFoul;

    // Pressure increases turnovers and fouls
    pTurn += defProf.pressure*0.06;
    pFoul += defProf.pressure*0.04;

    // Skill gap
    const gap = clamp((attRating.teamPower - defRating.teamPower)/8, -0.25, 0.25);
    pTurn -= gap*0.10; // stronger attack -> fewer turnovers
    pShot += gap*0.08;

    // Centralized tactic mods (single source of truth)
    const __mods = (typeof window!=='undefined' && window.getTacticMods) ? window.getTacticMods(window.gameState) : null;
    if(__mods && typeof __mods.turnoverDelta==='number'){
      pTurn += __mods.turnoverDelta;
    }

    // 2-minute exclusion weakens defense
    if(state2min?.defIsDown){
      pTurn -= 0.03;
      pShot += 0.04;
      pFoul += 0.01; // desperation
    }

    // Referee strictness increases fouls called
    pFoul += (ref.strictness/100)*0.03;
    pTurn += ((ref.passive_strictness-50)/100)*0.02; // more passive calls -> more forced bad endings
    // Tactic mods: odbrana utiče na učestalost tehničkih (turnover)
    pTurn *= clamp(toNum(tModsDef.turnoverMul,1), 0.7, 1.4);

    // Normalize
    const sum = pTurn + pFoul + pShot;
    pTurn = clamp(pTurn/sum, 0.06, 0.26);
    pFoul = clamp(pFoul/sum, 0.10, 0.28);
    pShot = clamp(1-pTurn-pFoul, 0.50, 0.82);

    const outcome = pickWeighted(rng, [
      ['turnover', pTurn],
      ['foul', pFoul],
      ['shot', pShot]
    ]);

    // Decide shot type based on plan and defense
    function chooseShotType(){
      // Baseline mix
      let w9 = 0.45, w6 = 0.22, ww = 0.18, wf = 0.15;
      const d = normalizeDefense(def?.tactics?.defense || ctx.defShape);

      if(d==='6-0'){
        w9 += 0.08; w6 -= 0.06;
      } else if(d==='3-2-1'){
        wf += 0.06; w9 -= 0.04; w6 += 0.02;
      } else if(d==='5-1'){
        w9 -= 0.02; w6 += 0.02; ww += 0.02;
      }

      if(plan==='PIVOT_SCREEN_9M'){
        w9 += 0.08; w6 -= 0.03;
      }
      if(plan==='FOUR_BACKS'){
        w9 += 0.04; ww += 0.03; w6 -= 0.03;
      }
      if(plan==='FAST_SWITCH'){
        ww += 0.06; w9 += 0.02; w6 -= 0.03;
      }
      if(plan==='BEHIND_FRONT'){
        w6 += 0.04; w9 += 0.02; ww += 0.02;
      }

      // Apply centralized shot weights (focus/width/transition) via getTacticMods(gameState)
      const __mods2 = (typeof window!=='undefined' && window.getTacticMods) ? window.getTacticMods(window.gameState) : null;
      if(__mods2 && __mods2.shotWeights){
        const sw = __mods2.shotWeights;
        const s0 = w9+w6+ww+wf;
        const b9 = w9/s0, b6 = w6/s0, bw = ww/s0, bf = wf/s0;
        const mix = 0.35; // keep defense/plan influence
        const n9 = b9*(1-mix) + (sw.backcourt||b9)*mix;
        const n6 = b6*(1-mix) + (sw.pivot||b6)*mix;
        const nw = bw*(1-mix) + (sw.wings||bw)*mix;
        const nf = bf*(1-mix) + (sw.breakthrough||bf)*mix;
        w9 = n9; w6 = n6; ww = nw; wf = nf;
      }

      // Make sure all positive
      w9 = Math.max(0.05, w9); w6 = Math.max(0.05, w6); ww = Math.max(0.05, ww); wf = Math.max(0.05, wf);
      const s = w9+w6+ww+wf;
      const k = pickWeighted(rng, [
        ['9m', w9/s],
        ['6m', w6/s],
        ['wing', ww/s],
        ['fastbreak', wf/s]
      ]);
      return k;
    }

    if(outcome==='turnover'){
      const baseStealP = clamp(defProf.intercept + (defRating.teamPower/50), 0.07, 0.26);
      const stealP = clamp(baseStealP * clamp(toNum(tModsDef.stealMul,1),0.7,1.4), 0.05, 0.40);
      const isSteal = rng() < stealP;
      return { kind:'turnover', sub: isSteal ? 'steal' : 'technical' };
    }

    if(outcome==='foul'){
      // Determine if foul stops clear chance
      const clearChance = rng() < clamp(0.22 + (attRating.teamPower/40) - (defRating.teamPower/60), 0.12, 0.34);
      const sev = clamp(0.35 + defProf.pressure*0.35 + (rng()-0.5)*0.15, 0.10, 0.95);
      // Tactic mods: 7m i 2min indirektno zavise od odbrane protivnika
      const base7mP = foulTo7mChance(ref, clearChance);
      const p7mEff = clamp(base7mP * clamp(toNum(tModsDef.sevenMMul,1),0.7,1.4), 0.00, 0.95);
      const to7m = rng() < p7mEff;

      const baseCardP = foulToCardChance(ref, sev, clearChance);
      const p2mEff = clamp(baseCardP * clamp(toNum(tModsDef.twoMinMul,1),0.7,1.4), 0.00, 0.95);
      const toCard = rng() < p2mEff;
      return { kind:'foul', clearChance, to7m, toCard, severity: sev };
    }

    // Shot
    const shotType = chooseShotType();

    // Attack boost by plan
    let attackBoost = 0;
    if(plan==='PIVOT_SCREEN_9M' && shotType==='9m') attackBoost += 0.05;
    if(plan==='FOUR_BACKS' && (shotType==='9m' || shotType==='wing')) attackBoost += 0.03;
    if(plan==='FAST_SWITCH' && shotType==='wing') attackBoost += 0.06;
    if(plan==='BEHIND_FRONT' && (shotType==='6m' || shotType==='9m')) attackBoost += 0.04;

    // Stronger team makes better selections
    attackBoost += clamp((attRating.teamPower - 10)/200, -0.03, 0.05);
    if(state2min?.defIsDown) attackBoost += 0.03;

    const shooter = chooseShooter(attRating.start, shotType==='9m'?'9m':shotType, rng);
    const gk = goalkeeper(defRating);
    const res = resolveShot(rng, shooter, gk, shotType==='9m'?'9m':shotType, attackBoost, defProf, ref, ctx.goalScale);
    return { kind:'shot', shotType, shooter, gk, ...res };
  }

  // --------------------------
  // Main simulation
  // --------------------------
  function simulateMatch(teamA, teamB, options){
    const opt = options && typeof options === 'object' ? options : {};
    const baseSeed = seedFromString(opt.seed ?? `${teamName(teamA)}|${teamName(teamB)}|${Date.now()}`);

    // Engine context multipliers (staff etc.)
    const ctxA = opt.engineContextA || null;
    const ctxB = opt.engineContextB || null;

    // Calibration targets (modern handball typical: ~55–60 total goals)
    const calib = opt.calibration && typeof opt.calibration==='object' ? opt.calibration : {};
    const targetTotalGoals = toNum(calib.targetTotalGoals, 58);
    const minTotalGoals = toNum(calib.minTotalGoals, 50);
    const maxTotalGoals = toNum(calib.maxTotalGoals, 66);

    function simulateOnce(seed, goalScale){
      const rng = mulberry32(seed);

      const ref = resolveReferee(opt, rng);

      const aRating = computeTeamRatings(teamA, ctxA);
      const bRating = computeTeamRatings(teamB, ctxB);

      const effTeamTactics = (team, optTac) => {
        const tNext = team && (team.tacticsNext || team.tactics_next || team.nextTactics);
        const tBase = team && (team.tacticsBase || team.tactics_base || team.tactics);
        const src = optTac || tNext || tBase || {};
        // allow nested {defense, attack,...} or alternative keys
        return {
          defense: normalizeDefense(src.defense ?? src.defenseSystem ?? src.def ?? '6-0'),
          defenseMode: String(src.defenseMode ?? src.defense_mode ?? src.mode ?? 'standard'),
          attack: normalizeAttack(src.attack ?? src.attackSystem ?? src.att ?? 'balanced'),
          tempo: String(src.tempo ?? src.gameTempo ?? 'normal'),
          // Novi parametri iz taktičkog panela (ako postoje)
          defenseFormation: String(src.defenseFormation ?? src.defense ?? src.defenseSystem ?? src.def ?? '6-0'),
          agresivnost: toNum(src.agresivnost ?? src.aggression ?? src.aggr ?? 3, 3)
        };
      };

      const tacticsA = effTeamTactics(teamA, opt.tacticsA);
      const tacticsB = effTeamTactics(teamB, opt.tacticsB);

      // KORAK 2: Izračunaj tactic mods iz trenutno aktivne taktike (A i B)
      const modsA = buildTacticMods(tacticsA);
      const modsB = buildTacticMods(tacticsB);

      const stats = {
        meta: {
          seed,
          goalScale,
          calibration: { targetTotalGoals, minTotalGoals, maxTotalGoals },
          referee: { ...ref },
          teams: [teamName(teamA), teamName(teamB)],
          tactics: { A: tacticsA, B: tacticsB }
        },
        score: { A:0, B:0 },
        shots: { A:{'9m':0,'6m':0,'wing':0,'fastbreak':0,'7m':0}, B:{'9m':0,'6m':0,'wing':0,'fastbreak':0,'7m':0} },
        goals: { A:{'9m':0,'6m':0,'wing':0,'fastbreak':0,'7m':0}, B:{'9m':0,'6m':0,'wing':0,'fastbreak':0,'7m':0} },
        saves: { A:0, B:0 },
        blocks: { A:0, B:0 },
        turnovers: { A:{total:0, steal:0, technical:0}, B:{total:0, steal:0, technical:0} },
        steals: { A:0, B:0 },
        fouls: { A:0, B:0 },
        twoMin: { A:0, B:0 },
        sevenM: { A:0, B:0 },
        timeline: []
      };

      // Pace model (affects possessions by shrinking/expanding action time)
      function tempoMult(t){
        const s = String(t||'normal').toLowerCase();
        if(s.includes('slow') || s.includes('sporo')) return 0.92;
        if(s.includes('fast') || s.includes('brzo')) return 1.06;
        return 1.00;
      }
      const paceA = tempoMult(tacticsA.tempo);
      const paceB = tempoMult(tacticsB.tempo);

      // Defensive styles can speed up the game
      const dPaceA = (normalizeDefense(tacticsA.defense)==='3-2-1') ? 1.05 : 1.00;
      const dPaceB = (normalizeDefense(tacticsB.defense)==='3-2-1') ? 1.05 : 1.00;

      const globalPace = clamp(((paceA+paceB)/2) * ((dPaceA+dPaceB)/2), 0.90, 1.15);

      // 2-minute state: track remaining possessions while a team is down a player
      const twoMinState = { A_down: 0, B_down: 0 };

      // Simulate alternating possessions with a game clock
      let timeSec = 0;
      let nextTeam = (rng() < 0.5) ? 'A' : 'B';

      function logEvent(e){
        if(stats.timeline.length < 140) stats.timeline.push(e);
      }

      function advanceTime(kind, tempoEff){
        tempoEff = (typeof tempoEff==='number' && isFinite(tempoEff) && tempoEff>0) ? tempoEff : 1.0;
        let dt;
        if(kind==='fastbreak') dt = 8 + Math.floor(rng()*6);
        else if(kind==='shot') dt = 18 + Math.floor(rng()*14);
        else if(kind==='foul') dt = 16 + Math.floor(rng()*12);
        else dt = 14 + Math.floor(rng()*12);

        // Some stoppage time variability
        dt += Math.floor((rng()-0.5)*6);

        // Pace adjustment: faster -> more possessions, slower -> fewer
        dt = dt / globalPace;
        // Tactic tempo: kombinacija napada (A/B) i odbrane protivnika
        dt = dt / tempoEff;

        dt = clamp(Math.round(dt), 6, 35);
        timeSec += dt;
        if(timeSec > 60*60) timeSec = 60*60;
      }

      // Play until 60:00 (cap iterations for safety)
      const maxPossessions = 420;
      for(let i=0;i<maxPossessions && timeSec < 60*60; i++){
        const isA = (nextTeam==='A');
        const attTeam = isA ? teamA : teamB;
        const defTeam = isA ? teamB : teamA;
        const attRating = isA ? aRating : bRating;
        const defRating = isA ? bRating : aRating;
        const defShape = isA ? tacticsB.defense : tacticsA.defense; // defender's shape
        const defMode = isA ? tacticsB.defenseMode : tacticsA.defenseMode;
        const attStyle = isA ? tacticsA.attack : tacticsB.attack;
        const defProf = defenseProfile(defShape, defMode);
        const plan = attackPlanAgainst(defShape, attStyle);


        // Tactic mods: napad (att) i odbrana (def)
        const attMods = isA ? modsA : modsB;
        const defMods = isA ? modsB : modsA;
        // Efektivni tempo po posedu (kombinacija oba tima)
        let tempoEff = clamp((attMods.tempoMul + defMods.tempoMul)/2, 0.7, 1.4);
        const __modsP = (typeof window!=='undefined' && window.getTacticMods) ? window.getTacticMods(window.gameState) : null;
        if(__modsP && typeof __modsP.paceMultiplier==='number'){
          // applies to user's team pacing; if you later track home/away user team, gate it here
          tempoEff = clamp(tempoEff * __modsP.paceMultiplier, 0.55, 1.7);
        }

        const defIsDown = isA ? (twoMinState.B_down>0) : (twoMinState.A_down>0);
        const ctx = {
          ref,
          attRating,
          defRating,
          defProf,
          plan,
          defShape,
          state2min: { defIsDown },
          // Prosleđujemo tactic mods u resolvePossession (bez UI promena)
          tacticModsAtt: attMods,
          tacticModsDef: defMods,
          goalScale
        };

        const res = resolvePossession(rng, attTeam, defTeam, ctx);

        const tMin = Math.floor(timeSec/60);
        const tSec = timeSec % 60;
        const stamp = `${String(tMin).padStart(2,'0')}:${String(tSec).padStart(2,'0')}`;

        if(res.kind==='turnover'){
          const side = isA ? 'A' : 'B';
          stats.turnovers[side].total++;
          stats.turnovers[side][res.sub]++;
          if(res.sub==='steal') stats.steals[side]++;
          logEvent({ t:stamp, team: side, e:'TO', sub:res.sub });
          advanceTime('turnover', tempoEff);
        }
        else if(res.kind==='foul'){
          const sideD = isA ? 'B' : 'A';
          const sideA = isA ? 'A' : 'B';
          stats.fouls[sideD]++;
          logEvent({ t:stamp, team: sideD, e:'FOUL', c: res.clearChance ? 1:0 });

          // Cards / 2-min
          if(res.toCard){
            stats.twoMin[sideD]++;
            // approximate: 2 min == ~2 possessions while down
            if(sideD==='A') twoMinState.A_down = Math.max(twoMinState.A_down, 2);
            else twoMinState.B_down = Math.max(twoMinState.B_down, 2);
            logEvent({ t:stamp, team: sideD, e:'2MIN' });
          }

          // 7m or just free throw continuation
          if(res.to7m){
            stats.sevenM[sideA]++;
            stats.shots[sideA]['7m']++;
            const shooter = chooseShooter(attRating.start, '7m', rng);
            const gk = goalkeeper(defRating);
            const shotRes = resolveShot(rng, shooter, gk, '7m', 0.02, defProf, ref, goalScale);
            if(shotRes.isGoal){
              stats.score[sideA]++;
              stats.goals[sideA]['7m']++;
              logEvent({ t:stamp, team: sideA, e:'7M_GOAL' });
            } else {
              stats.saves[sideD]++;
              logEvent({ t:stamp, team: sideA, e:'7M_SAVE' });
            }
            advanceTime('shot', tempoEff);
          } else {
            advanceTime('foul', tempoEff);
          }
        }
        else if(res.kind==='shot'){
          const sideA = isA ? 'A' : 'B';
          const sideD = isA ? 'B' : 'A';
          const st = res.shotType;
          stats.shots[sideA][st]++;
          if(res.isGoal){
            stats.score[sideA]++;
            stats.goals[sideA][st]++;
            logEvent({ t:stamp, team: sideA, e:'GOAL', st });
          } else {
            // save or block
            if(res.isBlock){
              stats.blocks[sideD]++;
              logEvent({ t:stamp, team: sideD, e:'BLOCK', st });
            } else {
              stats.saves[sideD]++;
              logEvent({ t:stamp, team: sideD, e:'SAVE', st });
            }
          }
          advanceTime(st==='fastbreak' ? 'fastbreak' : 'shot');
        }

        // Decrease 2-min counters each possession
        if(twoMinState.A_down>0) twoMinState.A_down--;
        if(twoMinState.B_down>0) twoMinState.B_down--;

        // Alternate possession (simple)
        nextTeam = isA ? 'B' : 'A';
      }

      
      // --- Post-process shooting stats to keep conversion realistic (without changing goals) ---
      (function normalizeReportedShooting(){
        try{
          const s = stats;
          const seed2 = (seed ^ 0xA5A5A5A5) >>> 0;
          const rng2 = mulberry32(seed2);

          function sideTotals(side){
            const g = s.goals[side];
            const sh = s.shots[side];
            const goalTotal = Object.values(g).reduce((a,b)=>a+(Number(b)||0),0);
            const shotTotal = Object.values(sh).reduce((a,b)=>a+(Number(b)||0),0);
            return { goalTotal, shotTotal };
          }

          function adjustSide(side){
            const { goalTotal, shotTotal } = sideTotals(side);
            if(goalTotal <= 0 || shotTotal <= 0) return;

            // Target conversion ~58–63% with tiny deterministic jitter
            let conv = 0.605 + (rng2()-0.5)*0.04; // 0.585..0.625
            // Clamp for sanity
            conv = clamp(conv, 0.56, 0.68);

            let desiredShots = Math.round(goalTotal / conv);
            desiredShots = clamp(desiredShots, goalTotal + 6, goalTotal + 28);

            // If already reasonable, do nothing
            const curConv = goalTotal / Math.max(1, shotTotal);
            if(curConv >= 0.54 && curConv <= 0.72 && Math.abs(shotTotal - desiredShots) <= 6) return;

            const scale = desiredShots / shotTotal;
            const types = ['9m','6m','wing','fastbreak','7m'];

            // Scale down shots per type but never below goals per type
            let newShots = {};
            for(const t of types){
              const cur = Number(s.shots[side][t])||0;
              const g = Number(s.goals[side][t])||0;
              const val = Math.max(g, Math.round(cur * scale));
              newShots[t] = val;
            }

            // Fix rounding to match desiredShots (keep >= goals)
            const sumNew = ()=> types.reduce((a,t)=>a + (Number(newShots[t])||0),0);
            let curSum = sumNew();
            function incOne(){
              // add to most-used non-7m type
              const cand = types.filter(t=>t!=='7m').sort((a,b)=>(s.shots[side][b]||0)-(s.shots[side][a]||0));
              const t = cand[0] || '9m';
              newShots[t] = (newShots[t]||0) + 1;
            }
            function decOne(){
              // remove from a type where shots > goals (prefer biggest surplus)
              let bestT = null, bestSur = 0;
              for(const t of types){
                const sur = (newShots[t]||0) - (Number(s.goals[side][t])||0);
                if(sur > bestSur){ bestSur = sur; bestT = t; }
              }
              if(bestT){ newShots[bestT]--; return true; }
              return false;
            }
            while(curSum < desiredShots){ incOne(); curSum = sumNew(); }
            while(curSum > desiredShots){
              const ok = decOne();
              if(!ok) break;
              curSum = sumNew();
            }

            // Commit
            for(const t of types) s.shots[side][t] = newShots[t];
          }

          adjustSide('A');
          adjustSide('B');

          // Reconcile saves/blocks with new misses (every miss is save or block in this v1)
          function setDefTotals(defSide, missTotal){
            missTotal = Math.max(0, Math.round(missTotal));
            const curS = Number(s.saves[defSide])||0;
            const curB = Number(s.blocks[defSide])||0;
            const denom = Math.max(1, curS + curB);
            const blockShare = clamp(curB / denom, 0.05, 0.35);
            const newB = Math.round(missTotal * blockShare);
            const newS = missTotal - newB;
            s.blocks[defSide] = newB;
            s.saves[defSide] = newS;
          }
          const goalsA = Object.values(s.goals.A).reduce((a,b)=>a+(Number(b)||0),0);
          const goalsB = Object.values(s.goals.B).reduce((a,b)=>a+(Number(b)||0),0);
          const shotsA = Object.values(s.shots.A).reduce((a,b)=>a+(Number(b)||0),0);
          const shotsB = Object.values(s.shots.B).reduce((a,b)=>a+(Number(b)||0),0);

          setDefTotals('A', shotsB - goalsB);
          setDefTotals('B', shotsA - goalsA);
        }catch(e){
          // never break match result due to cosmetics
        }
      })();

const result = {
        ok: true,
        winner: (stats.score.A===stats.score.B) ? 'draw' : (stats.score.A>stats.score.B ? 'A' : 'B'),
        score: [stats.score.A, stats.score.B],
        teams: [teamName(teamA), teamName(teamB)],
        ratings: {
          A: { teamPower: aRating.teamPower, startOVR: aRating.startOVR, fit:aRating.fit, morale:aRating.mor },
          B: { teamPower: bRating.teamPower, startOVR: bRating.startOVR, fit:bRating.fit, morale:bRating.mor }
        },
        stats
      };
      return result;
    }

    // First pass
    const r1 = simulateOnce(baseSeed, 1.0);
    const tg1 = (r1?.stats?.score?.A||0) + (r1?.stats?.score?.B||0);

    // If too low/high, do one calibration re-run (deterministic)
    let goalScale = 1.0;
    if(tg1 > 0){
      goalScale = clamp(targetTotalGoals / tg1, 0.85, 1.20);
    }
    const needRe = (tg1 < minTotalGoals || tg1 > maxTotalGoals || Math.abs(1-goalScale) > 0.06);

    if(!needRe) return r1;

    const r2 = simulateOnce((baseSeed ^ 0x9E3779B9) >>> 0, goalScale);
    return r2;
  }
  function simulateFromState(state, opponentTeam, options){
    const r = (window.HM_TEAM && window.HM_TEAM.resolve) ? window.HM_TEAM.resolve(state) : null;
    const myTeam = r?.team || state?.clubData || state?.career?.clubData || null;
    const opp = opponentTeam || null;
    const ctx = (window.HM_ENGINE && window.HM_ENGINE.get) ? window.HM_ENGINE.get(state) : null;
    const merged = { ...(options||{}) };
    // use staff multipliers from current state for our team
    merged.engineContextA = ctx;
    return simulateMatch(myTeam, opp, merged);
  }

  const defaults = {
    referee: {
      strictness: 50,
      advantage_bias: 55,
      passive_strictness: 55,
      line_tolerance: 50
    },
    tacticsA: { defense:'6-0', defenseMode:'standard', attack:'balanced', tempo:'normal' },
    tacticsB: { defense:'6-0', defenseMode:'standard', attack:'balanced', tempo:'normal' }
  };

  window.HM_MATCH = {
    defaults,
    simulateMatch,
    simulateFromState,
    buildTacticMods
  };
})();
