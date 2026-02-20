
// === HM helper: resolve club name for a player (for profile cards) ===
function hmGetClubNameForPlayer(player, db){
  try{
    if(!db) db = (window.HM_DB || window.DB || window.db || null);
    if(!db) return "";
    const clubs = db.clubs || db.klubovi || db.teams || {};
    const key = player.clubKey || player.clubId || player.club || player.teamKey || player.teamId;
    if(key && clubs[key] && clubs[key].name) return clubs[key].name;
    // If player stores club name directly
    if(player.clubName) return player.clubName;
    // Try search by id inside clubs
    if(key){
      for(const k in clubs){
        const c = clubs[k];
        if(c && (c.id===key || c.key===key) && c.name) return c.name;
      }
    }
    return "";
  }catch(e){ return ""; }
}


function moraleToArrow(morale){
  if(morale <= 5) return {arrow:"↓", cls:"morale-bad"};
  if(morale <= 10) return {arrow:"↘", cls:"morale-low"};
  if(morale <= 15) return {arrow:"→", cls:"morale-neutral"};
  if(morale <= 20) return {arrow:"↗", cls:"morale-good"};
  return {arrow:"↑", cls:"morale-excellent"};
}


function moraleModifier(morale){
  // Spec: 0.85 + (Moral / 100), Moral is 1–25
  return 0.85 + ((morale||15) / 100);
}
function avgVals(values){
  if(!values || !values.length) return 0;
  const sum = values.reduce((a,b)=>a+b,0);
  return sum / values.length;
}
function calcCategoryScores(attrs){
  if(!attrs) return { physical:0, mental:0, attack:0, defense:0, gk:0 };
  const ph = attrs.physical || {};
  const me = attrs.mental || {};
  const of = attrs.offense || {};
  const df = attrs.defense || {};
  const gk = attrs.goalkeeping || {};

  const physical = avgVals([ph.brzina, ph.eksplozivnost, ph.snaga, ph.izdrzljivost, ph.balans, ph.agilnost].filter(v=>v!=null));
  const mental   = avgVals([me.odlucivanje, me.koncentracija, me.smirenost, me.radnaEtika, me.liderstvo, me.pozicioniranje, me.disciplina].filter(v=>v!=null));
  const attack   = avgVals([of.sutSpolja, of.sutIzSkoka, of.sutSaKrila, of.prodor1na1, of.igraSaPivotom, of.finta, of.pregledIgre, of.tehnika].filter(v=>v!=null));
  const defense  = avgVals([df.duelIgra, df.blokiranje, df.bocnaKretnja, df.anticipacija, df.tvrdoca, df.timskaOdbrana, df.kontrolaFaula].filter(v=>v!=null));
  const gkScore  = avgVals([gk.refleksi, gk.postavljanje, gk.jedanNaJedan, gk.odbraneSaKrila, gk.odbraneSpolja, gk.kontrolaOdbijeneLopte, gk.igraNogom, gk.mentalnaStabilnost].filter(v=>v!=null));

  return { physical, mental, attack, defense, gk: gkScore };
}


/* ====================================================================
   SEASON STATS ENGINE (internal) — do NOT render these rules in UI
   Implements the spec provided by user for tracking per-match & season stats
==================================================================== */

function emptyPlayerSeason(){
  return {
    gamesPlayed: 0,
    ratingSum: 0,

    goals: 0,
    assists: 0,
    shots: 0,

    duelsWon: 0,
    blocks: 0,
    steals: 0,

    minutesTotal: 0,
    missedInjury: 0,
    missedSuspended: 0,
    missedDNP: 0,

    twoMinTotal: 0,
    redTotal: 0,
    techErrTotal: 0
  };
}

function ensurePlayerSeasonState(player){
  if(!player) return emptyPlayerSeason();
  if(!player.season || typeof player.season !== 'object'){
    player.season = emptyPlayerSeason();
  }else{
    // Backward compatible fill for older saves
    const d = emptyPlayerSeason();
    Object.keys(d).forEach(k=>{
      if(typeof player.season[k] === 'undefined') player.season[k] = d[k];
    });
  }
  return player.season;
}

function per60(value, minutes){
  return value * (60 / Math.max(12, minutes));
}

function calculateMatchRating(match){
  if(!match || match.status !== "PLAYED") return null;

  const g60  = per60(match.goals||0, match.min||0);
  const a60  = per60(match.assists||0, match.min||0);
  const te60 = per60(match.techErr||0, match.min||0);
  const d60  = per60(match.duelsWon||0, match.min||0);
  const b60  = per60(match.blocks||0, match.min||0);
  const s60  = per60(match.steals||0, match.min||0);
  const tm60 = per60(match.twoMin||0, match.min||0);

  const shotAccuracy = (match.shots||0) > 0 ? (match.goals||0) / (match.shots||0) : 0;

  const ATT =
    2.2 * g60 +
    1.6 * a60 +
    0.7 * (shotAccuracy * 10) -
    2.0 * te60;

  const DEF =
    1.7 * d60 +
    1.2 * b60 +
    1.5 * s60 -
    1.8 * tm60 -
    6.0 * (match.red||0);

  const RAW = 50 + ATT + DEF;

  return clamp(1, 20, Math.round(RAW / 5));
}

function applyMatchToSeason(playerSeason, match){
  if(!playerSeason) return;

  if(match && match.status === "PLAYED"){
    const rating = calculateMatchRating(match);

    playerSeason.gamesPlayed += 1;
    playerSeason.ratingSum += (rating || 0);

    playerSeason.goals += (match.goals||0);
    playerSeason.assists += (match.assists||0);
    playerSeason.shots += (match.shots||0);

    playerSeason.duelsWon += (match.duelsWon||0);
    playerSeason.blocks += (match.blocks||0);
    playerSeason.steals += (match.steals||0);

    playerSeason.minutesTotal += (match.min||0);

    playerSeason.twoMinTotal += (match.twoMin||0);
    playerSeason.redTotal += (match.red||0);
    playerSeason.techErrTotal += (match.techErr||0);

  } else {
    const st = (match && match.status) ? match.status : "DNP";
    if(st === "INJURED") playerSeason.missedInjury += 1;
    if(st === "SUSPENDED") playerSeason.missedSuspended += 1;
    if(st === "DNP") playerSeason.missedDNP += 1;
  }
}

function getSeasonStats(playerSeason){
  const ps = playerSeason || emptyPlayerSeason();
  const gamesMissed = (ps.missedInjury||0) + (ps.missedSuspended||0) + (ps.missedDNP||0);

  return {
    avgRating: (ps.gamesPlayed||0) > 0 ? (ps.ratingSum / ps.gamesPlayed).toFixed(2) : 0,

    goalsAssists: (ps.goals||0) + (ps.assists||0),
    goalsPerGame: (ps.gamesPlayed||0) > 0 ? ((ps.goals||0) / ps.gamesPlayed).toFixed(2) : 0,
    shotAccuracy: (ps.shots||0) > 0 ? (((ps.goals||0) / ps.shots) * 100).toFixed(1) : 0,

    duelsWon: ps.duelsWon||0,
    blocks: ps.blocks||0,
    steals: ps.steals||0,

    minutesTotal: ps.minutesTotal||0,
    gamesPlayed: ps.gamesPlayed||0,
    gamesMissed: gamesMissed,

    twoMin: ps.twoMinTotal||0,
    red: ps.redTotal||0,
    techErrors: ps.techErrTotal||0
  };
}

// Convenience wrapper (future match engine will call this)
function applyMatchToPlayer(player, match){
  const ps = ensurePlayerSeasonState(player);
  applyMatchToSeason(ps, match);
}

function positionWeights(pos){
  // Spec weights
  if(pos==='LW' || pos==='RW') return { attack:0.40, physical:0.25, mental:0.15, defense:0.20 };
  if(pos==='LB' || pos==='RB' || pos==='CB') return { attack:0.35, defense:0.25, mental:0.20, physical:0.20 };
  if(pos==='PIV') return { physical:0.35, defense:0.30, attack:0.20, mental:0.15 };
  if(pos==='GK') return { gk:0.70, mental:0.20, physical:0.10 };
  // fallback (treat as back)
  return { attack:0.35, defense:0.25, mental:0.20, physical:0.20 };
}
function calcOverallFromScores(pos, scores, morale){
  const w = positionWeights(pos);
  const mm = moraleModifier(morale);
  if(pos==='GK'){
    const base = (scores.gk*w.gk) + (scores.mental*w.mental) + (scores.physical*w.physical);
    return base * mm;
  }
  const base = (scores.attack*w.attack) + (scores.defense*w.defense) + (scores.mental*w.mental) + (scores.physical*w.physical);
  return base * mm;
}

function ensurePlayerAttributes(p){
  if(!p) return;
  if(!p.club && state && state._selectedClub){ p.club = state._selectedClub.name; }

  if(!p.attributes || typeof p.attributes !== 'object'){
    p.attributes = buildPlayerAttributes(p);
  }

  // Ensure groups exist + numeric clamp 1..20
  const groups = ['offense','defense','physical','mental','goalkeeping'];
  for(const g of groups){
    if(!p.attributes[g] || typeof p.attributes[g] !== 'object') p.attributes[g] = {};
    const obj = p.attributes[g];
    for(const k of Object.keys(obj)){
      obj[k] = toNumClamp(obj[k], 1, 20, 10);
      obj[k] = Math.round(obj[k]);
    }
  }

  enforceMax20Limit(p);
  enforceOverallCeil(p);

  if(!p.specialties) p.specialties = computeSpecialties(p);
}
function getDisplayedOverall(p, kind){
  // kind: 'NT' or 'CLUB'
  ensurePlayerAttributes(p);
  const ctx = (kind==='NT') ? (state._ctxNT || { goalsText:'', pressureNum:3 }) : (state._ctxClub || { goalsText:'', pressureNum:3 });
  const morale = getMorale(p, ctx.goalsText, ctx.pressureNum);
  const scores = calcCategoryScores(p.attributes);
  return Math.min(18, Math.round(calcOverallFromScores(p.pos, scores, morale)));
}



// ---------- Player profile (FM-like card) ----------
const POS_LABEL = {
  GK: 'Golman',
  LW: 'Levo krilo',
  RW: 'Desno krilo',
  LB: 'Levi bek',
  RB: 'Desni bek',
  CB: 'Centralni bek',
  PIV:'Pivot'
};

const PLAYER_TYPES = [
  'Šuter', 'Defanzivac', 'Ofanzivac', 'Fajter', 'Kreativac', 'Vođa', 'Bloker', 'Golgeter',
  'Organizator igre', 'Specijalista za 7m', 'Kontraš', 'Sidro odbrane', 'Specijalista za blok',
  'Šuter iz skoka', 'Prvi korak (prodor)', 'Asistent'
];

function clamp20(n){ return clamp(n, 1, 20); }

// --- Realism caps (global) ---
// No player should display overall > 18, to keep growth room.
// Also limit how many max(20) attributes a player can have.
function flattenAttrRefs(attrs){
  const out = [];
  if(!attrs) return out;
  const groups = ['offense','defense','physical','mental','goalkeeping'];
  for(const g of groups){
    const obj = attrs[g];
    if(!obj || typeof obj !== 'object') continue;
    for(const k of Object.keys(obj)){
      out.push([obj, k]);
    }
  }
  return out;
}
function enforceMax20Limit(p){
  if(!p || !p.attributes) return;
  const refs = flattenAttrRefs(p.attributes);
  // Count exactly-20 ratings
  const maxRefs = refs.filter(([obj,k]) => Number(obj[k]) === 20);
  // Only TOP tier players may have up to 12 "20" ratings.
  // Others should have notably fewer for realism.
  const tier = (p.tier || '').toString().toUpperCase();
  const allowed = tier === 'TOP' ? 12 : (tier === 'MID' ? 6 : 3);
  if(maxRefs.length <= allowed) return;

  // Deterministic downgrade order (so saves stay stable)
  maxRefs.sort((a,b)=>{
    const ak = a[1], bk = b[1];
    return ak.localeCompare(bk);
  });

  for(let i=allowed; i<maxRefs.length; i++){
    const [obj,k] = maxRefs[i];
    obj[k] = 19; // drop from perfect to near-perfect
  }
}
function enforceOverallCeil(p){
  // Keep underlying base overall <= 18 as well
  if(!p) return;
  if(Number.isFinite(Number(p.overall))) p.overall = Math.min(18, Number(p.overall));
  if(Number.isFinite(Number(p.baseOverall))) p.baseOverall = Math.min(18, Number(p.baseOverall));
}

function posHandBias(pos, seed){
  const r = seeded01(seed);
  if(pos==='RW') return (r < 0.70) ? 'Leva' : (r < 0.92 ? 'Desna' : 'Obe');
  if(pos==='LW') return (r < 0.70) ? 'Desna' : (r < 0.92 ? 'Leva' : 'Obe');
  if(pos==='GK') return (r < 0.88) ? 'Desna' : 'Leva';
  if(pos==='PIV') return (r < 0.55) ? 'Desna' : (r < 0.85 ? 'Obe' : 'Leva');
  return (r < 0.62) ? 'Desna' : (r < 0.90 ? 'Leva' : 'Obe');
}


function applyProfileTweaks(p, bundle){
  const profile = p.profile || 'BALANCED';
  const starKey = p.starKey || null;

  function bumpGroup(group, delta){
    if(!group) return;
    Object.keys(group).forEach(k=>{
      group[k] = clamp20(group[k] + delta);
    });
  }
  function bumpKeys(group, keys, delta){
    if(!group) return;
    keys.forEach(k=>{
      if(group[k]!=null) group[k] = clamp20(group[k] + delta);
    });
  }

  // Profile deltas (handball/FM-like realism) — updated to NEW attribute set
  if(profile === 'TWO_WAY'){
    bumpGroup(bundle.offense, +1);
    bumpGroup(bundle.defense, +1);
    bumpGroup(bundle.mental, +1);
  } else if(profile === 'ATTACK'){
    bumpGroup(bundle.offense, +2);
    bumpGroup(bundle.defense, -2);
    bumpKeys(bundle.mental, ['odlucivanje','smirenost'], +1);
    bumpKeys(bundle.offense, ['pregledIgre','tehnika'], +1);
  } else if(profile === 'DEFENSE'){
    bumpGroup(bundle.defense, +2);
    bumpGroup(bundle.offense, -2);
    bumpKeys(bundle.physical, ['snaga','izdrzljivost','eksplozivnost','balans'], +1);
    bumpKeys(bundle.mental, ['koncentracija','radnaEtika','disciplina','pozicioniranje'], +1);
  } else if(profile === 'GK_ELITE'){
    bumpGroup(bundle.goalkeeping, +2);
    bumpGroup(bundle.mental, +1);
    bumpKeys(bundle.physical, ['izdrzljivost','eksplozivnost','agilnost'], +1);
    bumpKeys(bundle.goalkeeping, ['mentalnaStabilnost'], +1);
  } else if(profile === 'GK_POTENTIAL'){
    bumpGroup(bundle.goalkeeping, +1);
    bumpKeys(bundle.mental, ['koncentracija'], -1);
  } // BALANCED / GK_SOLID: no deltas

  // Star specialty: small extra bump so ⭐ feels meaningful
  if(starKey){
    const map = {
      of_: bundle.offense,
      df_: bundle.defense,
      ph_: bundle.physical,
      me_: bundle.mental,
      gk_: bundle.goalkeeping,
    };
    const prefix = starKey.slice(0,3);
    const key = starKey.slice(3); // after "of_" etc.
    const group = map[prefix];
    if(group && group[key]!=null){
      group[key] = clamp20(group[key] + 2);
    }
  }
}

function buildPlayerAttributes(p){
  // deterministic per player
  const seed = seedFrom('attr|' + (p.name||'') + '|' + (p.club||'') + '|' + (p.pos||''));
  const quality = (p.baseOverall!=null) ? p.baseOverall : ((p.overall!=null) ? p.overall : 14);
  const base = quality;

  // Position bias helpers (small nudges, keep within 1–20)
  const pos = p.pos || 'CB';
  const isWing = (pos==='LW' || pos==='RW');
  const isBack = (pos==='LB' || pos==='RB' || pos==='CB');
  const isPivot = (pos==='PIV');
  const isGK = (pos==='GK');

  function genStat(key, bias){
    const s = seedFrom(key) + seed;
    const noise = seededInt(s, -3, 3);
    const val = base + bias + noise;
    return clamp20(val);
  }
  function genStatSoft(key, bias){
    const s = seedFrom('soft|' + key) + seed;
    const noise = seededInt(s, -2, 2);
    const val = base + bias + noise;
    return clamp20(val);
  }

  // profile flags (shared across cards)
  const type = (p.type||'').toLowerCase();
  const isLeader = type.includes('lider');
  const isFighter = type.includes('fajter') || type.includes('borac');
  const isDef = type.includes('def');
  const isOff = type.includes('ofanz') || type.includes('suter') || type.includes('golget');
  const isCreator = type.includes('kreat');

  function buildMental(){
    // NEW mental attributes (1–20)
    // - Odlučivanje
    // - Koncentracija
    // - Smirenost
    // - Radna etika
    // - Liderstvo
    // - Pozicioniranje
    // - Disciplina
    // (uses shared profile flags from outer scope)

    const odlucivanje = genStatSoft('me_dec', (isCreator ? 1 : 0) + (isBack ? 1 : 0));
    const koncentracija = genStatSoft('me_conc', (isDef ? 1 : 0) + (isGK ? 1 : 0));
    const smirenost = genStatSoft('me_comp', (isLeader ? 1 : 0) + (isGK ? 1 : 0));
    const radnaEtika = genStatSoft('me_work', (isFighter ? 2 : 0) + (isDef ? 1 : 0));
    const liderstvo = genStatSoft('me_lead', (isLeader ? 3 : 0));
    const pozicioniranje = genStatSoft('me_pos', (isDef ? 1 : 0) + (isPivot ? 1 : 0));
    const disciplina = genStatSoft('me_disc', (isDef ? 1 : 0));

    return { odlucivanje, koncentracija, smirenost, radnaEtika, liderstvo, pozicioniranje, disciplina };
  }

  // --- Physical (NEW) ---
  const physical = {
    brzina: genStat('ph_speed', (isWing ? 2 : 0)),
    eksplozivnost: genStat('ph_expl', (isWing ? 1 : (isBack ? 1 : 0))),
    snaga: genStat('ph_str', (isPivot ? 2 : (isBack ? 1 : 0))),
    izdrzljivost: genStat('ph_sta', 0),
    balans: genStat('ph_bal', (isPivot ? 1 : 0)),
    agilnost: genStat('ph_agi', (isWing ? 2 : (isGK ? 1 : 0))),
  };

  const mental = buildMental();

  // --- Goalkeeper (NEW) ---
  if(isGK){
    const goalkeeping = {
      refleksi: genStat('gk_ref', +2),
      postavljanje: genStat('gk_pos', +1),
      jedanNaJedan: genStat('gk_1v1', +1),
      odbraneSaKrila: genStat('gk_wing', +1),
      odbraneSpolja: genStat('gk_out', +1),
      kontrolaOdbijeneLopte: genStat('gk_reb', 0),
      igraNogom: genStat('gk_feet', 0),
      mentalnaStabilnost: genStatSoft('gk_ment', (mental.smirenost>=15?1:0)),
    };

    // Apply profile/talent realism
    applyProfileTweaks(p, { offense:null, defense:null, physical, mental, goalkeeping });

    return { role:'GK', offense:null, defense:null, physical, mental, goalkeeping };
  }

  // --- Attack (NEW) ---
  const offense = {
    sutSpolja: genStat('of_out', (isBack ? 2 : 0)),
    sutIzSkoka: genStat('of_jump', (isBack ? 1 : 0)),
    sutSaKrila: genStat('of_wing', (isWing ? 2 : -1)),
    prodor1na1: genStat('of_1v1', (isWing ? 1 : (isBack ? 1 : 0))),
    igraSaPivotom: genStat('of_piv', (isBack ? 1 : (isPivot ? 1 : 0))),
    finta: genStat('of_feint', (isWing ? 1 : 0)),
    pregledIgre: genStatSoft('of_view', (pos==='CB' ? 2 : 0)),
    tehnika: genStat('of_tech', (isOff ? 1 : 0)),
  };

  // --- Defense (NEW) ---
  const defense = {
    duelIgra: genStat('df_duel', (isPivot ? 1 : (isBack ? 1 : 0))),
    blokiranje: genStat('df_block', (isPivot ? 2 : (isBack ? 1 : 0))),
    bocnaKretnja: genStat('df_lat', (isWing ? 1 : 0)),
    anticipacija: genStatSoft('df_anti', (isDef ? 1 : 0)),
    tvrdoca: genStat('df_tough', (isPivot ? 2 : 1)),
    timskaOdbrana: genStatSoft('df_team', (isDef ? 1 : 0)),
    kontrolaFaula: genStatSoft('df_foul', (mental.disciplina>=15 ? 1 : 0)),
  };

  // Apply profile/talent realism
  applyProfileTweaks(p, { offense, defense, physical, mental, goalkeeping:null });

  return { role:'FIELD', offense, defense, physical, mental, goalkeeping:null };

  // realism: soft-cap mental attributes by tier to avoid all-20s
  const tier = (p.tier || p.level || '').toString().toUpperCase();
  const mCap = tier.includes('TOP') ? 18 : (tier.includes('MID') ? 17 : 15);
  for(const mk of ["Odlučivanje","Koncentracija","Smirenost","Radna etika","Liderstvo","Pozicioniranje","Disciplina"]){
    if(p.attrs && p.attrs[mk] != null){
      p.attrs[mk] = Math.min(mCap, toNumClamp(p.attrs[mk], 1, 20, 10));
      p.attrs[mk] = Math.round(p.attrs[mk]);
    }
  }

}

function computeSpecialties(p){
  // Star specialties: show ⭐ next to best rating(s)
  const at = p.attributes;
  if(!at) return { keys:new Set() };
  const pairs = [];
  function pushGroup(group, prefix){
    if(!group) return;
    Object.keys(group).forEach(k=>pairs.push({k: prefix + k, v: group[k]}));
  }
  pushGroup(at.offense, 'of_');
  pushGroup(at.defense, 'df_');
  pushGroup(at.physical, 'ph_');
  pushGroup(at.mental, 'me_');
  pushGroup(at.goalkeeping, 'gk_');

  pairs.sort((a,b)=>b.v-a.v);
  const top = pairs[0]?.v ?? 0;
  const keys = new Set();
  // mark all within 1 point of best and at least 16
  pairs.forEach(pv=>{
    if(pv.v>=16 && pv.v>=top-1) keys.add(pv.k);
  });

  // ensure every player has at least one ⭐ (specialty)
  if(keys.size===0 && pairs.length){
    keys.add(pairs[0].k);
  }
  return { keys };
}

// Fetch height/weight from Wikidata (best effort, cached)
async function fetchBioFromWikidata(fullName){
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(fullName)}&language=en&format=json&origin=*`;
  const sr = await fetch(searchUrl).then(r=>r.json());
  const qid = sr?.search?.[0]?.id;
  if(!qid) return null;

  const sparql = `SELECT ?height ?weight WHERE {
    OPTIONAL { wd:${qid} wdt:P2048 ?height. }
    OPTIONAL { wd:${qid} wdt:P2067 ?weight. }
  }`;
  const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  const js = await fetch(url, { headers: { 'Accept': 'application/sparql-results+json' } }).then(r=>r.json());
  const b = js?.results?.bindings?.[0] || null;
  if(!b) return null;
  const h = b.height ? Number(b.height.value) : null;
  const w = b.weight ? Number(b.weight.value) : null;
  return {
    heightCm: (h!=null && isFinite(h)) ? Math.round(h*100) : null,
    weightKg: (w!=null && isFinite(w)) ? Math.round(w) : null
  };
}


function genBodyMetrics(pos, seed){
  // Reasonable handball ranges (cm/kg), deterministic from seed
  let hMin=176, hMax=198, wMin=72, wMax=92;
  const p = (pos||'').toUpperCase();
  if(p==='GK'){ hMin=185; hMax=204; wMin=82; wMax=105; }
  else if(p==='PIV'){ hMin=185; hMax=205; wMin=90; wMax=115; }
  else if(p==='LB' || p==='RB'){ hMin=188; hMax=206; wMin=85; wMax=108; }
  else if(p==='CB'){ hMin=182; hMax=198; wMin=78; wMax=98; }
  else if(p==='LW' || p==='RW'){ hMin=175; hMax=192; wMin=68; wMax=88; }
  const h = seededInt(seed+11, hMin, hMax);
  const w = seededInt(seed+12, wMin, wMax);
  return { heightCm: h, weightKg: w };
}

// ---------- Contract / role / money generation ----------
function euro(n){
  const x = Math.round(n);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " €";
}
function formatDateDMY(d){
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}.${mm}.${yy}`;
}
function clamp20(v){ return Math.max(1, Math.min(20, Math.round(v))); }

function computeRole(player, seed){
  // 20% stars, 30% starters, 30% rotation, 20% young
  const o = player.overall || 10;
  // young if flagged or low overall
  const isYoung = (player.age && player.age < 22) || (player.young===true) || (o <= 11 && seededInt(seed+2,0,100) < 45);
  if(isYoung) return "Mladi igrač";
  if(o >= 17 && seededInt(seed+3,0,99) < 70) return "Zvezda";
  if(o >= 14 && seededInt(seed+4,0,99) < 70) return "Starter";
  if(o >= 12) return "Rotacija";
  return "Mladi igrač";
}

function computeReleaseClause(player, seed){
  // Handball market heuristics (top clauses around ~2M€; solid starters ~0.6–1.8M€)
  const o = player.overall || 10;
  const role = player.role || computeRole(player, seed);
  let base = 70000;
  if(role==="Mladi igrač") base = 60000;
  if(role==="Rotacija") base = 220000;
  if(role==="Starter") base = 650000;
  if(role==="Zvezda") base = 1500000;

  // overall scaling
  const scale = Math.pow(Math.max(0.6, o/15), 2.2);
  let clause = base * scale;

  // small deterministic noise ±12%
  const noise = (seededInt(seed+9, 88, 112))/100;
  clause *= noise;

  // cap & floor by role
  if(role==="Zvezda") clause = Math.min(Math.max(clause, 1200000), 2200000);
  if(role==="Starter") clause = Math.min(Math.max(clause, 450000), 1800000);
  if(role==="Rotacija") clause = Math.min(Math.max(clause, 160000), 900000);
  if(role==="Mladi igrač") clause = Math.min(Math.max(clause, 50000), 400000);

  return Math.round(clause/5000)*5000;
}

function computeWeeklyWage(player, seed){
  // derived from release clause; top wages can be ~10k–20k €/week for superstars, lower tiers much less.
  const c = player.releaseClause || computeReleaseClause(player, seed);
  const role = player.role || computeRole(player, seed);
  // base ratio (weekly) ~ clause * 0.002% to 0.01%
  let ratio = 0.000035; // default
  if(role==="Mladi igrač") ratio = 0.000018;
  if(role==="Rotacija") ratio = 0.00003;
  if(role==="Starter") ratio = 0.000045;
  if(role==="Zvezda") ratio = 0.00006;

  const noise = (seededInt(seed+12, 90, 115))/100;
  let wage = c * ratio * noise;

  // clamp ranges
  if(role==="Zvezda") wage = Math.min(Math.max(wage, 9000), 22000);
  if(role==="Starter") wage = Math.min(Math.max(wage, 4500), 14000);
  if(role==="Rotacija") wage = Math.min(Math.max(wage, 1800), 7000);
  if(role==="Mladi igrač") wage = Math.min(Math.max(wage, 700), 3500);

  return Math.round(wage/50)*50;
}

function computeContractEnd(seed){
  // Between 1 and 5 years from today, ending typically 30.06 or 30.12
  const now = new Date();
  const years = seededInt(seed+20, 1, 5);
  const month = (seededInt(seed+21, 0, 99) < 78) ? 5 : 11; // June or Dec
  const day = (month===5) ? 30 : 30;
  const y = now.getFullYear() + years;
  return new Date(y, month, day);
}

function ensurePlayerMeta(player, seed){
  if(!player.heightCm || !player.weightKg){
    const bm = genBodyMetrics(player.pos, seed+200);
    player.heightCm = bm.heightCm;
    player.weightKg = bm.weightKg;
  }
  if(!player.role) player.role = computeRole(player, seed+300);
  if(!player.contractEnd) player.contractEnd = formatDateDMY(computeContractEnd(seed+400));
  if(!player.releaseClause) player.releaseClause = computeReleaseClause(player, seed+500);
  if(!player.weeklyWage) player.weeklyWage = computeWeeklyWage(player, seed+600);
  return player;
}

async function ensurePlayerBio(p){
  if(!state.bioCache) state.bioCache = {};
  const key = (p.real||p.name||'');
  const seed = seedFrom('bio|' + key + '|' + (p.club||'') + '|' + (p.pos||''));
  if(state.bioCache[key]) return state.bioCache[key];
  state.bioCache[key] = { loading:true, heightCm:null, weightKg:null };
  try{
    const bio = await fetchBioFromWikidata(p.real || p.name);
    if(bio && (bio.heightCm || bio.weightKg)){
      state.bioCache[key] = { loading:false, ...bio };
      if(bio.heightCm) p.heightCm = bio.heightCm;
      if(bio.weightKg) p.weightKg = bio.weightKg;
    } else {
      state.bioCache[key] = { loading:false, ...genBodyMetrics(p.pos, seed) };
      const bm = state.bioCache[key];
      if(bm.heightCm) p.heightCm = bm.heightCm;
      if(bm.weightKg) p.weightKg = bm.weightKg;
    }
  }catch(e){
    state.bioCache[key] = { loading:false, ...genBodyMetrics(p.pos, seed) };
      const bm = state.bioCache[key];
      if(bm.heightCm) p.heightCm = bm.heightCm;
      if(bm.weightKg) p.weightKg = bm.weightKg;
  }
  return state.bioCache[key];
}

function openPlayerCard(kind, idx){
  let list;
  if(kind==='NT') list = (state._ntSummaryPlayers||[]);
  else if(kind==='BROWSE_CLUB') list = (state._clubBrowsePlayers||[]);
  else if(kind==='BROWSE_NT') list = (state._ntBrowsePlayers||[]);
  else if(kind==='CAREER') list = (state._careerPlayers||[]);
  else list = (state._clubSummaryPlayers||[]);
  const p0 = list[idx];
  if(!p0) return;

  // Ensure enrichments
  const seed = seedFrom('meta|' + (p0.name||'') + '|' + (p0.club||'') + '|' + (p0.pos||''));
  const player = { ...p0 };
  if(!player.hand) player.hand = posHandBias(player.pos, seed);
  if(!player.type) player.type = PLAYER_TYPES[seededInt(seed+5, 0, PLAYER_TYPES.length-1)];
  if(!player.attributes) player.attributes = buildPlayerAttributes(player);
  if(!player.specialties) player.specialties = computeSpecialties(player);

  ensurePlayerMeta(player, seed);

  state._openPlayer = { kind, idx, player, tab: (player.pos==='GK' ? 'PERS' : 'PERS') };
  // viewing player card should not modify staff ratings
render();

  // Trigger bio fetch (non-blocking)
  ensurePlayerBio(player).then(()=>{
    // only rerender if still open
    if(state._openPlayer && state._openPlayer.idx===idx && state._openPlayer.kind===kind){
      render();
    }
  });
}

function closePlayerCard(){
  state._openPlayer = null;
  render();
}

// expose for inline handlers
window.openPlayerCard = openPlayerCard;
window.closePlayerCard = closePlayerCard;

window.openPlayerByName = function(name){
  const list = state && state._clubSummaryPlayers ? state._clubSummaryPlayers : null;
  if(!list) return;
  const idx = list.findIndex(p => (p.name||'') === name);
  if(idx >= 0) openPlayerCard('CLUB', idx);
};


if(!window._hmProfileKeyListener){
  window._hmProfileKeyListener = true;
  window.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && state && state._openPlayer){
      closePlayerCard();
    }
  });
}

function formatStatKey(label){
  return label;
}

function renderPlayerModal(){
  const open = state._openPlayer;
  if(!open) return '';
  const p = open.player;
  const bio = (state.bioCache && state.bioCache[p.real||p.name]) ? state.bioCache[p.real||p.name] : { loading:true, heightCm:null, weightKg:null };
  const posLabel = POS_LABEL[p.pos] || p.pos;
  const clubLabel = (open.kind==='NT') ? (p.club||'—') : (p.club||'—');
  const specKeys = (p.specialties && p.specialties.keys) ? p.specialties.keys : new Set();

  const tabs = (p.pos==='GK')
    ? [
        {id:'PERS', t:'Lična kartica'},
        {id:'GK', t:'Golmanske ocene'},
        {id:'MEN', t:'Mentalno'},
        {id:'PHY', t:'Fizika'}
      ]
    .concat([{id:'STAT', t:'Statistika'}])
    : [
        {id:'PERS', t:'Lična kartica'},
        {id:'OFF', t:'Ofanzivno'},
        {id:'DEF', t:'Defanzivno'},
        {id:'MEN', t:'Mentalno'},
        {id:'PHY', t:'Fizička snaga'},
        {id:'STAT', t:'Statistika'}
      ];

  // Statistika je vidljiva od starta, ali je na nuli dok ne počnu utakmice.
  

function row(name, value, key){
        const star = (key && specKeys.has(key)) ? '<span class="attrStar">★</span>' : '';
    const pct = Math.max(0, Math.min(100, Math.round((value/20)*100)));
    return `<tr>
      <td class="statName">${name}${star}</td>
      <td class="statRight">
        <div class="statBar"><i style="width:${pct}%"></i></div>
        <span class="statPill">${star}${value}</span>
      </td>
    </tr>`;
  }

  function renderPersonal(){
    const heightTxt = (p.heightCm ? `${p.heightCm} cm` : (bio.loading ? 'Učitavanje…' : '—'));
    const weightTxt = (p.weightKg ? `${p.weightKg} kg` : (bio.loading ? 'Učitavanje…' : '—'));
    const role = p.role || '—';
    const contractEnd = p.contractEnd || '—';
    const clause = (p.releaseClause ? euro(p.releaseClause) : '—');
    const wage = (p.weeklyWage ? `${euro(p.weeklyWage)}/ned.` : '—');

    const ctx = (open && (open.kind==='NT' || open.kind==='BROWSE_NT')) ? (state._ctxNT || { goalsText:'', pressureNum:3 }) : (state._ctxClub || { goalsText:'', pressureNum:3 });
    const morale = getMorale(p, ctx.goalsText, ctx.pressureNum);
    const scores = calcCategoryScores(p.attributes);
    const ovr = Math.round(calcOverallFromScores(p.pos, scores, morale));

    return `
      <div class="bioGrid">
        <div class="bioBox"><div class="bioK">Ime i prezime</div><div class="bioV">${p.flag||''} ${p.name}</div></div>
        <div class="bioBox"><div class="bioK">Pozicija</div><div class="bioV">${posLabel}</div></div>
        <div class="bioBox"><div class="bioK">Klub</div><div class="bioV">${clubLabel}</div></div>
        <div class="bioBox"><div class="bioK">Uloga u timu</div><div class="bioV">${role}</div></div>
        <div class="bioBox"><div class="bioK">Ugovor do</div><div class="bioV">${contractEnd}</div></div>
        <div class="bioBox"><div class="bioK">Otkupna klauzula</div><div class="bioV">${clause}</div></div>
        <div class="bioBox"><div class="bioK">Nedeljna plata</div><div class="bioV">${wage}</div></div>
        <div class="bioBox"><div class="bioK">Visina</div><div class="bioV">${heightTxt}</div></div>
        <div class="bioBox"><div class="bioK">Težina</div><div class="bioV">${weightTxt}</div></div>
        <div class="bioBox"><div class="bioK">Ruka</div><div class="bioV">${p.hand||'—'}</div></div>
        <div class="bioBox"><div class="bioK">Tip igrača</div><div class="bioV">${p.type||'—'}</div></div>
        <div class="bioBox"><div class="bioK">Ocena / Kondicija / Moral</div><div class="bioV">Ovr ${ovr} • ${p.fitness}% • Moral ${morale}</div></div>
      </div>
    `;
  }

  function renderMental(){
    const me = p.attributes.mental;
    return `
      <div class="panel">
        <div class="panelTitle">Mentalne karakteristike (1–20)</div>
        <table class="statTable">
          ${row('Odlučivanje', me.odlucivanje, 'me_odlucivanje')}
          ${row('Koncentracija', me.koncentracija, 'me_koncentracija')}
          ${row('Smirenost', me.smirenost, 'me_smirenost')}
          ${row('Radna etika', me.radnaEtika, 'me_radnaEtika')}
          ${row('Liderstvo', me.liderstvo, 'me_liderstvo')}
          ${row('Pozicioniranje', me.pozicioniranje, 'me_pozicioniranje')}
          ${row('Disciplina', me.disciplina, 'me_disciplina')}
        </table>
      </div>
    `;
  }

function renderOffense(){
    const o = p.attributes.offense;
    return `
      <div class="panel">
        <div class="panelTitle">Ofanzivne ocene (1–20)</div>
        <table class="statTable">
          ${row('Šut spolja', o.sutSpolja, 'of_sutSpolja')}
          ${row('Šut iz skoka', o.sutIzSkoka, 'of_sutIzSkoka')}
          ${row('Šut sa krila', o.sutSaKrila, 'of_sutSaKrila')}
          ${row('Prodor 1 na 1', o.prodor1na1, 'of_prodor1na1')}
          ${row('Igra sa pivotom', o.igraSaPivotom, 'of_igraSaPivotom')}
          ${row('Finta', o.finta, 'of_finta')}
          ${row('Pregled igre', o.pregledIgre, 'of_pregledIgre')}
          ${row('Tehnika', o.tehnika, 'of_tehnika')}
        </table>
      </div>
    `;
  }

  function renderDefense(){
    const d = p.attributes.defense;
    return `
      <div class="panel">
        <div class="panelTitle">Defanzivne ocene (1–20)</div>
        <table class="statTable">
          ${row('Duel igra', d.duelIgra, 'df_duelIgra')}
          ${row('Blokiranje', d.blokiranje, 'df_blokiranje')}
          ${row('Bočna kretnja', d.bocnaKretnja, 'df_bocnaKretnja')}
          ${row('Anticipacija', d.anticipacija, 'df_anticipacija')}
          ${row('Tvrdoća', d.tvrdoca, 'df_tvrdoca')}
          ${row('Timska odbrana', d.timskaOdbrana, 'df_timskaOdbrana')}
          ${row('Kontrola faula', d.kontrolaFaula, 'df_kontrolaFaula')}
        </table>
      </div>
    `;
  }

  function renderPhysical(){
    const ph = p.attributes.physical;
    return `
      <div class="panel">
        <div class="panelTitle">Fizičke karakteristike (1–20)</div>
        <table class="statTable">
          ${row('Brzina', ph.brzina, 'ph_brzina')}
          ${row('Eksplozivnost', ph.eksplozivnost, 'ph_eksplozivnost')}
          ${row('Snaga', ph.snaga, 'ph_snaga')}
          ${row('Izdržljivost', ph.izdrzljivost, 'ph_izdrzljivost')}
          ${row('Balans', ph.balans, 'ph_balans')}
          ${row('Agilnost', ph.agilnost, 'ph_agilnost')}
        </table>
      </div>
    `;
  }

  function renderGoalkeeping(){
    const g = p.attributes.goalkeeping;
    return `
      <div class="panel">
        <div class="panelTitle">Golmanske ocene (1–20)</div>
        <table class="statTable">
          ${row('Refleksi', g.refleksi, 'gk_refleksi')}
          ${row('Postavljanje', g.postavljanje, 'gk_postavljanje')}
          ${row('1 na 1', g.jedanNaJedan, 'gk_jedanNaJedan')}
          ${row('Odbrane sa krila', g.odbraneSaKrila, 'gk_odbraneSaKrila')}
          ${row('Odbrane spolja', g.odbraneSpolja, 'gk_odbraneSpolja')}
          ${row('Kontrola odbijene lopte', g.kontrolaOdbijeneLopte, 'gk_kontrolaOdbijeneLopte')}
          ${row('Igra nogom', g.igraNogom, 'gk_igraNogom')}
          ${row('Mentalna stabilnost', g.mentalnaStabilnost, 'gk_mentalnaStabilnost')}
        </table>
      </div>
    `;

  function renderStatistics(){
    const ps = ensurePlayerSeasonState(p);
    const st = getSeasonStats(ps);

    const isZero = (ps.gamesPlayed||0) === 0;
    const helpTxt = isZero
      ? 'Početak sezone: statistika je 0 dok ne počnu utakmice.'
      : 'Sezonska statistika se automatski ažurira posle svake utakmice.';

    return `
      <div class="panel">
        <div class="panelTitle">Statistika (sezona)</div>
        <div class="help">${helpTxt}</div>

        <table class="statTable">
          <tr>
            <td class="statName">1) Ukupna ocena sezone (prosek)</td>
            <td class="statRight"><span class="statPill">${st.avgRating}</span></td>
          </tr>

          <tr>
            <td class="statName">2) Ofanzivni učinak (golovi + asistencije)</td>
            <td class="statRight"><span class="statPill">${st.goalsAssists}</span></td>
          </tr>
          <tr>
            <td class="statName">Golovi po utakmici</td>
            <td class="statRight"><span class="statPill">${st.goalsPerGame}</span></td>
          </tr>
          <tr>
            <td class="statName">Preciznost šuta (%)</td>
            <td class="statRight"><span class="statPill">${st.shotAccuracy}%</span></td>
          </tr>

          <tr>
            <td class="statName">3) Defanzivni učinak</td>
            <td class="statRight">
              <span class="statPill">D ${st.duelsWon}</span>
              <span class="statPill">B ${st.blocks}</span>
              <span class="statPill">U ${st.steals}</span>
            </td>
          </tr>

          <tr>
            <td class="statName">4) Minutaža i dostupnost</td>
            <td class="statRight">
              <span class="statPill">${st.minutesTotal} min</span>
              <span class="statPill">${st.gamesPlayed} utak.</span>
              <span class="statPill">prop. ${st.gamesMissed}</span>
            </td>
          </tr>

          <tr>
            <td class="statName">5) Disciplina i greške</td>
            <td class="statRight">
              <span class="statPill">2' ${st.twoMin}</span>
              <span class="statPill">CR ${st.red}</span>
              <span class="statPill">TE ${st.techErrors}</span>
            </td>
          </tr>
        </table>
      </div>
    `;
  }

  }

  const content = (open.tab==='PERS') ? renderPersonal()
    : (open.tab==='STAT') ? renderStatistics()
    : (open.tab==='MEN') ? renderMental()
    : (open.tab==='OFF') ? renderOffense()
    : (open.tab==='DEF') ? renderDefense()
    : (open.tab==='PHY') ? renderPhysical()
    : renderGoalkeeping();

  return `
    <div class="modalBackdrop" onclick="if(event.target.classList.contains('modalBackdrop')) closePlayerCard();">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modalHeader">
          <div class="modalTitleWrap">
            <div class="modalAvatar">${(p.pos||'').slice(0,2)}</div>
            <div style="min-width:0">
              <div class="modalName">${p.flag||''} ${p.name}</div>
              <div class="modalMeta">
                <span class="pill2">${posLabel}</span>
                <span class="pill2">Ovr ${getDisplayedOverall(p, (open && (open.kind==='NT'||open.kind==='BROWSE_NT')) ? 'NT' : 'CLUB')}</span>
                <span class="pill2">Kond ${p.fitness}%</span>
              </div>
            </div>
          </div>
          <button class="closeBtn" onclick="closePlayerCard()">✕</button>
        </div>

        <div class="tabs">
          ${tabs.map(t=>`<button class="tabBtn ${open.tab===t.id?'active':''}" onclick="state._openPlayer.tab='${t.id}'; render();">${t.t}</button>`).join('')}
        </div>

        <div class="modalBody">
          ${content}
        </div>
      </div>
    </div>
  `;
}



/* ---------- Staff (coach/analyst/etc) cards ---------- */

function staffClamp20(n){ return clamp(toNumClamp(n,1,20,10),1,20); }

function ensureStaffAttributes(s){
  if(!s) return;
  if(!s.attributes || typeof s.attributes!=='object') s.attributes = {};
  const A = s.attributes;

  function ensureGroup(key, fields){
    if(!A[key] || typeof A[key]!=='object') A[key] = {};
    const g = A[key];
    fields.forEach(f=>{
      g[f] = staffClamp20(g[f]);
      g[f] = Math.round(g[f]);
    });
  }

  ensureGroup('tactical', ['postavkaNapada','postavkaOdbrane','prilagodjavanjeProtivniku','citanjeUtakmice','tajmingIzmena','varijacijeSistema']);
  ensureGroup('training', ['planiranjeTreninga','razvojMladih','fizickaPriprema','individualniRad','prevencijaPovreda']);
  ensureGroup('mental', ['motivacija','autoritet','smirenostPodPritiskom','disciplina','komunikacija','vodjenjeSvlačionice']);
  ensureGroup('strategic', ['dugorocnoPlaniranje','rotacija','upravljanjeFormom','upravljanjeMinutazom','razvojMladihTokomSezone']);
  ensureGroup('impact', ['efekatTajmAuta','reakcijaUKrizi','vodjenjeZavrsnice','vodjenjeDerbija','vodjenjeVelikihTakmicenja']);

  if(!s.style) s.style = 'Balansiran';
  if(!s.experienceYears) s.experienceYears = 8;
  if(!s.age) s.age = 42;
  if(!s.nationality) s.nationality = (s.flag ? s.flag : '—');
  if(!s.team) s.team = (state && state.club) ? state.club : (state && state.nt ? state.nt : '—');
}

function avgNum(arr){
  const nums = (arr||[]).map(v=>Number(v)).filter(v=>Number.isFinite(v));
  if(!nums.length) return 0;
  return nums.reduce((a,b)=>a+b,0)/nums.length;
}

function computeStaffRatings(s){
  ensureStaffAttributes(s);
  const A = s.attributes;

  const tactical = avgNum(Object.values(A.tactical||{}));
  const training = avgNum(Object.values(A.training||{}));
  const mental   = avgNum(Object.values(A.mental||{}));
  const strategic= avgNum(Object.values(A.strategic||{}));
  const impact   = avgNum(Object.values(A.impact||{}));

  const overall = (tactical*0.30) + (mental*0.25) + (impact*0.20) + (training*0.15) + (strategic*0.10);

  const rep =
    overall >= 18 ? 'Elitna'
    : overall >= 16 ? 'Visoka'
    : overall >= 13 ? 'Srednja'
    : 'Niska';

  const moraleBonus = mental / 50;

  return {
    tactical, training, mental, strategic, impact,
    overall, rep, moraleBonus
  };
}

function openStaffCard(kind, idx){
  state._openStaff = { kind, idx, tab: 'PROF' };
  render();
}
function closeStaffCard(){
  state._openStaff = null;
  render();
}

function getStaffByOpen(){
  const o = state._openStaff;
  if(!o) return null;
  let arr = null;
  if(o.kind === 'CAREER') arr = state._careerStaff;
  if(o.kind === 'BROWSE_CLUB') arr = state._clubBrowseStaff;
  if(o.kind === 'BROWSE_NT') arr = state._ntBrowseStaff;
  if(!arr || !arr[o.idx]) return null;
  return arr[o.idx];
}

function renderStaffModal(){
  const s = getStaffByOpen();
  if(!s) return '';
  const r = computeStaffRatings(s);

  const tabs = [
    { id:'PROF', t:'Profil' },
    { id:'TAK',  t:'Taktika' },
    { id:'TRE',  t:'Trening' },
    { id:'MEN',  t:'Mentalno' },
    { id:'STR',  t:'Strategija' },
    { id:'IMP',  t:'Uticaj' },
  ];

  const row = (label, val)=>`<tr><td class="muted">${label}</td><td style="text-align:right"><b>${Math.round(val)}</b></td></tr>`;

  function cardTable(title, obj, labels){
    return `
      <div class="panel">
        <div class="panelTitle">${title}</div>
        <table class="statTable">
          ${labels.map(([k,lab])=>row(lab, obj[k])).join('')}
        </table>
      </div>
    `;

  function renderStatistics(){
    // Početak sezone: sve statistike su 0 (anulirano). Kasnije se puni kroz match engine.
    const z = 0;
    const pct = 0;
    return `
      <div class="panel">
        <div class="panelTitle">Statistika (sezona – trenutno 0)</div>
        <div class="help">Napomena: Pošto je početak sezone, ova kartica je informativna i svi brojevi su na nuli.</div>
        <table class="statTable">
          <tr><td class="statName">1) Ukupna ocena sezone (prosek)</td><td class="statRight"><span class="statPill">${z.toFixed ? z.toFixed(1) : '0.0'}</span></td></tr>
          <tr><td class="statName">2) Ofanzivni učinak (golovi + asistencije)</td><td class="statRight"><span class="statPill">${z}</span></td></tr>
          <tr><td class="statName">Golovi po utakmici</td><td class="statRight"><span class="statPill">${z.toFixed ? z.toFixed(2) : '0.00'}</span></td></tr>
          <tr><td class="statName">Preciznost šuta (%)</td><td class="statRight"><span class="statPill">${pct}%</span></td></tr>

          <tr><td class="statName">3) Defanzivni učinak (dueli / blokovi / ukradene)</td><td class="statRight"><span class="statPill">${z}</span></td></tr>

          <tr><td class="statName">4) Minutaža (ukupno)</td><td class="statRight"><span class="statPill">${z}</span></td></tr>
          <tr><td class="statName">Odigrane utakmice</td><td class="statRight"><span class="statPill">${z}</span></td></tr>
          <tr><td class="statName">Propuštene utakmice (povrede/kazne)</td><td class="statRight"><span class="statPill">${z}</span></td></tr>

          <tr><td class="statName">5) Disciplina i greške (2 min / crveni / tehničke)</td><td class="statRight"><span class="statPill">${z}</span></td></tr>
        </table>
      </div>
    `;
  }

  }

  const content = (()=>{
    if(state._openStaff.tab==='PROF'){
      const fullName = `${s.flag||''} ${s.name||((s.first||'')+' '+(s.last||''))}`.trim();
      return `
        <div class="panel profilePanel">
          <div class="profileTop">
            <div class="profileAvatar">👔</div>
            <div class="profileMain">
              <div class="profileName">${fullName || '—'}</div>
              <div class="profileBadges">
                <span class="pill2">${s.role||'Trener'}</span>
                <span class="pill2">${s.team||'—'}</span>
                <span class="pill2">Ukupno ${r.overall.toFixed(1)}/20</span>
                <span class="pill2">Rep ${r.rep}</span>
              </div>
            </div>
          </div>

          <div class="profileGrid">
            <div class="profileItem">
              <div class="k">Godine</div><div class="v">${s.age||'—'}</div>
            </div>
            <div class="profileItem">
              <div class="k">Nacionalnost</div><div class="v">${s.nationality||s.flag||'—'}</div>
            </div>
            <div class="profileItem">
              <div class="k">Iskustvo</div><div class="v">${s.experienceYears||'—'} god</div>
            </div>
            <div class="profileItem">
              <div class="k">Stil rada</div><div class="v">${s.style||'Balansiran'}</div>
            </div>
          </div>

          <div class="profileHint">
            <span class="muted">Napomena:</span> Reputacija je “skrivena” vrednost (koristi se za pregovore, autoritet i pritisak javnosti).
          </div>
        </div>
      `;
    }
    if(state._openStaff.tab==='TAK'){
      const t = s.attributes.tactical;
      return cardTable('Taktička kartica (1–20)', t, [
        ['postavkaNapada','Postavka napada'],
        ['postavkaOdbrane','Postavka odbrane'],
        ['prilagodjavanjeProtivniku','Prilagođavanje protivniku'],
        ['citanjeUtakmice','Čitanje utakmice'],
        ['tajmingIzmena','Tajming izmena'],
        ['varijacijeSistema','Varijacije sistema (6–0/5–1/3–2–1/7v6)'],
      ]) + `
        <div class="panel"><div class="panelTitle">Taktička ocena</div>
          <div class="big" style="font-size:28px">${r.tactical.toFixed(1)}</div>
          <div class="itemSub">Prosek svih taktičkih atributa</div>
        </div>
      `;
    }
    if(state._openStaff.tab==='TRE'){
      const t=s.attributes.training;
      return cardTable('Trenažna kartica (1–20)', t, [
        ['planiranjeTreninga','Planiranje treninga'],
        ['razvojMladih','Razvoj mladih igrača'],
        ['fizickaPriprema','Fizička priprema ekipe'],
        ['individualniRad','Individualni rad sa igračima'],
        ['prevencijaPovreda','Prevencija povreda'],
      ]) + `
        <div class="panel"><div class="panelTitle">Trenažna ocena</div>
          <div class="big" style="font-size:28px">${r.training.toFixed(1)}</div>
          <div class="itemSub">Prosek svih trenažnih atributa</div>
        </div>
      `;
    }
    if(state._openStaff.tab==='MEN'){
      const t=s.attributes.mental;
      return cardTable('Mentalna kartica (1–20)', t, [
        ['motivacija','Motivacija igrača'],
        ['autoritet','Autoritet'],
        ['smirenostPodPritiskom','Smirenost pod pritiskom'],
        ['disciplina','Disciplina tima'],
        ['komunikacija','Komunikacija sa igračima'],
        ['vodjenjeSvlačionice','Vođenje svlačionice'],
      ]) + `
        <div class="panel"><div class="panelTitle">Mentalna ocena</div>
          <div class="big" style="font-size:28px">${r.mental.toFixed(1)}</div>
          <div class="itemSub">Prosek svih mentalnih atributa • Bonus morala = Mentalna/50 = <b>+${r.moraleBonus.toFixed(2)}</b></div>
        </div>
      `;
    }
    if(state._openStaff.tab==='STR'){
      const t=s.attributes.strategic;
      return cardTable('Strateška kartica (1–20)', t, [
        ['dugorocnoPlaniranje','Dugoročno planiranje'],
        ['rotacija','Rotacija igrača'],
        ['upravljanjeFormom','Upravljanje formom'],
        ['upravljanjeMinutazom','Upravljanje minutažom'],
        ['razvojMladihTokomSezone','Razvoj mladih kroz sezonu'],
      ]) + `
        <div class="panel"><div class="panelTitle">Strateška ocena</div>
          <div class="big" style="font-size:28px">${r.strategic.toFixed(1)}</div>
          <div class="itemSub">Prosek svih strateških atributa</div>
        </div>
      `;
    }
    if(state._openStaff.tab==='IMP'){
      const t=s.attributes.impact;
      return cardTable('Uticaj na utakmicu (1–20)', t, [
        ['efekatTajmAuta','Efekat tajm-auta'],
        ['reakcijaUKrizi','Reakcija u kriznim situacijama'],
        ['vodjenjeZavrsnice','Vođenje završnice utakmice'],
        ['vodjenjeDerbija','Vođenje derbija'],
        ['vodjenjeVelikihTakmicenja','Vođenje velikih takmičenja'],
      ]) + `
        <div class="panel"><div class="panelTitle">Ocena uticaja na utakmicu</div>
          <div class="big" style="font-size:28px">${r.impact.toFixed(1)}</div>
          <div class="itemSub">Prosek navedenih atributa</div>
        </div>
      `;
    }
    // Default (bez 'Ocene' taba)
    return `
      <div class="panel">
        <div class="panelTitle">Profil</div>
        <div class="itemSub">Izaberi jedan od tabova (Taktika / Trening / Mentalno / Strategija / Uticaj).</div>
      </div>
    `;
  })();

  return `
    <div class="modalBackdrop" onclick="if(event.target.classList.contains('modalBackdrop')) closeStaffCard();">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modalHeader">
          <div class="modalTitleWrap">
            <div class="modalAvatar">👔</div>
            <div style="min-width:0">
              <div class="modalName">${s.flag||''} ${s.name||((s.first||'')+' '+(s.last||''))}</div>
              <div class="modalMeta">
                <span class="pill2">${s.role||'Trener'}</span>
                <span class="pill2">Ukupno ${r.overall.toFixed(1)}/20</span>
                <span class="pill2">Rep ${r.rep}</span>
              </div>
            </div>
          </div>
          <button class="closeBtn" onclick="closeStaffCard()">✕</button>
        </div>

        <div class="tabs">
          ${tabs.map(t=>`<button class="tabBtn ${state._openStaff.tab===t.id?'active':''}" onclick="state._openStaff.tab='${t.id}'; render();">${t.t}</button>`).join('')}
        </div>

        <div class="modalBody">
          ${content}
        </div>
      </div>
    </div>
  `;
}

// expose for inline onclick safety
window.openStaffCard = openStaffCard;
window.closeStaffCard = closeStaffCard;
const namePoolsByNation = {
  RS: { first: ["Marko","Nikola","Milan","Stefan","Aleksandar","Nenad","Vladimir"], last: ["Jovanović","Petrović","Nikolić","Ilić","Stojanović","Marković"] },
  DE: { first: ["Hans","Thomas","Michael","Stefan","Andreas","Jürgen"], last: ["Müller","Schmidt","Schneider","Fischer","Weber","Meyer"] },
  FR: { first: ["Jean","Pierre","Luc","Antoine","Mathieu","Julien"], last: ["Martin","Bernard","Dubois","Moreau","Laurent","Lefèvre"] },
  ES: { first: ["Juan","Carlos","Miguel","Pablo","Sergio","David"], last: ["García","Martínez","López","Sánchez","Pérez","Gómez"] },
  DK: { first: ["Lars","Mikkel","Anders","Jesper","Thomas"], last: ["Nielsen","Jensen","Hansen","Pedersen","Andersen"] },
  SE: { first: ["Johan","Erik","Magnus","Andreas","Karl"], last: ["Johansson","Andersson","Karlsson","Nilsson","Larsson"] },
  NO: { first: ["Ole","Erik","Magnus","Jon","Andreas"], last: ["Hansen","Johansen","Olsen","Larsen","Andersen"] },
  HU: { first: ["Gábor","István","László","Péter","Tamás"], last: ["Nagy","Kovács","Tóth","Szabó","Horváth"] },
  PL: { first: ["Piotr","Krzysztof","Paweł","Marek","Tomasz"], last: ["Nowak","Kowalski","Wiśniewski","Wójcik","Kaczmarek"] }
};



function getNTTier(code){
  // Tier 1 = world elite, Tier 2 = strong, Tier 3 = competitive, Tier 4 = developing
  if(['FR','DK','ES','SE','NO'].includes(code)) return 1;
  if(['DE','HR','HU'].includes(code)) return 2;
  if(['PL','RS'].includes(code)) return 3;
  return 4;
}

function generateNTGoals(code){
  const tier = getNTTier(code);
  if(tier===1){
    return {
      primary: "Borba za medalju na velikom takmičenju",
      secondary: "Plasman u polufinale Evropskog ili Svetskog prvenstva",
      pressure: "Veoma visok"
    };
  }
  if(tier===2){
    return {
      primary: "Plasman u četvrtfinale velikog takmičenja",
      secondary: "Redovan plasman na EP i SP",
      pressure: "Visok"
    };
  }
  if(tier===3){
    return {
      primary: "Plasman na Evropsko ili Svetsko prvenstvo",
      secondary: "Konkurentni nastupi u grupnoj fazi",
      pressure: "Srednji"
    };
  }
  return {
    primary: "Razvoj ekipe i plasman u baraž",
    secondary: "Pobede protiv ravnopravnih rivala",
    pressure: "Nizak"
  };
}
function ntToNationCode(nt){
  if(!nt) return 'RS';
  // Prefer flag emoji if present
  if(nt.includes('🇷🇸')) return 'RS';
  if(nt.includes('🇭🇷')) return 'HR';
  if(nt.includes('🇩🇪')) return 'DE';
  if(nt.includes('🇫🇷')) return 'FR';
  if(nt.includes('🇪🇸')) return 'ES';
  if(nt.includes('🇩🇰')) return 'DK';
  if(nt.includes('🇸🇪')) return 'SE';
  if(nt.includes('🇳🇴')) return 'NO';
  if(nt.includes('🇭🇺')) return 'HU';
  if(nt.includes('🇵🇱')) return 'PL';
  // Fallback by name
  const low = nt.toLowerCase();
  if(low.includes('srb')) return 'RS';
  if(low.includes('hrvat')) return 'HR';
  if(low.includes('nema')) return 'DE';
  if(low.includes('franc')) return 'FR';
  if(low.includes('špan') || low.includes('span')) return 'ES';
  if(low.includes('dans')) return 'DK';
  if(low.includes('šved') || low.includes('sved')) return 'SE';
  if(low.includes('norv')) return 'NO';
  if(low.includes('mađ') || low.includes('madj') || low.includes('hung')) return 'HU';
  if(low.includes('polj') || low.includes('poland')) return 'PL';
  return 'RS';
}

function rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function genPersonByNation(code){
  const p = namePoolsByNation[code] || namePoolsByNation.RS;
  return rand(p.first) + " " + rand(p.last);
}

function generateFederationOfficials(nationCode){
  return {
    president: genPersonByNation(nationCode),
    vice: genPersonByNation(nationCode),
    secretary: genPersonByNation(nationCode),
    spokesperson: genPersonByNation(nationCode)
  };
}





function generateNTStaff(nationCode){
  return {
    assistant: genPersonByNation(nationCode),
    fitness: genPersonByNation(nationCode),
    gk: genPersonByNation(nationCode),
    physio: genPersonByNation(nationCode),
    scout: genPersonByNation(nationCode),
    analyst: genPersonByNation(nationCode)
  };
}

function generateNTStaffList(nationCode, teamName){
  // Same staff attribute schema as clubs (1–20), deterministic by nationCode
  const rnd = mulberry32(seedFrom('NTSTAFF|' + nationCode));
  const _nk = nationCode;
  if(_ntStartCache[_nk]) return _ntStartCache[_nk].map(s=>({ ...s, attributes: JSON.parse(JSON.stringify(s.attributes||{})) }));
  const tier = getNTTier(nationCode); // 1 best .. 4 weakest

  const keys = {
    tactical: ['postavkaNapada','postavkaOdbrane','prilagodjavanjeProtivniku','citanjeUtakmice','tajmingIzmena','varijacijeSistema'],
    training: ['planiranjeTreninga','razvojMladih','fizickaPriprema','individualniRad','prevencijaPovreda'],
    mental:   ['motivacija','autoritet','smirenostPodPritiskom','disciplina','komunikacija','vodjenjeSvlačionice'],
    strategic:['dugorocnoPlaniranje','rotacija','upravljanjeFormom','upravljanjeMinutazom','razvojMladihTokomSezone'],
    impact:   ['efekatTajmAuta','reakcijaUKrizi','vodjenjeZavrsnice','vodjenjeDerbija','vodjenjeVelikihTakmicenja'],
  };

  function clamp20(x){ return clamp(Math.round(x), 1, 20); }
  function around(mean, spread){
    // mild bell-ish randomness
    const u = rnd(); const v = rnd();
    const z = Math.sqrt(-2*Math.log(Math.max(1e-9,u))) * Math.cos(2*Math.PI*v); // ~N(0,1)
    return clamp20(mean + z*spread);
  }

  // Tier baselines similar to club staff realism
  const tierBase =
    tier===1 ? {base:15.8, spread:2.0} :
    tier===2 ? {base:13.9, spread:2.3} :
    tier===3 ? {base:12.2, spread:2.6} :
              {base:10.6, spread:3.0};

  function roleProfile(role, base){
    // group means by role (same model groups as clubs)
    const P = { tactical:base, training:base, mental:base, strategic:base, impact:base };

    if(role==='Selektor'){ P.tactical+=1.2; P.impact+=1.0; P.mental+=0.8; P.strategic+=0.6; P.training+=0.2; }
    if(role==='Pomoćni trener'){ P.training+=1.2; P.tactical+=0.6; P.mental+=0.3; P.strategic+=0.2; }
    if(role==='Kondicioni trener'){ P.training+=1.4; P.mental+=0.2; P.tactical-=0.6; P.impact-=0.2; }
    if(role==='Trener golmana'){ P.training+=1.0; P.tactical+=0.2; P.impact+=0.2; P.strategic+=0.2; }
    if(role==='Fizioterapeut'){ P.training+=0.8; P.mental+=0.4; P.tactical-=0.8; P.impact-=0.4; }
    if(role==='Skaut'){ P.strategic+=1.0; P.tactical+=0.6; P.training+=0.2; P.impact+=0.2; }
    if(role==='Analitičar'){ P.tactical+=1.1; P.strategic+=0.8; P.training+=0.2; P.impact+=0.2; }

    // keep within bounds
    Object.keys(P).forEach(k=> P[k] = clamp(P[k], 6, 19));
    return P;
  }

  function buildAttrs(role){
    const P = roleProfile(role, tierBase.base);
    const A = {};
    Object.keys(keys).forEach(group=>{
      A[group] = {};
      keys[group].forEach(k=>{
        A[group][k] = around(P[group], tierBase.spread);
      });
    });
    return A;
  }



  // Specialist caps for NT staff (same rules as clubs; do NOT touch Selektor & Pomoćni trener)
  function _applySpecialistRoleCapsNT(role, attr){
    if(role==='Selektor' || role==='Pomoćni trener') return attr;
    function capAllExceptTraining(){
      ['tactical','mental','strategic','impact'].forEach(g=>{ Object.keys(attr[g]||{}).forEach(k=>{ attr[g][k]=randInt(5,11); }); });
    }
    function capAllExceptAllowed(allowed){
      ['tactical','training','mental','strategic','impact'].forEach(g=>{
        Object.keys(attr[g]||{}).forEach(k=>{
          const ok = allowed[g] && allowed[g].has(k);
          attr[g][k] = ok ? clamp(attr[g][k],12,18) : randInt(5,11);
        });
      });
    }
        if(role==='Trener golmana'){
      ['tactical','training','mental','strategic','impact'].forEach(g=>{for(const k in (attr[g]||{})) attr[g][k]=clamp(attr[g][k]-5,1,20);});
      return attr;
    }
if(role==='Kondicioni trener'){
      Object.keys(attr.training||{}).forEach(k=>{ attr.training[k]=clamp(attr.training[k],12,18); });
      capAllExceptTraining();
      return attr;
    }
    if(role==='Fizioterapeut'){
      capAllExceptAllowed({ training:new Set(['prevencijaPovreda']) });
      return attr;
    }
    if(role==='Skaut' || role==='Analitičar'){
      capAllExceptAllowed({ strategic:new Set(['dugorocnoPlaniranje','razvojMladihTokomSezone']), tactical:new Set(['citanjeUtakmice']) });
      return attr;
    }
    return attr;
  }
  const roles = [
    'Selektor',
    'Pomoćni trener',
    'Kondicioni trener',
    'Trener golmana',
    'Fizioterapeut',
    'Skaut',
    'Analitičar'
  ];

  const list = roles.map(role=>{
    const person = genPerson(rnd, nationCode);
    const attributes = _applySpecialistRoleCapsNT(role, buildAttrs(role));
    const name = (person.name || ((person.first||'')+' '+(person.last||''))).trim();
    return {
      role,
      ...person,
      name,
      team: teamName || nationCode,
      attributes,
      style: 'Balansiran',
      experienceYears: clamp(Math.round(6 + rnd()*18 + (tier===1?4:0) - (tier===4?2:0)), 1, 35),
      age: clamp(Math.round(34 + rnd()*20), 25, 65),
      nationality: person.flag || nationCode
    };
  });

  return list;
}

function populateBirthDay() {
  const daySelect = document.getElementById('bday');
  if (!daySelect) return;

  daySelect.innerHTML = '<option value="">Dan</option>';

  for (let d = 1; d <= 31; d++) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    daySelect.appendChild(opt);
  }
}


// Handball Manager V4 — Wizard
const SEASON = '2025/2026';
// (Korak 1: profil -> Korak 2: ocene -> Korak 3: karijera -> Korak 4: liga+tim)
let state={
  screen:"wizard",
  step:1,
  leagueView:'LEAGUES', // LEAGUES | CLUBS (within step 4)
  settings:{ language:'sr', autosave:'off' },
  tactics:{
    offense:{ focus:"balanced", tempo:5, passRisk:5, width:5, pressAfterGoal:false },
    defense:{ system:"6-0", height:"low", aggression:5 },
    transition:{ fastBreak:5, pressAfterGoal:false, retreatSpeed:5 }
  },
  profile:{
    firstName:'',
    lastName:'',
    birthDay:1,
    birthMonth:1,
    birthYear:2000,
    nationalityCode:'RS',
    nationalityName:'Serbia',
    coachExperience:'Bez iskustva',
    role:'Trener',
    playerExperience:'Amater',
    preferredFormation:'6-0',
    use7v6:'Ne',
    communicationStyle:'Smiren i analitičan'
  },
  ratings:null,
  difficulty:null,
  career:'BOTH', // CLUB | NT | BOTH
  leagueId:null,
  leagueName:null,
  club:null,
  nt:null
};

// === Global tactics source of truth (UI + Pitch + Engine) ===
window.gameState = state;
// renderPitch is a stable hook used by tactic setters (re-renders UI)
window.renderPitch = function(){ try{ render(); }catch(e){} };
// Offense setter (no local state in UI)
window.updateOffenseSetting = function(key, value){
  try{
    if(!state.tactics) state.tactics = { offense:{}, defense:{}, transition:{} };
    if(!state.tactics.offense) state.tactics.offense = { focus:"balanced", tempo:5, passRisk:5, width:5, pressAfterGoal:false };
    state.tactics.offense[key] = value;
    window.gameState = state;
    window.renderPitch();
  }catch(e){ /* noop */ }
};


function startCareer(){
  const league = leagueById(state.leagueId) || LEAGUES[0];

  // Initialize shared DB (source of truth)
  if(!window.HM_DB){
    window.HM_DB = { version:1, leagues:[], clubs:{}, nts:{}, players:{}, staff:{}, career:null };
  }
  if(!window.HM_DB.nts) window.HM_DB.nts = {};
  if(!window.HM_DB.leagues || !window.HM_DB.leagues.length){
    try{
      window.HM_DB.leagues = LEAGUES.map(l=>({ id:l.id, name:l.name, clubs:[...(l.clubs||[])] }));
    }catch(e){}
  }

  // Helper: resolve nation by name
  function getNationByName(nm){
    const name = String(nm||'').trim();
    if(!name) return null;
    const row = (COUNTRIES||[]).find(r=>String(r[0]).toLowerCase()===name.toLowerCase());
    if(row) return { name: row[0], code: row[1], flag: row[2] };
    // fallback: partial match
    const row2 = (COUNTRIES||[]).find(r=>String(r[0]).toLowerCase().includes(name.toLowerCase()));
    if(row2) return { name: row2[0], code: row2[1], flag: row2[2] };
    return { name, code: name.slice(0,2).toUpperCase(), flag: '' };
  }

  // Decide career type
  const mode = state.career || 'CLUB'; // CLUB | NT | BOTH
  const wantClub = (mode === 'CLUB' || mode === 'BOTH');
  const wantNT   = (mode === 'NT'   || mode === 'BOTH');

  // Validate selection
  if(wantClub && !state.club){
    alert("Nije izabran klub.");
    return;
  }
  if(wantNT && !state.nt){
    alert("Nije izabrana reprezentacija.");
    return;
  }

  // ===== CLUB normalize into DB (same as before) =====
  let clubKey = null;
  if(wantClub){
    clubKey = league.id + '|' + state.club;

    const clubData = window.HM_DB.clubs[clubKey] || genClubData(league, state.club);
    const _players = (clubData.players || clubData.squad || []).map(p=>({ ...p }));
    const _staff   = (clubData.staff || clubData.coaches || []).map(s=>{
      const _s = { ...s, attributes: JSON.parse(JSON.stringify((s&&s.attributes)||{})) };
      const nm = (_s.name || [(_s.first||''), (_s.last||'')].filter(Boolean).join(' ').trim());
      _s.name = nm || 'Nepoznat';
      return _s;
    });
    const _board   = (clubData.board || []).map(b=>{
      const _b = { ...b };
      const existing = _b.name || _b.fullName || _b.ime || null;
      let nm = existing;
      if(!nm){
        const f = _b.first || _b.firstName || _b.firstname || '';
        const l = _b.last  || _b.lastName  || _b.lastname  || '';
        nm = (String(f).trim() + ' ' + String(l).trim()).trim();
      }
      _b.name = nm || 'Nepoznat';
      _b.nationality = _b.nationality || _b.nat || (_b.flag ? _b.flag : null);
      return _b;
    });
    const _finance = clubData.finance || {
      budget: clubData.budget ?? null,
      wageBudget: clubData.wageBudget ?? (clubData.budget!=null ? Math.round(clubData.budget*0.62) : null),
      transferBudget: clubData.transferBudget ?? (clubData.budget!=null ? Math.round(clubData.budget*0.25) : null)
    };

    window.HM_DB.clubs[clubKey] = {
      ...clubData,
      key: clubKey,
      leagueId: league.id,
      leagueName: league.name,
      name: state.club,
      players: _players,
      staff: _staff,
      board: _board,
      finance: _finance,
    };

    const gp = clubGoalsAndPressure(league, state.club);
    const clubRef = window.HM_DB.clubs[clubKey];
    if(clubRef){
      clubRef.pressure = gp.pressure;
      clubRef.boardMeta = clubRef.boardMeta || {};
      clubRef.boardMeta.primaryGoal = gp.primary;
      clubRef.boardMeta.objectives = gp.objectives;
      clubRef.objectives = gp.objectives;
      clubRef.primaryGoal = gp.primary;
      clubRef.goalProgress = startGoalProgress(league, state.club);
      clubRef.pressureProgress = startPressureProgress(league, state.club);
    }
  }

  // ===== NT normalize into DB (NEW) =====
  let ntKey = null;
  if(wantNT){
    const nation = getNationByName(state.nt);
    const code = nation?.code || 'XX';
    ntKey = 'NT|' + code;

    // Build roster from FAZA 1 selection if available (exact list user saw in wizard),
    // otherwise fallback to generated "best players" pool.
    const rosterSrc = (state.ntRoster && Array.isArray(state.ntRoster) && state.ntRoster.length)
      ? state.ntRoster
      : buildNationalRoster(code);
    const roster = rosterSrc.map(p=>({ ...p }));
    // Minimal staff set for NT career (can be upgraded later)
    const staff = [
      { name: (state.manager?.name ? state.manager.name : 'Selektor'), role:'Glavni trener', attributes: JSON.parse(JSON.stringify((state.manager && state.manager.attributes) || {})) },
      { name: 'Asistent selektora', role:'Pomoćni trener', attributes: { training:12, tactical:12, mental:12, strategic:12, impact:12 } },
      { name: 'Analitičar', role:'Analitičar', attributes: { training:11, tactical:13, mental:11, strategic:12, impact:11 } },
      { name: 'Kondicioni trener', role:'Kondicioni trener', attributes: { training:14, tactical:9, mental:11, strategic:10, impact:12 } },
      { name: 'Fizioterapeut', role:'Fizioterapeut', attributes: { training:10, tactical:8, mental:12, strategic:9, impact:12 } },
    ].map(s=>({ ...s, attributes: JSON.parse(JSON.stringify(s.attributes||{})) }));

    const officials = state.ntOfficials || generateFederationOfficials(code);
    const board = [
      { name: officials.president, role:'Predsednik saveza', nationality: nation?.flag || null },
      { name: officials.vice, role:'Potpredsednik saveza', nationality: nation?.flag || null },
      { name: officials.secretary, role:'Generalni sekretar', nationality: nation?.flag || null },
      { name: officials.spokesperson, role:'Portparol saveza', nationality: nation?.flag || null },
    ];

    // Simple national-team objectives & pressure (FM-ish)
    // pressure: 1-25, higher for top nations
    const avgOvr = roster.reduce((a,p)=>a+(Number(p.overall)||0),0) / Math.max(1, roster.length);
    const pressure = Math.max(8, Math.min(24, Math.round(10 + (avgOvr-12)*1.6)));
    const primary = (avgOvr >= 16) ? 'Medalja na velikom takmičenju' :
                    (avgOvr >= 14) ? 'Plasman u završnicu (TOP 8)' :
                    (avgOvr >= 12) ? 'Plasman na prvenstvo / proći grupu' :
                                     'Razvoj i podmlađivanje reprezentacije';
    const objectives = [
      primary,
      'Stabilizovati odbranu (manje isključenja i lakih golova)',
      'Uvesti 2–4 mlađa igrača u rotaciju tokom ciklusa',
      'Poboljšati formu ključnih igrača kroz trening kampove'
    ];

    window.HM_DB.nts[ntKey] = {
      key: ntKey,
      type: 'NT',
      name: nation?.name || state.nt,
      nationCode: code,
      flag: nation?.flag || '',
      leagueId: 'NT',
      leagueName: 'Reprezentacije',
      players: roster,
      staff,
      board,
      finance: { budget: null, wageBudget: null, transferBudget: null }, // reps: no transfers
      pressure,
      primaryGoal: primary,
      objectives,
      boardMeta: { primaryGoal: primary, objectives },
      goalProgress: { v:0, max:100, label: primary },
      pressureProgress: { v: Math.round((pressure/25)*100), max:100, label:'Pritisak javnosti' }
    };
  }

  // ===== Build career snapshot =====
  const career = {
    startedAt: Date.now(),
    mode,
    clubKey,
    ntKey,
    leagueId: league.id,
    leagueName: league.name,
    clubName: state.club || null,
    ntName: state.nt || null,
    active: (mode==='NT') ? 'NT' : 'CLUB'
  };

  // copy top-level goal/pressure from active side (used by FM skin narrative)
  if(career.active === 'NT' && ntKey && window.HM_DB.nts?.[ntKey]){
    const ntr = window.HM_DB.nts[ntKey];
    career.primaryGoal = ntr.primaryGoal;
    career.pressure = ntr.pressure;
    career.objectives = ntr.objectives;
  }else if(clubKey && window.HM_DB.clubs?.[clubKey]){
    const cr = window.HM_DB.clubs[clubKey];
    career.primaryGoal = cr.primaryGoal;
    career.pressure = cr.pressure;
    career.objectives = cr.objectives;
  }

  state.career = career;
  state.db = window.HM_DB;
  window.HM_DB.career = career;

  // Wire CAREER lists for clickable player/staff cards (global project rule)
  if(career.active === 'NT' && ntKey){
    const ntRef = window.HM_DB.nts[ntKey] || null;
    state._careerPlayers = ntRef ? (ntRef.players || []) : [];
    state._careerStaff = ntRef ? (ntRef.staff || []) : [];
  }else{
    const cc = (clubKey ? (window.HM_DB.clubs[clubKey] || null) : null);
    state._careerPlayers = cc ? (cc.players || cc.squad || []) : [];
    state._careerStaff = cc ? (cc.staff || []) : [];
  }

  try{ localStorage.setItem("hm_career_v1", JSON.stringify(career)); }catch(e){}

  state.screen = "fm";
  render();
}


const COUNTRIES = [["Afghanistan", "AF", "🇦🇫"], ["Albania", "AL", "🇦🇱"], ["Algeria", "DZ", "🇩🇿"], ["Andorra", "AD", "🇦🇩"], ["Angola", "AO", "🇦🇴"], ["Antigua and Barbuda", "AG", "🇦🇬"], ["Argentina", "AR", "🇦🇷"], ["Armenia", "AM", "🇦🇲"], ["Australia", "AU", "🇦🇺"], ["Austria", "AT", "🇦🇹"], ["Azerbaijan", "AZ", "🇦🇿"], ["Bahamas", "BS", "🇧🇸"], ["Bahrain", "BH", "🇧🇭"], ["Bangladesh", "BD", "🇧🇩"], ["Barbados", "BB", "🇧🇧"], ["Belarus", "BY", "🇧🇾"], ["Belgium", "BE", "🇧🇪"], ["Belize", "BZ", "🇧🇿"], ["Benin", "BJ", "🇧🇯"], ["Bhutan", "BT", "🇧🇹"], ["Bolivia", "BO", "🇧🇴"], ["Bosnia and Herzegovina", "BA", "🇧🇦"], ["Botswana", "BW", "🇧🇼"], ["Brazil", "BR", "🇧🇷"], ["Brunei", "BN", "🇧🇳"], ["Bulgaria", "BG", "🇧🇬"], ["Burkina Faso", "BF", "🇧🇫"], ["Burundi", "BI", "🇧🇮"], ["Cabo Verde", "CV", "🇨🇻"], ["Cambodia", "KH", "🇰🇭"], ["Cameroon", "CM", "🇨🇲"], ["Canada", "CA", "🇨🇦"], ["Central African Republic", "CF", "🇨🇫"], ["Chad", "TD", "🇹🇩"], ["Chile", "CL", "🇨🇱"], ["China", "CN", "🇨🇳"], ["Colombia", "CO", "🇨🇴"], ["Comoros", "KM", "🇰🇲"], ["Congo (Democratic Republic of the)", "CD", "🇨🇩"], ["Congo (Republic of the)", "CG", "🇨🇬"], ["Costa Rica", "CR", "🇨🇷"], ["Croatia", "HR", "🇭🇷"], ["Cuba", "CU", "🇨🇺"], ["Cyprus", "CY", "🇨🇾"], ["Czechia", "CZ", "🇨🇿"], ["Côte d’Ivoire", "CI", "🇨🇮"], ["Denmark", "DK", "🇩🇰"], ["Djibouti", "DJ", "🇩🇯"], ["Dominica", "DM", "🇩🇲"], ["Dominican Republic", "DO", "🇩🇴"], ["Ecuador", "EC", "🇪🇨"], ["Egypt", "EG", "🇪🇬"], ["El Salvador", "SV", "🇸🇻"], ["Equatorial Guinea", "GQ", "🇬🇶"], ["Eritrea", "ER", "🇪🇷"], ["Estonia", "EE", "🇪🇪"], ["Eswatini", "SZ", "🇸🇿"], ["Ethiopia", "ET", "🇪🇹"], ["Fiji", "FJ", "🇫🇯"], ["Finland", "FI", "🇫🇮"], ["France", "FR", "🇫🇷"], ["Gabon", "GA", "🇬🇦"], ["Gambia", "GM", "🇬🇲"], ["Georgia", "GE", "🇬🇪"], ["Germany", "DE", "🇩🇪"], ["Ghana", "GH", "🇬🇭"], ["Greece", "GR", "🇬🇷"], ["Grenada", "GD", "🇬🇩"], ["Guatemala", "GT", "🇬🇹"], ["Guinea", "GN", "🇬🇳"], ["Guinea-Bissau", "GW", "🇬🇼"], ["Guyana", "GY", "🇬🇾"], ["Haiti", "HT", "🇭🇹"], ["Honduras", "HN", "🇭🇳"], ["Hungary", "HU", "🇭🇺"], ["Iceland", "IS", "🇮🇸"], ["India", "IN", "🇮🇳"], ["Indonesia", "ID", "🇮🇩"], ["Iran", "IR", "🇮🇷"], ["Iraq", "IQ", "🇮🇶"], ["Ireland", "IE", "🇮🇪"], ["Israel", "IL", "🇮🇱"], ["Italy", "IT", "🇮🇹"], ["Jamaica", "JM", "🇯🇲"], ["Japan", "JP", "🇯🇵"], ["Jordan", "JO", "🇯🇴"], ["Kazakhstan", "KZ", "🇰🇿"], ["Kenya", "KE", "🇰🇪"], ["Kiribati", "KI", "🇰🇮"], ["Kuwait", "KW", "🇰🇼"], ["Kyrgyzstan", "KG", "🇰🇬"], ["Laos", "LA", "🇱🇦"], ["Latvia", "LV", "🇱🇻"], ["Lebanon", "LB", "🇱🇧"], ["Lesotho", "LS", "🇱🇸"], ["Liberia", "LR", "🇱🇷"], ["Libya", "LY", "🇱🇾"], ["Liechtenstein", "LI", "🇱🇮"], ["Lithuania", "LT", "🇱🇹"], ["Luxembourg", "LU", "🇱🇺"], ["Madagascar", "MG", "🇲🇬"], ["Malawi", "MW", "🇲🇼"], ["Malaysia", "MY", "🇲🇾"], ["Maldives", "MV", "🇲🇻"], ["Mali", "ML", "🇲🇱"], ["Malta", "MT", "🇲🇹"], ["Marshall Islands", "MH", "🇲🇭"], ["Mauritania", "MR", "🇲🇷"], ["Mauritius", "MU", "🇲🇺"], ["Mexico", "MX", "🇲🇽"], ["Micronesia", "FM", "🇫🇲"], ["Moldova", "MD", "🇲🇩"], ["Monaco", "MC", "🇲🇨"], ["Mongolia", "MN", "🇲🇳"], ["Montenegro", "ME", "🇲🇪"], ["Morocco", "MA", "🇲🇦"], ["Mozambique", "MZ", "🇲🇿"], ["Myanmar", "MM", "🇲🇲"], ["Namibia", "NA", "🇳🇦"], ["Nauru", "NR", "🇳🇷"], ["Nepal", "NP", "🇳🇵"], ["Netherlands", "NL", "🇳🇱"], ["New Zealand", "NZ", "🇳🇿"], ["Nicaragua", "NI", "🇳🇮"], ["Niger", "NE", "🇳🇪"], ["Nigeria", "NG", "🇳🇬"], ["North Korea", "KP", "🇰🇵"], ["North Macedonia", "MK", "🇲🇰"], ["Norway", "NO", "🇳🇴"], ["Oman", "OM", "🇴🇲"], ["Pakistan", "PK", "🇵🇰"], ["Palau", "PW", "🇵🇼"], ["Panama", "PA", "🇵🇦"], ["Papua New Guinea", "PG", "🇵🇬"], ["Paraguay", "PY", "🇵🇾"], ["Peru", "PE", "🇵🇪"], ["Philippines", "PH", "🇵🇭"], ["Poland", "PL", "🇵🇱"], ["Portugal", "PT", "🇵🇹"], ["Qatar", "QA", "🇶🇦"], ["Romania", "RO", "🇷🇴"], ["Russia", "RU", "🇷🇺"], ["Rwanda", "RW", "🇷🇼"], ["Saint Kitts and Nevis", "KN", "🇰🇳"], ["Saint Lucia", "LC", "🇱🇨"], ["Saint Vincent and the Grenadines", "VC", "🇻🇨"], ["Samoa", "WS", "🇼🇸"], ["San Marino", "SM", "🇸🇲"], ["Sao Tome and Principe", "ST", "🇸🇹"], ["Saudi Arabia", "SA", "🇸🇦"], ["Senegal", "SN", "🇸🇳"], ["Serbia", "RS", "🇷🇸"], ["Seychelles", "SC", "🇸🇨"], ["Sierra Leone", "SL", "🇸🇱"], ["Singapore", "SG", "🇸🇬"], ["Slovakia", "SK", "🇸🇰"], ["Slovenia", "SI", "🇸🇮"], ["Solomon Islands", "SB", "🇸🇧"], ["Somalia", "SO", "🇸🇴"], ["South Africa", "ZA", "🇿🇦"], ["South Korea", "KR", "🇰🇷"], ["South Sudan", "SS", "🇸🇸"], ["Spain", "ES", "🇪🇸"], ["Sri Lanka", "LK", "🇱🇰"], ["Sudan", "SD", "🇸🇩"], ["Suriname", "SR", "🇸🇷"], ["Sweden", "SE", "🇸🇪"], ["Switzerland", "CH", "🇨🇭"], ["Syria", "SY", "🇸🇾"], ["Taiwan", "TW", "🇹🇼"], ["Tajikistan", "TJ", "🇹🇯"], ["Tanzania", "TZ", "🇹🇿"], ["Thailand", "TH", "🇹🇭"], ["Timor-Leste", "TL", "🇹🇱"], ["Togo", "TG", "🇹🇬"], ["Tonga", "TO", "🇹🇴"], ["Trinidad and Tobago", "TT", "🇹🇹"], ["Tunisia", "TN", "🇹🇳"], ["Turkey", "TR", "🇹🇷"], ["Turkmenistan", "TM", "🇹🇲"], ["Tuvalu", "TV", "🇹🇻"], ["Uganda", "UG", "🇺🇬"], ["Ukraine", "UA", "🇺🇦"], ["United Arab Emirates", "AE", "🇦🇪"], ["United Kingdom", "GB", "🇬🇧"], ["United States", "US", "🇺🇸"], ["Uruguay", "UY", "🇺🇾"], ["Uzbekistan", "UZ", "🇺🇿"], ["Vanuatu", "VU", "🇻🇺"], ["Vatican City", "VA", "🇻🇦"], ["Venezuela", "VE", "🇻🇪"], ["Vietnam", "VN", "🇻🇳"], ["Yemen", "YE", "🇾🇪"], ["Zambia", "ZM", "🇿🇲"], ["Zimbabwe", "ZW", "🇿🇼"]];

const COACH_EXPERIENCES = [
  'Bez iskustva','Trener mlađih kategorija','Asistent glavnog trenera','Skaut','Analitičar',
  'Kondicioni trener','Trener golmana','Sportski direktor','Glavni trener'
];

const PLAYER_EXPERIENCES = ['Reprezentativac','Profesionalni igrač','Polu-profesionalni igrač','Amater'];
const ROLES = ['Trener','Trener mlađih kategorija','Asistent glavnog trenera','Skaut','Analitičar'];

const LEAGUES = [

{
  id:'RS1',
  name:'Superliga Srbije (2025/26) 🇷🇸',
  clubs:[
    'RK Partizan',
    'RK Vojvodina',
    'RK Metaloplastika',
    'RK Dinamo Pančevo',
    'RK Radnički Kragujevac',
    'RK Novi Pazar',
    'RK Jugović',
    'RK Šamot 65',
    'RK Crvena zvezda',
    'RK Obilić',
    'RK Kolubara',
    'RK Spartak Subotica'
  ]
},
{ id:'DE1', name:'Bundesliga (Nemačka) 🇩🇪', clubs:['THW Kiel','SC Magdeburg','SG Flensburg-Handewitt','Füchse Berlin','Rhein-Neckar Löwen','MT Melsungen','HSV Hamburg','TBV Lemgo Lippe','TSV Hannover-Burgdorf','Frisch Auf! Göppingen','HSG Wetzlar','HC Erlangen','SC DHfK Leipzig','TVB Stuttgart','THSV Eisenach','Bergischer HC','VfL Gummersbach','TuSEM Essen'] },
{ id:'FR1', name:'Starligue (Francuska) 🇫🇷', clubs:['PSG Handball','Montpellier HB','HBC Nantes','Chambéry Savoie','Toulouse','Nîmes','Dunkerque','Limoges','Saint-Raphaël','Aix','Tremblay','Chartres','Ivry','Créteil','Istres','Sélestat','Cesson-Rennes','Besançon'] },
{ id:'ES1', name:'Liga ASOBAL (Španija) 🇪🇸', clubs:['Barça Handbol','Bidasoa Irun','BM Granollers','Ademar León','Logroño La Rioja','BM Benidorm','BM Huesca','BM Guadalajara','BM Cuenca','BM Torrelavega','BM Cangas','BM Nava','BM Anaitasuna','BM Sinfín','BM Puente Genil','BM Aranda','BM Valladolid','BM Sagunto'] },
{ id:'DK1', name:'Herreligaen (Danska) 🇩🇰', clubs:['Aalborg Håndbold','GOG','Skjern Håndbold','Bjerringbro-Silkeborg','KIF Kolding','TTH Holstebro','SønderjyskE','Fredericia HK','Mors-Thy','Ribe-Esbjerg','Nordsjælland','København Håndbold','Aarhus Håndbold','Skive FH','Odense Håndbold','Team Esbjerg','HØJ Elite','TMS Ringsted'] },
{ id:'PL1', name:'Superliga (Poljska) 🇵🇱', clubs:['Industria Kielce','Orlen Wisła Płock','Górnik Zabrze','Azoty Puławy','Chrobry Głogów','Wybrzeże Gdańsk','MMTS Kwidzyn','Kalisz','Zagłębie Lubin','Gwardia Opole','Stal Mielec','Piotrkowianin','Ostrovia Ostrów','Warmia Olsztyn','Energa Koszalin','Pogoń Szczecin','Śląsk Wrocław','MKS Kędzierzyn-Koźle'] },
{ id:'HU1', name:'NB I (Mađarska) 🇭🇺', clubs:['Veszprém KC','Pick Szeged','Tatabánya','Balatonfüred','Ferencváros','Csurgói KK','Gyöngyös','Komló','Eger','Budakalász','Szigetszentmiklós','NEKA','Dabasi KC','Győr','Dunaújváros','Pécs','Békéscsaba','Ceglédi KK'] },
{ id:'SE1', name:'Handbollsligan (Švedska) 🇸🇪', clubs:['IFK Kristianstad','IK Sävehof','Ystads IF','Alingsås HK','HK Malmö','Önnereds HK','Skövde HF','HIF Karlskrona','Amo HK','Guif','Hammarby IF','IFK Skövde','Lugi HF','OV Helsingborg','Drott','Redbergslid','Aranäs','Helsingborg'] },
{ id:'NO1', name:'REMA 1000-ligaen (Norveška) 🇳🇴', clubs:['Elverum','Kolstad','Runar Sandefjord','Drammen HK','Nærbø','Haslum HK','ØIF Arendal','Follo','Bækkelaget','Halden TH','Bergen HK','Kristiansand','Sandnes','Tertnes','Storhamar','Fjellhammer','Viking TIF','Bodø HK'] }
];


// --- Model B: realistična jačina liga/klubova (procena) ---
// jačina lige: 1 (najjača) .. 4 (slabija). koristi se za budžete, ekipu i ciljeve.
const LEAGUE_META = {
  DE1:{name:'Bundesliga', strength:1, budgetMin:6000000, budgetMax:14000000,
      top:['THW Kiel','SC Magdeburg','SG Flensburg-Handewitt','Füchse Berlin']},
  FR1:{name:'Starligue', strength:1, budgetMin:5500000, budgetMax:15000000,
      top:['PSG Handball','Montpellier HB','HBC Nantes']},
  ES1:{name:'ASOBAL', strength:2, budgetMin:3500000, budgetMax:9000000,
      top:['Barça Handbol','Bidasoa Irun','BM Granollers']},
  DK1:{name:'Danska liga', strength:1, budgetMin:4500000, budgetMax:12000000,
      top:['Aalborg Håndbold','GOG','Bjerringbro-Silkeborg','Skjern Håndbold']},
  PL1:{name:'Poljska liga', strength:2, budgetMin:2500000, budgetMax:8000000,
      top:['Industria Kielce','Orlen Wisła Płock']},
  HU1:{name:'Mađarska liga', strength:2, budgetMin:2500000, budgetMax:8500000,
      top:['Veszprém KC','Pick Szeged']},
  SE1:{name:'Švedska liga', strength:3, budgetMin:1200000, budgetMax:4000000,
      top:['IFK Kristianstad','IK Sävehof','Ystads IF']},
  NO1:{name:'Norveška liga', strength:3, budgetMin:1200000, budgetMax:4500000,
      top:['Elverum','Kolstad']},
  RS1:{name:'Superliga Srbije', strength:4, budgetMin:450000, budgetMax:1600000,
      top:['RK Vojvodina','RK Partizan','RK Metaloplastika']}
};

function clubFactor(league, clubName){
  const meta = LEAGUE_META[league.id] || {top:[]};
  // top klubovi dobijaju veću jačinu
  if(meta.top && meta.top.includes(clubName)) return 1.0;
  // ostali: gradacija po listi klubova
  const idx = Math.max(0, league.clubs.indexOf(clubName));
  const t = league.clubs.length<=1 ? 0.5 : 1 - (idx/(league.clubs.length-1)); // 1..0
  return 0.35 + 0.55*t; // 0.35..0.90
}

// ===== Player tiering & realism rules (global-ish) =====
// user rule: 20% "top two-way" (only in top European clubs), 50% mid (specialists), 30% low/potential (<22 can have higher potential)
function clubTier(league, clubName){
  const meta = LEAGUE_META[league.id] || {};
  const isMetaTop = (meta.top && meta.top.includes(clubName));
  // "Top European clubs" are the elite group, not merely league leaders in weaker leagues
  if(isMetaTop && (meta.strength===1 || meta.strength===2)) return 'EURO_TOP';
  // Strong leagues but not elite clubs
  if(meta.strength===1 || meta.strength===2) return 'EURO_MID';
  // Domestic / weaker leagues (e.g., Serbia Superliga)
  if(meta.strength>=3){
    // even "top" clubs here are domestic top, not European elite
    if(isMetaTop) return 'DOM_TOP';
    return 'DOM_MID';
  }
  return 'DOM_MID';
}

function pickTier(prnd, tier){
  // returns: 'TOP', 'MID', 'LOW'
  const r = prnd();
  // Make sure only EURO_TOP can ever receive TOP players
  if(tier === 'EURO_TOP'){
    // higher concentration of TOP inside elite clubs so global share ~20%
    if(r < 0.48) return 'TOP';
    if(r < 0.83) return 'MID';
    return 'LOW';
  }
  // all other clubs: no TOP
  if(tier === 'EURO_MID'){
    if(r < 0.62) return 'MID';
    return 'LOW';
  }
  if(tier === 'DOM_TOP'){
    if(r < 0.72) return 'MID';
    return 'LOW';
  }
  // DOM_MID
  if(r < 0.52) return 'MID';
  return 'LOW';
}

function pickProfile(prnd, pos, tier){
  // profile influences how stats split between offense/defense
  if(pos === 'GK'){
    if(tier === 'TOP') return 'GK_ELITE';
    if(tier === 'MID') return 'GK_SOLID';
    return 'GK_POTENTIAL';
  }
  if(tier === 'TOP') return 'TWO_WAY';
  const r = prnd();
  // mid/low: specialists are common
  if(r < 0.42) return 'ATTACK';
  if(r < 0.84) return 'DEFENSE';
  return 'BALANCED';
}

function overallFromTier(prnd, leagueId, clubTierName, playerTier, age){
  // produce realistic overall bands (1–20)
  let o;
  if(playerTier === 'TOP'){
    o = rInt(16, 18, prnd);
  } else if(playerTier === 'MID'){
    o = rInt(12, 16, prnd);
  } else {
    // low
    o = rInt(8, 13, prnd);
    // young talent can have a slightly higher current level
    if(age < 22 && prnd() < 0.35) o = clamp20(o + 2);
  }

  // Domestic leagues cap: no true elite in average domestic clubs
  if(clubTierName === 'DOM_TOP' || clubTierName === 'DOM_MID'){
    // baseline domestic cap
    let cap = 15;
    let floor = 9;

    // Serbia Superliga: overall quality lower (both players and staff)
    if(leagueId === 'RS1'){
      cap = 13;
      floor = 7;
    }

    o = Math.min(o, cap);
    o = Math.max(o, floor);
  }
  return Math.min(18, clamp20(o));
}

function pickTalentStarKey(prnd, pos, profile){
  // which stat gets ⭐ / boosted (key string used in UI)
  const r = prnd();
  if(pos === 'GK'){
    const keys = [
      'gk_refleksi','gk_postavljanje','gk_jedanNaJedan','gk_odbraneSaKrila',
      'gk_odbraneSpolja','gk_kontrolaOdbijeneLopte','gk_igraNogom','gk_mentalnaStabilnost'
    ];
    return keys[Math.floor(r*keys.length)];
  }
  if(profile === 'ATTACK'){
    const keys = [
      'of_sutSpolja','of_sutIzSkoka','of_sutSaKrila','of_prodor1na1',
      'of_igraSaPivotom','of_finta','of_pregledIgre','of_tehnika'
    ];
    return keys[Math.floor(r*keys.length)];
  }
  if(profile === 'DEFENSE'){
    const keys = [
      'df_duelIgra','df_blokiranje','df_bocnaKretnja','df_anticipacija',
      'df_tvrdoca','df_timskaOdbrana','df_kontrolaFaula'
    ];
    return keys[Math.floor(r*keys.length)];
  }
  // balanced/other
  const keys = [
    'me_odlucivanje','me_koncentracija','me_smirenost','me_radnaEtika','me_liderstvo','me_pozicioniranje','me_disciplina',
    'ph_brzina','ph_snaga','ph_izdrzljivost','ph_agilnost'
  ];
  return keys[Math.floor(r*keys.length)];
}





// --- Takmičenja (start sezone 2025/26) ---
// EHF CL klubovi 2025/26 (zvanični spisak klubova): https://ehfcl.eurohandball.com/men/2025-26/clubs/
function normName(s){
  return (s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9 ]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
const CL_2025_26 = new Set([
  'aalborg handbold','barca','dinamo bucuresti','fuchse berlin','gog',
  'hbc nantes','hc eurofarm pelister','hc zagreb','industria kielce','kolstad handball',
  'one veszprem hc','orlen wisla plock','otp bank pick szeged','paris saint germain','sc magdeburg','sporting clube de portugal'
]);
function europeForClub(league, clubName){
  const n = normName(clubName);
  const alias = {
    'psg handball':'paris saint germain',
    'barca handbol':'barca',
    'barca':'barca',
    'fuchse berlin':'fuchse berlin',
    'gog':'gog',
    'aalborg handbold':'aalborg handbold',
    'kolstad':'kolstad handball',
    'veszprem kc':'one veszprem hc',
    'one veszprem':'one veszprem hc',
    'pick szeged':'otp bank pick szeged',
    'sc pick szeged':'otp bank pick szeged',
    'orlen wisla plock':'orlen wisla plock',
    'rk zagreb':'hc zagreb',
    'hbc nantes':'hbc nantes'
  };
  const nn = alias[n] || n;
  if(CL_2025_26.has(nn)) return {name:'EHF Liga šampiona', short:'CL', icon:'🏆', confirmed:true};
  // Za EL/EC liste možemo proširiti u sledećem koraku (potrebno je mapiranje kompletnih EHF spiskova).
  return {name:'(još nije mapirano)', short:'—', icon:'🧾', confirmed:false};
}


// ---------- Board objectives (club goals) ----------
// Elite/top clubs present in our database (acts like "Top 20 Europe" bucket)
const GLOBAL_TOP20 = [
  'PSG Handball','Barça Handbol','THW Kiel','SC Magdeburg','SG Flensburg-Handewitt',
  'Veszprém KC','Industria Kielce','Pick Szeged','Aalborg Håndbold',
  'Füchse Berlin','Rhein-Neckar Löwen','Montpellier HB','HBC Nantes','GOG','KIF Kolding'
];
function isGlobalTopClub(clubName){
  return GLOBAL_TOP20.includes(String(clubName||'').trim());
}
function pickVariant(key, variants){
  const s = seedFrom(String(key||''));
  return variants[Math.abs(s) % variants.length];
}

function objectiveFor(league, clubName){
  const meta = LEAGUE_META[league.id] || {strength:3};
  const f = clubFactor(league, clubName);
  const top = isGlobalTopClub(clubName) || f>=0.92;

  // Deterministic variants per club (stable between reloads)
  const vTop = pickVariant(clubName, [
    [
      {k:'Liga', v:'Titula (Top 2 obavezno)'},
      {k:'Evropa', v:'Final Four u 3 godine'},
      {k:'Kup', v:'Minimum finale kupa'},
      {k:'Svlačionica', v:'Održati stabilan autoritet trenera'}
    ],
    [
      {k:'Liga', v:'Osvojiti ligu'},
      {k:'Evropa', v:'Najmanje polufinale Evrope'},
      {k:'Standard', v:'Bez poraza od slabijih timova (disciplinovano)'},
      {k:'Razvoj', v:'1 mladi igrač u rotaciji (sekundarno)'}
    ],
    [
      {k:'Liga', v:'Top 2 i borba za titulu'},
      {k:'Evropa', v:'Četvrtfinale minimum (svake sezone)'},
      {k:'Identitet', v:'Brza tranzicija + čvrsta odbrana'},
      {k:'Dugoročno', v:'Evropski trofej u 5 godina'}
    ],
    [
      {k:'Liga', v:'Titula ili otkaz (ambiciozna uprava)'},
      {k:'Evropa', v:'Finale Evrope u 5 godina'},
      {k:'Rotacija', v:'Šira klupa (više rotacija, manje povreda)'},
      {k:'PR', v:'Visok rejting kod navijača (pobede u derbijima)'}
    ]
  ]);

  const vStrong = pickVariant(clubName, [
    [
      {k:'Liga', v:'Top 4 / borba za titulu'},
      {k:'Evropa', v:'Prolazak grupe u Evropi'},
      {k:'Razvoj', v:'Uvesti 1–2 mlada igrača u rotaciju'},
      {k:'Finansije', v:'Ne prekoračiti budžet plata'}
    ],
    [
      {k:'Liga', v:'Top 3'},
      {k:'Kup', v:'Minimum polufinale kupa'},
      {k:'Evropa', v:'Minimum osmina/četvrtfinale (u 3 godine)'},
      {k:'Prodaja', v:'1 transfer profit (pametna kupovina/prodaja)'}
    ],
    [
      {k:'Liga', v:'Top 5 uz atraktivnu igru'},
      {k:'Identitet', v:'Visok tempo i agresivna odbrana'},
      {k:'Mladi', v:'Minutaža U21: 600+ minuta'},
      {k:'Stabilnost', v:'Bez velikih oscilacija forme'}
    ]
  ]);

  const vMid = pickVariant(clubName, [
    [
      {k:'Liga', v:'Gornja polovina tabele'},
      {k:'Kup', v:'Najmanje polufinale kupa'},
      {k:'Finansije', v:'Stabilan budžet (bez minusa)'},
      {k:'Razvoj', v:'2 mlada igrača u rotaciji'}
    ],
    [
      {k:'Liga', v:'Sredina tabele (bez borbe za opstanak)'},
      {k:'Razvoj', v:'U23 čini 30% rotacije'},
      {k:'Prodaja', v:'Razviti i prodati 1 igrača uz profit'},
      {k:'Timski duh', v:'Dobar moral tokom sezone'}
    ],
    [
      {k:'Liga', v:'Top 8 / napad na Evropu u 4–5 godina'},
      {k:'Identitet', v:'Jaka odbrana kao baza (6–0 / 5–1)'},
      {k:'Finansije', v:'Kontrolisati plate'},
      {k:'Razvoj', v:'1 igrač +1 ukupna ocena tokom sezone'}
    ]
  ]);

  const vLow = pickVariant(clubName, [
    [
      {k:'Liga', v:'Opstanak (izbeći ispadanje)'},
      {k:'Razvoj', v:'Forsirati mlade (U21 minutaža 1200+)'},
      {k:'Finansije', v:'Ne praviti dug'},
      {k:'Timski duh', v:'Podići moral ekipe'}
    ],
    [
      {k:'Liga', v:'Opstanak bez baraža'},
      {k:'Stabilnost', v:'Uigrati tim (šira rotacija)'},
      {k:'Razvoj', v:'Dovesti 2 perspektivna igrača (<22)'},
      {k:'Finansije', v:'Smanjiti troškove za 10% u 2 godine'}
    ],
    [
      {k:'Liga', v:'Izbeći dno tabele'},
      {k:'Razvoj', v:'4 domaća igrača u rotaciji'},
      {k:'Kup', v:'Iznenađenje u kupu (četvrtfinale)'},
      {k:'Dugoročno', v:'Stabilna sredina tabele u 3–4 godine'}
    ]
  ]);

  // Map by strength/tier; elite clubs override to results-heavy
  if(top) return vTop;

  if(f>=0.78) return vStrong;
  if(f>=0.55) return vMid;
  return vLow;
}


const NTS = ['Srbija 🇷🇸','Hrvatska 🇭🇷','Francuska 🇫🇷','Danska 🇩🇰','Nemačka 🇩🇪','Španija 🇪🇸','Švedska 🇸🇪','Norveška 🇳🇴','Mađarska 🇭🇺','Poljska 🇵🇱'];

const RATING_KEYS = [
 'Taktika','Ofanzivna taktika','Defanzivna taktika','Tranzicija','Tehnika',
 'Psihologija','Motivacija','Rad sa mladjim igracima','Komunikacija sa igracima'
];

function leagueById(id){ return LEAGUES.find(l=>l.id===id); }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function toNumClamp(v,min,max,fallback){ const n = Number(v); return Number.isFinite(n) ? clamp(n,min,max) : fallback; }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }

function fillCountryOptions(sel){
  sel.innerHTML = COUNTRIES.map(([name, code, flag])=>`<option value="${code}">${flag} ${name}</option>`).join('');
}

// ---------- Ratings & difficulty ----------
function coachBase(exp){
  switch(exp){
    case 'Glavni trener': return 6;
    case 'Sportski direktor': return 5;
    case 'Asistent glavnog trenera': return 4;
    case 'Trener mlađih kategorija': return 2;
    case 'Skaut': return 2;
    case 'Analitičar': return 2;
    case 'Kondicioni trener': return 1;
    case 'Trener golmana': return 1;
    default: return 0;
  }
}
function playerBase(exp){
  switch(exp){
    case 'Reprezentativac': return 6;
    case 'Profesionalni igrač': return 4;
    case 'Polu-profesionalni igrač': return 2;
    default: return 0;
  }
}
function roleBias(role){
  const b={};
  RATING_KEYS.forEach(k=>b[k]=0);
  if(role==='Analitičar'){ b['Taktika']+=2; b['Defanzivna taktika']+=1; b['Tranzicija']+=1; }
  if(role==='Skaut'){ b['Tehnika']+=1; b['Komunikacija sa igracima']+=1; b['Psihologija']+=1; }
  if(role==='Trener mlađih kategorija'){ b['Rad sa mladjim igracima']+=3; b['Motivacija']+=1; b['Psihologija']+=1; }
  if(role==='Asistent glavnog trenera'){ b['Taktika']+=1; b['Ofanzivna taktika']+=1; b['Defanzivna taktika']+=1; }
  if(role==='Trener'){ b['Motivacija']+=1; b['Komunikacija sa igracima']+=1; }
  return b;
}

function computeManagerAttributesFromRatings(ratings, profile){
  const T = ratings['Taktika']||10;
  const OFF = ratings['Ofanzivna taktika']||10;
  const DEF = ratings['Defanzivna taktika']||10;
  const TR = ratings['Tranzicija']||10;
  const TECH = ratings['Tehnika']||10;
  const PSY = ratings['Psihologija']||10;
  const MOT = ratings['Motivacija']||10;
  const YTH = ratings['Rad sa mladjim igracima']||10;
  const COM = ratings['Komunikacija sa igracima']||10;

  const comm = profile.communicationStyle || 'calm';
  const a = ()=>randInt(-1,2);
  const wavg = (arr)=>arr.reduce((x,y)=>x+y,0)/arr.length;
  const v = (n)=>clamp(Math.round(n),1,20);

  return {
    tactical:{
      postavkaNapada: v(wavg([OFF,T,TECH])+a()),
      postavkaOdbrane: v(wavg([DEF,T])+a()),
      prilagodjavanjeProtivniku: v(wavg([T,PSY])+a()),
      citanjeUtakmice: v(wavg([T,PSY])+a()),
      tajmingIzmena: v(wavg([T,COM])+a()),
      varijacijeSistema: v(wavg([T,OFF,DEF])+a())
    },
    training:{
      planiranjeTreninga: v(wavg([TECH,T])+a()),
      razvojMladih: v(YTH+a()),
      fizickaPriprema: v(wavg([TECH,TR])+a()),
      individualniRad: v(wavg([COM,YTH])+a()),
      prevencijaPovreda: v(wavg([TECH,PSY])+a())
    },
    mental:{
      motivacija: v(MOT+a()),
      autoritet: v(wavg([PSY,T]) + (comm==='authoritative'?2:0) + a()),
      smirenostPodPritiskom: v(wavg([PSY,T]) + (comm==='calm'?2:0) + a()),
      disciplina: v(wavg([PSY,T]) + (comm==='authoritative'?1:0) + a()),
      komunikacija: v(COM + (comm==='friendly'?1:0) + a()),
      vodjenjeSvlačionice: v(wavg([COM,MOT,PSY])+a())
    },
    strategic:{
      dugorocnoPlaniranje: v(wavg([T,PSY])+a()),
      rotacija: v(wavg([T,COM])+a()),
      upravljanjeFormom: v(wavg([PSY,TR])+a()),
      upravljanjeMinutazom: v(wavg([COM,PSY])+a()),
      razvojMladihTokomSezone: v(wavg([YTH,MOT])+a())
    },
    impact:{
      efekatTajmAuta: v(wavg([MOT,COM])+a()),
      reakcijaUKrizi: v(wavg([PSY,MOT])+a()),
      vodjenjeZavrsnice: v(wavg([PSY,T])+a()),
      vodjenjeDerbija: v(wavg([PSY,MOT])+a()),
      vodjenjeVelikihTakmicenja: v(wavg([T,PSY,MOT])+a())
    }
  };
}

function computeRatingsAndDifficulty(){
  const base = 6 + coachBase(state.profile.coachExperience) + playerBase(state.profile.playerExperience);
  const bias = roleBias(state.profile.role);

  // NEW: formation + communication style modifiers (small, keeps balance)
  const form = state.profile.preferredFormation || '6-0';
  const comm = state.profile.communicationStyle || 'calm';

  const mod = {};
  RATING_KEYS.forEach(k=>mod[k]=0);

  if(form==='6-0'){ mod['Taktika']+=1; mod['Defanzivna taktika']+=1; }
  if(form==='5-1'){ mod['Defanzivna taktika']+=1; mod['Tranzicija']+=1; }
  if(form==='3-2-1'){ mod['Tranzicija']+=2; mod['Psihologija']+=1; }
  if(form==='7-6'){ mod['Ofanzivna taktika']+=2; mod['Taktika']+=1; mod['Defanzivna taktika']-=1; }

  if(comm==='calm'){ mod['Psihologija']+=2; mod['Taktika']+=1; }
  if(comm==='motivator'){ mod['Motivacija']+=3; mod['Komunikacija sa igracima']+=1; }
  if(comm==='authoritative'){ mod['Psihologija']+=2; mod['Komunikacija sa igracima']-=1; }
  if(comm==='friendly'){ mod['Komunikacija sa igracima']+=2; mod['Rad sa mladjim igracima']+=1; }

  const ratings={};
  RATING_KEYS.forEach(k=>{
    const jitter = randInt(-1,2);
    ratings[k]=clamp(base+(bias[k]||0)+(mod[k]||0)+jitter,1,20);
  });

  const avg = Object.values(ratings).reduce((a,b)=>a+b,0)/RATING_KEYS.length;
  let diff = clamp(Math.round(10-(avg/2)),2,8);

  // Keep existing difficulty rules
  if(state.profile.coachExperience==='Trener mlađih kategorija' && state.profile.playerExperience==='Amater') diff=clamp(diff+1,2,8);
  if(state.profile.coachExperience==='Asistent glavnog trenera' && state.profile.playerExperience==='Reprezentativac') diff=clamp(diff-1,2,8);

  // NEW: slight complexity bump
  if(form==='7-6' || form==='3-2-1') diff = clamp(diff+1,2,8);
  if(comm==='calm' && avg>=13) diff = clamp(diff-1,2,8);

  state.ratings=ratings;
  state.difficulty={level:diff, avg: Math.round(avg*10)/10};

  // NEW: full coach attributes (same model as coaches/staff)
  state.managerAttributes = computeManagerAttributesFromRatings(ratings, state.profile);
}

function prettyKey(k){
  const map = {
    postavkaNapada:'Postavka napada',
    postavkaOdbrane:'Postavka odbrane',
    prilagodjavanjeProtivniku:'Prilagođavanje protivniku',
    citanjeUtakmice:'Čitanje utakmice',
    tajmingIzmena:'Tajming izmena',
    varijacijeSistema:'Varijacije sistema',
    planiranjeTreninga:'Planiranje treninga',
    razvojMladih:'Razvoj mladih',
    fizickaPriprema:'Fizička priprema',
    individualniRad:'Individualni rad',
    prevencijaPovreda:'Prevencija povreda',
    motivacija:'Motivacija',
    autoritet:'Autoritet',
    smirenostPodPritiskom:'Smirenost pod pritiskom',
    disciplina:'Disciplina',
    komunikacija:'Komunikacija',
    vodjenjeSvlačionice:'Vođenje svlačionice',
    dugorocnoPlaniranje:'Dugoročno planiranje',
    rotacija:'Rotacija',
    upravljanjeFormom:'Upravljanje formom',
    upravljanjeMinutazom:'Upravljanje minutažom',
    razvojMladihTokomSezone:'Razvoj mladih tokom sezone',
    efekatTajmAuta:'Efekat tajm-auta',
    reakcijaUKrizi:'Reakcija u krizi',
    vodjenjeZavrsnice:'Vođenje završnice',
    vodjenjeDerbija:'Vođenje derbija',
    vodjenjeVelikihTakmicenja:'Vođenje velikih takmičenja'
  };
  return map[k] || k;
}

function difficultyLabel(d){
  if(d>=8) return 'Vrlo teško';
  if(d>=6) return 'Teško';
  if(d>=4) return 'Srednje';
  return 'Lakše (ali ne prelako)';
}
// ----- Pressure / Morale (Step 7 summary) -----
function pressureToNum(p){
  if(p==null) return 3;
  if(typeof p === 'number') return clamp(Math.round(p),1,5);
  const s = String(p).toLowerCase();
  if(s.includes('ekstrem') || s.includes('ogroman')) return 5;
  if(s.includes('visok')) return 5;
  if(s.includes('sred')) return 3;
  if(s.includes('niz')) return 2;
  return 3;
}


function progressBarHTML(pct){
  const v = clamp(pct,0,100);
  const cls = v < 30 ? "fm-progress low" : "fm-progress";
  return `<div class="${cls}"><span style="width:${v}%"></span></div>`;
}

function startGoalProgress(league, clubName){
  const gp = clubGoalsAndPressure(league, clubName);
  // Default start 50%. Top clubs (pressure 5) start 60–65%.
  if(gp.pressure >= 5) return 60 + Math.floor(Math.random()*6); // 60-65
  if(gp.pressure >= 4) return 55; // strong clubs
  return 50;
}
function startPressureProgress(league, clubName){
  const gp = clubGoalsAndPressure(league, clubName);
  // Map pressure 1-5 into a % that starts around mid, with top clubs higher.
  const pct = 40 + (gp.pressure * 5); // 45..65
  return clamp(pct, 0, 100);
}

function clubGoalsAndPressure(league, clubName){
  const objs = objectiveFor(league, clubName) || [];
  const primary = (objs[0] && objs[0].v) ? objs[0].v : 'Stabilna sezona';
  const t = primary.toLowerCase();

  // Base pressure from the wording of the main objective
  let p = 3;
  if(t.includes('otkaz') || t.includes('tit') || t.includes('šamp') || t.includes('final')) p = 5;
  else if(t.includes('top') || t.includes('evrop') || t.includes('medal') || t.includes('poluf')) p = 4;
  else if(t.includes('sredin') || t.includes('playoff') || t.includes('gornj')) p = 3;
  else if(t.includes('opstan') || t.includes('ispad') || t.includes('baraž') || t.includes('dno')) p = 2;

  // Elite/top clubs: always very high public pressure
  if(isGlobalTopClub(clubName) || clubFactor(league, clubName) >= 0.92){
    p = 5;
  }else{
    const f = clubFactor(league, clubName);
    if(f >= 0.85) p = Math.min(5, p+1);
    if(f <= 0.25) p = Math.max(1, p-1);
  }

  return { primary, pressure: clamp(p,1,5), objectives: objs };
}

function calcMorale(overall, goalsText, pressureNum){
  const g = String(goalsText||'').toLowerCase();
  let goalStress = 0;
  if(g.includes('zlato') || g.includes('final') || g.includes('tit') || g.includes('šamp')) goalStress = 7;
  else if(g.includes('top') || g.includes('evrop') || g.includes('medal') || g.includes('poluf')) goalStress = 4;
  else if(g.includes('sredin') || g.includes('playoff')) goalStress = 2;
  else if(g.includes('opstan') || g.includes('ispad')) goalStress = 1;

  let m = 55 + (overall - 10) * 3 - (pressureNum - 3) * 8 - goalStress;
  m = clamp(Math.round(m), 25, 95);
  return m;
}
function difficultyWithPressure(baseLevel, pressureNum){
  const lvl = clamp(Math.round(baseLevel + (pressureNum - 3)), 1, 10);
  return lvl;
}


// ---------- Crest generator (deterministic, "real-crest vibe") ----------
function hashStr(str){
  let h=2166136261;
  for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
  return (h>>>0);
}
function pick(arr, seed){ return arr[seed % arr.length]; }
function crestSVG(team){
  const seed = hashStr(team);
  const palettes = [
    ['#d7263d','#1b2a41','#f4f4f8'],
    ['#0b1320','#ffd166','#fdfcdc'],
    ['#1b998b','#0b1320','#f4f4f8'],
    ['#0b3d91','#00b4d8','#f4f4f8'],
    ['#2b9348','#55a630','#f4f4f8'],
    ['#111827','#60a5fa','#f4f4f8'],
    ['#7f1d1d','#f59e0b','#fef3c7'],
    ['#4c1d95','#a78bfa','#f5f3ff'],
  ];
  const [c1,c2,c3] = palettes[seed % palettes.length];

  const shield = pick([
    'M28 3 C40 6 49 9 53 11 V30 C53 45 42 53 28 57 C14 53 3 45 3 30 V11 C7 9 16 6 28 3 Z',
    'M28 3 C39 6 50 9 53 12 V29 C53 44 41 52 28 57 C15 52 3 44 3 29 V12 C6 9 17 6 28 3 Z',
    'M28 3 C41 7 50 10 53 12 V31 C53 45 40 53 28 57 C16 53 3 45 3 31 V12 C6 10 15 7 28 3 Z'
  ], seed);

  const pattern = pick(['stripes','split','chevron','band'], seed>>3);
  const starCount = (seed % 3) + 1;
  const initials = (team.replace(/[^A-Za-zŠĐČĆŽšđčćž]/g,'').slice(0,3).toUpperCase() || 'HM');

  let patternShapes = '';
  if(pattern==='stripes'){
    patternShapes = `
      <rect x="0" y="0" width="56" height="56" fill="${c1}"/>
      <rect x="0" y="0" width="56" height="18" fill="${c2}" opacity="0.92"/>
      <rect x="0" y="22" width="56" height="12" fill="${c3}" opacity="0.90"/>
      <rect x="0" y="38" width="56" height="18" fill="${c2}" opacity="0.92"/>
    `;
  } else if(pattern==='split'){
    patternShapes = `
      <rect x="0" y="0" width="28" height="56" fill="${c1}"/>
      <rect x="28" y="0" width="28" height="56" fill="${c2}"/>
      <rect x="0" y="22" width="56" height="12" fill="${c3}" opacity="0.85"/>
    `;
  } else if(pattern==='chevron'){
    patternShapes = `
      <rect x="0" y="0" width="56" height="56" fill="${c2}"/>
      <path d="M-4 8 L28 32 L60 8 L60 24 L28 48 L-4 24 Z" fill="${c1}" opacity="0.95"/>
      <path d="M-6 20 L28 40 L62 20" stroke="${c3}" stroke-width="6" opacity="0.85"/>
    `;
  } else {
    patternShapes = `
      <rect x="0" y="0" width="56" height="56" fill="${c1}"/>
      <path d="M-6 18 H62 V38 H-6 Z" fill="${c2}" opacity="0.95"/>
      <path d="M-6 24 H62" stroke="${c3}" stroke-width="4" opacity="0.9"/>
    `;
  }

  let stars = '';
  for(let i=0;i<starCount;i++){
    stars += `<text x="${18+i*10}" y="14" font-size="10" text-anchor="middle" fill="${c3}" opacity="0.9">★</text>`;
  }

  return `
  <svg class="crestSvg" viewBox="0 0 56 60" xmlns="http://www.w3.org/2000/svg" aria-label="crest">
    <defs>
      <clipPath id="clip${seed}"><path d="${shield}"/></clipPath>
    </defs>
    <g clip-path="url(#clip${seed})">
      ${patternShapes}
      <circle cx="28" cy="34" r="14" fill="rgba(0,0,0,.18)"/>
      <circle cx="28" cy="34" r="12" fill="rgba(255,255,255,.10)"/>
      <text x="28" y="39" font-size="14" text-anchor="middle" font-weight="900" fill="${c3}">${initials}</text>
      ${stars}
    </g>
    <path d="${shield}" fill="none" stroke="rgba(255,255,255,.72)" stroke-width="2"/>
    <path d="${shield}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="4" opacity="0.25"/>
  </svg>`;
}


// ---------- Deterministic data generator (no licenses, "realistic vibe") ----------

function mutateSurname(last){
  if(last.length<5) return last + 'e';
  const i = Math.max(1, Math.floor(last.length/3));
  return last.slice(0,i) + last[i].toLowerCase() + last.slice(i+1);
}

function mulberry32(a){
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
function seedFrom(str){ return hashStr(str) ^ 0x9E3779B9; }


function clamp(n,min,max){ return Math.max(min, Math.min(max,n)); }
function seeded01(seed){
  // deterministic 0..1 based on number seed
  const x = Math.sin(seed*99991.123 + 0.12345) * 10000;
  return x - Math.floor(x);
}
function seededInt(seed, min, max){
  const r = seeded01(seed);
  return Math.floor(min + r*(max-min+1));
}
function moraleTeamType(goalsText){
  const t = (goalsText||"").toLowerCase();
  if(t.includes("tit") || t.includes("osvo") || t.includes("prvak") || t.includes("liga šampiona") || t.includes("liga sampiona")) return "TITLE";
  if(t.includes("opstan") || t.includes("izbeg") || t.includes("spas") || t.includes("baraž") || t.includes("baraz")) return "SURVIVAL";
  return "MID";
}
function moraleBaseRange(teamType, seed){
  // returns [min,max] baseline range for this player before adjustments
  // majority logic built in: most players fall into the "main" band
  const roll = seeded01(seed);
  if(teamType==="TITLE"){
    if(roll < 0.70) return [18,23];   // majority high morale
    if(roll < 0.92) return [14,17];
    return [10,13];
  }
  if(teamType==="SURVIVAL"){
    if(roll < 0.65) return [16,22];   // majority also high (fight spirit)
    if(roll < 0.88) return [10,15];
    return [6,9];
  }
  // MID table
  if(roll < 0.70) return [10,16];     // majority mid morale
  if(roll < 0.90) return [16,19];
  return [6,9];
}
function playerKey(p){
  return (p && p.name ? p.name : "") + "|" + (p && p.club ? p.club : "");
}
function ensureMoraleState(){
  // legacy map (club-only older saves)
  if(!state.morale){ state.morale = {}; }
  // context-aware morale (club vs NT separated)
  if(!state.moraleCtx){ state.moraleCtx = {}; }
  if(!state.ntContext){ state.ntContext = { phase:"camp", matchesPlayed:0 }; }
  if(state.seasonForm==null) state.seasonForm = 0;          // -5..+5
          // -5..+5
  if(state.coachBounce==null) state.coachBounce = 2;        // small initial boost
  if(state.coachBounceGames==null) state.coachBounceGames = 4;
}
function computeInitialMorale(p, goalsText, pressureNum){
  ensureMoraleState();
  const key = playerKey(p);
  const seed = seedFrom(key) + seedFrom(goalsText||"") + (pressureNum||0)*31;
  const type = moraleTeamType(goalsText);
  const [a,b] = moraleBaseRange(type, seed);
  let m = seededInt(seed+7, a, b);

  // pressure: higher pressure makes morale harder to keep
  const pr = (pressureNum||3);
  m -= Math.round((pr-3)*0.8);

  // player quality: stars tend to be a bit more confident, fringe players a bit less
  const o = (p && p.overall!=null) ? p.overall : 14;
  m += Math.round((o-14)/4);

  // individuality noise
  m += seededInt(seed+19, -2, 2);

  // coach bounce at takeover (small)
  m += state.coachBounce || 0;

  return clamp(m,0,25);
}
function getMorale(p, goalsText, pressureNum){
  ensureMoraleState();

  // Determine active context (club vs NT) so the same player can have separate morale.
  let ctxKey = "CLUB:default";
  try{
    if(window.HM_TEAM){
      const r = HM_TEAM.resolve(state);
      ctxKey = (r.kind || "CLUB") + ":" + (r.key || "default");
    }else{
      ctxKey = (state.career && state.career.ntKey) ? ("NT:"+state.career.ntKey) : ("CLUB:"+(state.career && state.career.clubKey ? state.career.clubKey : "default"));
    }
  }catch(e){ /* ignore */ }

  if(!state.moraleCtx[ctxKey]) state.moraleCtx[ctxKey] = {};

  const key = playerKey(p);

  // National team special: "camp morale" init before any matches (mixed, FM-like).
  const isNT = ctxKey.startsWith("NT:");
  const ntMatches = (state.ntContext && typeof state.ntContext.matchesPlayed==="number") ? state.ntContext.matchesPlayed : 0;

  if(state.moraleCtx[ctxKey][key]==null){
    if(isNT && ntMatches===0){
      // one-time camp initialization (do NOT touch club morale)
      let overall = (p && typeof p.overall==="number") ? p.overall : null;
      if(overall==null){
        try{ overall = getDisplayedOverall(p); }catch(e){ overall = 13; }
      }
      const age = (p && typeof p.age==="number") ? p.age : ((p && typeof p.years==="number") ? p.years : 25);
      const base = 13 + Math.floor(Math.random()*5); // 13-17
      const leader = (overall>=15) ? 1 : 0;
      const young = (age<=22) ? -1 : 0;
      const jitter = Math.floor(Math.random()*3) - 1; // -1..+1
      state.moraleCtx[ctxKey][key] = clamp(base + leader + young + jitter, 1, 25);
    }else{
      // default initialization (club-style expectations/pressure)
      state.moraleCtx[ctxKey][key] = computeInitialMorale(p, goalsText, pressureNum);
    }
  }

  // season form effect (results) — keep same behavior
  const formAdj = Math.round((state.seasonForm||0) * 0.6);
  const bounceAdj = (state.coachBounceGames>0) ? 1 : 0;
  return clamp(state.moraleCtx[ctxKey][key] + formAdj + bounceAdj, 1, 25);
}
function applyStaffSeasonDrift(result){
  const base=(result==='W')?1:(result==='L'?-1:0);
  const lists=[state._clubBrowseStaff,state._ntBrowseStaff].filter(Boolean);
  const league=leagueById(state.leagueId)||LEAGUES[0];
  const clubKey=(state.club&&league)?(league.id+'|'+state.club):null;
  for(const list of lists){
    for(const s of list){
      if(!s||!s.attributes) continue;
      const a=s.attributes; const role=s.role||'';
      const chance=(role==='Glavni trener'||role==='Pomoćni trener')?0.20:0.28;
      for(const g of ['tactical','training','mental','strategic','impact']){
        const obj=a[g]||{};
        for(const k in obj){
          if(Math.random()>chance) continue;
          obj[k]=clamp(obj[k]+base+randInt(-1,1),1,20);
        }
      }
    }
  }
  if(clubKey && _clubStartCache[clubKey] && state._clubBrowseStaff){
    _clubStartCache[clubKey].staff = state._clubBrowseStaff.map(s=>({ ...s, attributes: JSON.parse(JSON.stringify(s.attributes||{})) }));
  }
  if(state.ntCode && _ntStartCache[state.ntCode] && state._ntBrowseStaff){
    _ntStartCache[state.ntCode] = state._ntBrowseStaff.map(s=>({ ...s, attributes: JSON.parse(JSON.stringify(s.attributes||{})) }));
  }
}

function applyResult(result){
  // result: "W" "D" "L"
  ensureMoraleState();
  if(result==="W") state.seasonForm = clamp((state.seasonForm||0) + 1, -5, 5);
  if(result==="D") state.seasonForm = clamp((state.seasonForm||0) + 0, -5, 5);
  if(result==="L") state.seasonForm = clamp((state.seasonForm||0) - 1, -5, 5);

  // coach bounce fades out
  if(state.coachBounceGames>0) state.coachBounceGames -= 1;

  // update each stored player morale a bit
  const delta = (result==="W") ? 1 : (result==="D" ? 0 : -1);
  Object.keys(state.morale||{}).forEach(k=>{
    // not everyone reacts the same
    const s = seedFrom(k) + (state.seasonForm||0)*13;
    const indiv = seededInt(s, -1, 1);
    state.morale[k] = clamp(state.morale[k] + delta + (indiv===0?0:Math.sign(indiv)), 1, 25);
  });

  render();
}

function rPick(arr, rnd){ return arr[Math.floor(rnd()*arr.length)]; }
function rInt(a,b,rnd){ return Math.floor(rnd()*(b-a+1))+a; }

const NAME_POOLS = {
  rs:{first:['Marko','Nikola','Miloš','Stefan','Luka','Ivan','Uroš','Filip','Aleksa','Mihajlo'], last:['Jovanović','Petrović','Nikolić','Ilić','Marković','Stojanović','Pavlović','Đorđević','Milenković','Stanković']},
  hr:{first:['Ivan','Marko','Luka','Matej','Filip','Petar','Ante','Josip','Dario','Marin'], last:['Horvat','Kovač','Babić','Marić','Novak','Knežević','Božić','Kralj','Jurić','Vuković']},
  si:{first:['Luka','Jan','Miha','Vid','Anže','Žan','Tilen','Jure','Mark','Nejc'], last:['Novak','Kovačič','Horvat','Zupan','Kranjc','Kovač','Potočnik','Vidmar','Krajnc','Mlakar']},
  de:{first:['Jonas','Felix','Lukas','Max','Noah','Leon','Tim','Jan','Moritz','Paul'], last:['Müller','Schmidt','Schneider','Fischer','Weber','Wagner','Becker','Hoffmann','Koch','Bauer']},
  fr:{first:['Hugo','Lucas','Louis','Noah','Nathan','Ethan','Mathis','Léo','Tom','Arthur'], last:['Martin','Bernard','Dubois','Thomas','Robert','Richard','Petit','Durand','Leroy','Moreau']},
  es:{first:['Carlos','Javier','Daniel','Adrián','Sergio','Álvaro','Mario','Diego','Pablo','Iván'], last:['García','Martínez','López','Sánchez','Pérez','Gómez','Fernández','Ruiz','Díaz','Álvarez']},
  dk:{first:['Mads','Anders','Mikkel','Jonas','Frederik','Oliver','Emil','Mathias','Søren','Nikolaj'], last:['Nielsen','Jensen','Hansen','Pedersen','Andersen','Christensen','Larsen','Sørensen','Rasmussen','Jørgensen']},
  pl:{first:['Jan','Piotr','Kacper','Jakub','Mateusz','Michał','Paweł','Szymon','Tomasz','Oskar'], last:['Nowak','Kowalski','Wiśniewski','Wójcik','Kowalczyk','Kamiński','Lewandowski','Zieliński','Szymański','Woźniak']},
  hu:{first:['Bence','Dániel','Ádám','Márk','Gergő','Balázs','Zoltán','Levente','Tamás','Máté'], last:['Nagy','Kovács','Tóth','Szabó','Horváth','Varga','Kiss','Molnár','Farkas','Balogh']},
  se:{first:['Erik','Liam','Noah','Oliver','William','Elias','Hugo','Oscar','Axel','Nils'], last:['Johansson','Andersson','Karlsson','Nilsson','Eriksson','Larsson','Olsson','Persson','Svensson','Gustafsson']},
  no:{first:['Jakob','Emil','Noah','Oliver','Lucas','Henrik','Sander','Theodor','Oskar','Marius'], last:['Hansen','Johansen','Olsen','Larsen','Andersen','Pedersen','Nilsen','Kristiansen','Jensen','Karlsen']},
  is:{first:['Aron','Björgvin','Einar','Gunnar','Haukur','Jón','Kristján','Magnús','Ólafur','Stefán'], last:['Jónsson','Guðmundsson','Sigurðsson','Einarsson','Kristjánsson','Ólafsson','Stefánsson','Magnússon','Arnarson','Halldórsson']},
  pt:{first:['João','Miguel','Tiago','Rui','Diogo','Bruno','André','Pedro','Nuno','Fábio'], last:['Silva','Santos','Ferreira','Pereira','Costa','Oliveira','Rodrigues','Martins','Gomes','Alves']},
  br:{first:['Lucas','Gabriel','Matheus','Rafael','Bruno','Thiago','Felipe','Daniel','Caio','Henrique'], last:['Silva','Santos','Oliveira','Souza','Lima','Pereira','Costa','Carvalho','Almeida','Ribeiro']},
  nl:{first:['Daan','Sven','Lucas','Sem','Milan','Jesse','Thijs','Bram','Noah','Finn'], last:['de Jong','Jansen','de Vries','van Dijk','Bakker','Visser','Smit','Meijer','de Boer','Mulder']},
  eg:{first:['Ahmed','Mohamed','Omar','Youssef','Mahmoud','Mostafa','Hassan','Karim','Tarek','Amr'], last:['Hassan','Ibrahim','Mostafa','Said','Fathy','Ali','Mahmoud','Kamel','Abdelrahman','El-Sayed']},

  intl:{first:['Alex','David','Milan','Victor','Mateo','Andrej','Rafael','Nico','Theo','Bruno'], last:['Marin','Klein','Popov','Novak','Petrov','Ionescu','Kovač','Santos','Silva','Costa']}
};

const NATIONALITY_MAP = {
  RS:['Serbia','🇷🇸'], DE:['Germany','🇩🇪'], FR:['France','🇫🇷'], ES:['Spain','🇪🇸'], DK:['Denmark','🇩🇰'],
  PL:['Poland','🇵🇱'], HU:['Hungary','🇭🇺'], SE:['Sweden','🇸🇪'], NO:['Norway','🇳🇴'],
  HR:['Croatia','🇭🇷'], SI:['Slovenia','🇸🇮'], IS:['Iceland','🇮🇸'], PT:['Portugal','🇵🇹'], BR:['Brazil','🇧🇷']
};

function flagFor(code){
  const found = COUNTRIES.find(c=>c[1]===code);
  return found ? found[2] : (NATIONALITY_MAP[code]?.[1] || '🏳️');
}
function poolKeyFor(code){
  const m = {RS:'rs',HR:'hr',SI:'si',DE:'de',FR:'fr',ES:'es',DK:'dk',PL:'pl',HU:'hu',SE:'se',NO:'no',IS:'is',PT:'pt',BR:'br',NL:'nl',EG:'eg'};
  return m[code] || 'intl';
}
function genPerson(rnd, natCode){
  const pk = poolKeyFor(natCode);
  const pool = NAME_POOLS[pk] || NAME_POOLS.intl;
  const first = rPick(pool.first, rnd);
  const last  = rPick(pool.last, rnd);
  const name = (first + " " + last).trim();
  return { first, last, name, nat: natCode, flag: flagFor(natCode) };
}
function leagueCountryCode(leagueName){
  const m = leagueName.match(/🇷🇸|🇩🇪|🇫🇷|🇪🇸|🇩🇰|🇵🇱|🇭🇺|🇸🇪|🇳🇴/);
  const flag = m ? m[0] : null;
  const map = {'🇷🇸':'RS','🇩🇪':'DE','🇫🇷':'FR','🇪🇸':'ES','🇩🇰':'DK','🇵🇱':'PL','🇭🇺':'HU','🇸🇪':'SE','🇳🇴':'NO'};
  return flag ? map[flag] : 'RS';
}
function euro(n){ return new Intl.NumberFormat('sr-RS',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n); }


// Realistic squads (names are pseudonyms; nationalities & squad size match Wikipedia)
const REAL_SQUADS = {
  'PSG Handball': [
    {pos:'GK', nat:'DK', real:'Mikkel Løvkvist'},
    {pos:'GK', nat:'DK', real:'Jannick Green'},
    {pos:'LW', nat:'SE', real:'Emil Mellegård'},
    {pos:'LW', nat:'FR', real:'Mathieu Grébille'},
    {pos:'LW', nat:'NO', real:'Sindre Heldal'},
    {pos:'RW', nat:'SE', real:'Sebastian Karlsson'},
    {pos:'RW', nat:'ES', real:'Ferran Solé'},
    {pos:'PIV', nat:'FR', real:'Karl Konan'},
    {pos:'PIV', nat:'PL', real:'Kamil Syprzak'},
    {pos:'PIV', nat:'FR', real:'Luka Karabatic'},
    {pos:'PIV', nat:'FR', real:'Gauthier Loredon'},
    {pos:'LB', nat:'NO', real:'Simen Lyse'},
    {pos:'LB', nat:'FR', real:'Wallem Peleka'},
    {pos:'LB', nat:'FR', real:'Elohim Prandi'},
    {pos:'CB', nat:'NL', real:'Luc Steins'},
    {pos:'CB', nat:'DK', real:'Jacob Holm'},
    {pos:'CB', nat:'FR', real:'Noah Gaudin'},
    {pos:'RB', nat:'HR', real:'Mateo Maraš'},
    {pos:'RB', nat:'EG', real:'Yahia Omar'},
  ],
  'Barça Handbol': [
    {pos:'GK', nat:'IS', real:'Viktor Gísli Hallgrímsson'},
    {pos:'GK', nat:'DK', real:'Emil Nielsen'},
    {pos:'LW', nat:'ES', real:'Daniel Fernández'},
    {pos:'LW', nat:'ES', real:'Ian Barrufet'},
    {pos:'RW', nat:'SI', real:'Blaž Janc'},
    {pos:'RW', nat:'ES', real:'Aleix Gómez'},
    {pos:'PIV', nat:'ES', real:'Antonio Bazán Legasa'},
    {pos:'PIV', nat:'ES', real:'Òscar Grau'},
    {pos:'PIV', nat:'FR', real:'Ludovic Fabregas'},
    {pos:'PIV', nat:'PT', real:'Luís Frade'},
    {pos:'LB', nat:'SE', real:'Jonathan Carlsbogård'},
    {pos:'LB', nat:'FR', real:"Timothey N'Guessan"},
    {pos:'CB', nat:'SI', real:'Domen Makuc'},
    {pos:'CB', nat:'EG', real:'Seif El-Deraa'},
    {pos:'CB', nat:'ES', real:'Petar Cikusa'},
    {pos:'RB', nat:'FR', real:'Dika Mem'},
    {pos:'RB', nat:'ES', real:'Djordje Cikusa'},
  ],
};

function aliasName(realName, natCode){
  const rnd = mulberry32(seedFrom('alias|' + natCode + '|' + realName));
  const p = genPerson(rnd, natCode);
  return `${p.first} ${mutateSurname(p.last)}`;
}


// Cache for season-start club data (start realism rules apply only at start)
const _clubStartCache = {};
const _ntStartCache = {}; // key: nationCode -> staff list // key: leagueId|clubName -> cached club data

function genClubData(league, clubName){
  const rnd = mulberry32(seedFrom(league.id + '|' + clubName));
  const _ck = league.id + '|' + clubName;
  if(_clubStartCache[_ck]){
    const c=_clubStartCache[_ck];
    return { ...c, squad:(c.squad||[]).map(p=>({...p})), staff:(c.staff||[]).map(s=>({...s, attributes: JSON.parse(JSON.stringify(s.attributes||{}))})), board:(c.board||[]).map(b=>({...b})), previousCoach:({...c.previousCoach, attributes: JSON.parse(JSON.stringify(c.previousCoach.attributes||{}))}) };
  }

  const home = leagueCountryCode(league.name);

  // Budget (Model B)
  const meta = LEAGUE_META[league.id] || {strength:3,budgetMin:1200000,budgetMax:4000000,top:[]};
  const f = clubFactor(league, clubName);
  const budget = Math.round(meta.budgetMin + (meta.budgetMax-meta.budgetMin) * f * (0.75 + rnd()*0.35));
// +-

  // Staff nationalities (mostly home, some intl)
  function natWeighted(){
    const roll = rnd();
    if(roll < 0.70) return home;
    if(roll < 0.85) return rPick(['HR','SI','FR','DE','ES','DK','PL','HU','SE','NO'], rnd);
    return rPick(['BR','PT','IS'], rnd);
  }

  
  // Staff attribute generation (to avoid all-10 ratings)
  function _randAround(base, spread){
    // triangular-ish distribution around base
    const x = (rnd() - rnd()); // [-1..1]
    return clamp(Math.round(base + x * spread), 1, 20);
  }
  const _staffKeys = {
    tactical: ['postavkaNapada','postavkaOdbrane','prilagodjavanjeProtivniku','citanjeUtakmice','tajmingIzmena','varijacijeSistema'],
    training: ['planiranjeTreninga','razvojMladih','fizickaPriprema','individualniRad','prevencijaPovreda'],
    mental:   ['motivacija','autoritet','smirenostPodPritiskom','disciplina','komunikacija','vodjenjeSvlačionice'],
    strategic:['dugorocnoPlaniranje','rotacija','upravljanjeFormom','upravljanjeMinutazom','razvojMladihTokomSezone'],
    impact:   ['efekatTajmAuta','reakcijaUKrizi','vodjenjeZavrsnice','vodjenjeDerbija','vodjenjeVelikihTakmicenja']
  };

  // --- Realism caps for specialist staff roles (do NOT affect head coach & assistant) ---
  function _capAllGroupsExceptTraining(attr){
    ['tactical','mental','strategic','impact'].forEach(g=>{
      Object.keys(attr[g]||{}).forEach(k=>{ attr[g][k] = randInt(5,11); });
    });
  }
  function _capAllGroupsExceptAllowed(attr, allowed){
    ['tactical','training','mental','strategic','impact'].forEach(g=>{
      Object.keys(attr[g]||{}).forEach(k=>{
        const ok = allowed[g] && allowed[g].has(k);
        attr[g][k] = ok ? clamp(attr[g][k], 12, 18) : randInt(5,11);
      });
    });
  }
  function _applySpecialistRoleCaps(role, attr){
    if(role==='Postojeći trener' || role==='Glavni trener' || role==='Pomoćni trener') return attr;
    if(role==='Kondicioni trener'){
      Object.keys(attr.training||{}).forEach(k=>{ attr.training[k] = clamp(attr.training[k], 12, 18); });
      _capAllGroupsExceptTraining(attr);
      return attr;
    }
    if(role==='Fizioterapeut'){
      _capAllGroupsExceptAllowed(attr, { training: new Set(['prevencijaPovreda']) });
      return attr;
    }
    if(role==='Skaut' || role==='Analitičar'){
      _capAllGroupsExceptAllowed(attr, {
        strategic: new Set(['dugorocnoPlaniranje','razvojMladihTokomSezone']),
        tactical: new Set(['citanjeUtakmice'])
      });
      return attr;
    }
    return attr;
  }


  function _roleProfile(role, base){
    // base depends on club strength; role shifts focus
    const prof = {
      tactical: base, training: base, mental: base, strategic: base, impact: base,
      spread: 3
    };
    if(role==='Postojeći trener' || role==='Glavni trener'){
      prof.tactical += 1; prof.mental += 1; prof.impact += 1; prof.spread = 3;
    } else if(role==='Pomoćni trener'){
      prof.tactical += 1; prof.training += 1; prof.spread = 3;
    } else if(role==='Kondicioni trener'){
      prof.training += 2; prof.mental += 0; prof.tactical -= 1; prof.impact -= 1; prof.spread = 3;
    } else if(role==='Trener golmana'){
      prof.training += 1; prof.tactical -= 1; prof.impact -= 1; prof.spread = 3;
    } else if(role==='Fizioterapeut'){
      prof.training += 1; prof.mental += 0; prof.tactical -= 2; prof.impact -= 2; prof.spread = 3;
    } else if(role==='Skaut'){
      prof.strategic += 1; prof.mental += 0; prof.tactical -= 1; prof.impact -= 1; prof.spread = 3;
    } else if(role==='Analitičar'){
      prof.tactical += 1; prof.strategic += 1; prof.impact += 0; prof.training -= 1; prof.spread = 3;
    }
    // clamp group bases
    Object.keys(prof).forEach(k=>{
      if(['tactical','training','mental','strategic','impact'].includes(k)){
        prof[k] = clamp(prof[k], 1, 20);
      }
    });
    return prof;
  }

  function _staffTierFromClubFactor(f){
    // Ranges follow spec: top clubs -> better coaches
    // 20% elite, 15% medium-good, 15% good, 35% medium-bad (with potential), 15% bad
    if(f >= 0.80) return 'elite';
    if(f >= 0.65) return 'midgood';
    if(f >= 0.50) return 'good';
    if(f >= 0.15) return 'midbad';
    return 'bad';
  }

  function _tierBase(tier){
    // Calibrated to avoid too-high staff across the board (scale 1–20)
    if(tier==='elite')   return {base:16.0, spread:2.0};
    if(tier==='midgood') return {base:14.0, spread:2.3};
    if(tier==='good')    return {base:12.5, spread:2.6};
    if(tier==='midbad')  return {base:10.5, spread:3.0};
    return {base:8.5, spread:3.2}; // bad
  }

  function _genStaffAttributes(role){
    const tier = _staffTierFromClubFactor(f);
    const tb = _tierBase(tier);
    // League strength adjustment: weaker leagues (e.g., Serbia RS1) should have lower staff quality
    if(league.id === 'RS1'){
      tb.base -= 2.0;
      tb.spread += 0.4;
    }
    tb.base = Math.max(6.5, tb.base);

    // Role profile shifts focus around tier base (keeps realism per role)
    const P = _roleProfile(role, tb.base);
    P.spread = tb.spread;

    const attr = {};
    Object.keys(_staffKeys).forEach(group=>{
      attr[group] = {};
      _staffKeys[group].forEach(k=>{
        attr[group][k] = _randAround(P[group], P.spread);
      });
    });

    // Apply specialist caps for realism (do NOT touch assistant)
    _applySpecialistRoleCaps(role, attr);

    // mark potential for midbad staff (they can improve later)
    if(tier==='midbad') attr._potential = clamp(Math.round(12 + rnd()*6), 12, 18);
    return attr;
  }

const staff = [
    { role:'Pomoćni trener', ...genPerson(rnd, natWeighted()) },
    { role:'Kondicioni trener', ...genPerson(rnd, natWeighted()) },
    { role:'Trener golmana', ...genPerson(rnd, natWeighted()) },
    { role:'Fizioterapeut', ...genPerson(rnd, natWeighted()) },
    { role:'Skaut', ...genPerson(rnd, natWeighted()) },
    { role:'Analitičar', ...genPerson(rnd, natWeighted()) },
  ];

  // assign staff ratings using the staff model (avoid identical scores)
  staff.forEach(st=>{
    if(!st.attributes) st.attributes = _genStaffAttributes(st.role);

    // basic profile defaults for UI
    st.style = st.style || 'Balansiran';
    st.experienceYears = st.experienceYears || clamp(Math.round(5 + f*12 + rnd()*3), 1, 35);
    st.age = st.age || clamp(Math.round(30 + rnd()*22), 25, 65);
    st.nationality = st.nationality || (st.flag ? st.flag : home);
  });

  const homeNat = leagueCountryCode(league.name);
  const board = [
    { role:'Predsednik', ...genPerson(rnd, homeNat) },
    { role:'Sportski direktor', ...genPerson(rnd, homeNat) },
    { role:'Direktor finansija', ...genPerson(rnd, homeNat) },
    { role:'Član uprave', ...genPerson(rnd, homeNat) }
  ];

  // Squad

  function _capClubTop18(squad){
    const idxs = squad.map((p,i)=>({i,o:(p.overall!=null?p.overall:0)})).filter(x=>x.o>=18).sort((a,b)=>b.o-a.o);
    if(idxs.length<=4) return squad;
    idxs.slice(4).forEach(x=>{
      squad[x.i].overall = 17;
      if(squad[x.i].baseOverall!=null) squad[x.i].baseOverall = Math.min(squad[x.i].baseOverall, 17);
    });
    return squad;
  }

  let squad;
  const realSquad = REAL_SQUADS[clubName];
  const strength = meta.strength || 3;
  const baseO = (strength===1?11:strength===2?10:strength===3?9:8) + (f*4);
  const cTier = clubTier(league, clubName);


  if(realSquad){
    squad = realSquad.map((r,i)=>{
      const prnd = mulberry32(seedFrom('player|' + clubName + '|' + r.real));
      const age = rInt(18, 35, prnd);

      // Realism tiers & profiles
      const pTier = pickTier(prnd, cTier);
      const profile = pickProfile(prnd, r.pos, pTier);
      const starKey = pickTalentStarKey(prnd, r.pos, profile);

      // Overall now follows tier rules (and club tier caps)
      const baseOverall = overallFromTier(prnd, league.id, cTier, pTier, age);
      const overall = baseOverall;

      const fitness = clamp(Math.round(72 + prnd()*26), 55, 100);
      return { pos: r.pos, name: aliasName(r.real, r.nat), nat: r.nat, flag: flagFor(r.nat), age, baseOverall, overall, fitness, tier:pTier, profile, starKey };
    });
  } else {
    const positions = ['GK','GK','LW','RW','LB','RB','CB','CB','PIV','PIV','LW','RW','LB','RB','CB','PIV','GK','CB'];
    squad = positions.map((pos,i)=>{
      const nat = natWeighted();
      const p = genPerson(rnd, nat);
      const age = rInt(18, 35, rnd);

      const pTier = pickTier(rnd, cTier);
      const profile = pickProfile(rnd, pos, pTier);
      const starKey = pickTalentStarKey(rnd, pos, profile);

      const baseOverall = overallFromTier(rnd, league.id, cTier, pTier, age);
      const overall = baseOverall;
      const fitness = clamp(Math.round(70 + rnd()*28), 55, 100);
      return { pos, name: `${p.first} ${mutateSurname(p.last)}`, nat: p.nat, flag: p.flag, age, baseOverall, overall, fitness, tier:pTier, profile, starKey };
    });
  }

  // Apply season-start realism cap: max 4 players with overall 18+
  _capClubTop18(squad);

  // Captain & key player based on overall, with slight randomness
  const sorted = [...squad].sort((a,b)=>b.overall-a.overall);
  const keyPlayer = sorted[0];
  const captain = sorted[1] || sorted[0];

    const previousCoach = { role:'Postojeći trener', ...genPerson(rnd, home), attributes: _genStaffAttributes('Postojeći trener') };
  squad.forEach(p=>ensurePlayerSeasonState(p));
  const _ret = { budget, staff, board, keyPlayer, captain, squad, previousCoach };
  _clubStartCache[_ck] = { ..._ret, squad:(squad||[]).map(p=>({...p})), staff:(staff||[]).map(s=>({...s, attributes: JSON.parse(JSON.stringify(s.attributes||{}))})), board:(board||[]).map(b=>({...b})), previousCoach:({...previousCoach, attributes: JSON.parse(JSON.stringify(previousCoach.attributes||{}))}) };
  return _ret;

}

// ===== National team roster (top players from all clubs) =====
const NT_ROSTER_SIZE = 16;
const _ntRosterCache = {}; // keyed by nation code

function buildNationalRoster(natCode){
  if(_ntRosterCache[natCode]) return _ntRosterCache[natCode];

  let pool = [];
  LEAGUES.forEach(lg=>{
    lg.clubs.forEach(club=>{
      const data = genClubData(lg, club);
      data.squad.forEach(p=>{
        if(p.nat === natCode){
          pool.push({ ...p, club });
        }
      });
    });
  });

  pool.sort((a,b)=>b.overall-a.overall);

  // Keep a basic realistic balance (still "best players")
  const mins = { GK:2, LW:2, RW:2, PIV:2, LB:1, CB:2, RB:1 };
  const picked = [];
  const used = new Set();

  function pickFrom(pos, n){
    let c=0;
    for(const p of pool){
      if(c>=n) break;
      const key = p.name + '|' + p.age + '|' + p.pos + '|' + p.club;
      if(used.has(key)) continue;
      if(p.pos === pos){
        used.add(key);
        picked.push(p);
        c++;
      }
    }
  }

  Object.keys(mins).forEach(pos=>pickFrom(pos, mins[pos]));

  for(const p of pool){
    if(picked.length >= NT_ROSTER_SIZE) break;
    const key = p.name + '|' + p.age + '|' + p.pos + '|' + p.club;
    if(used.has(key)) continue;
    used.add(key);
    picked.push(p);
  }

  const posOrder = {GK:0,LW:1,RW:2,PIV:3,LB:4,CB:5,RB:6};
  picked.sort((a,b)=>{
    const pa = posOrder[a.pos] ?? 99;
    const pb = posOrder[b.pos] ?? 99;
    if(pa!==pb) return pa-pb;
    return b.overall-a.overall;
  });

  _ntRosterCache[natCode] = picked.slice(0, NT_ROSTER_SIZE);
  return _ntRosterCache[natCode];
}


// ---------- UI ----------
function render(){
  // Restore shared DB + career snapshot after refresh (optional)
  if(!state.db && window.HM_DB) state.db = window.HM_DB;
  if(!state.career){
    try{
      const saved = localStorage.getItem("hm_career_v1");
      if(saved) state.career = JSON.parse(saved);
      if(state.career && window.HM_DB) window.HM_DB.career = state.career;
    }catch(e){}
  }
  // If career exists (after refresh), jump directly into FM phase
  if(state.career && state.career.startedAt && state.screen !== "fm"){
    state.screen = "fm";
  }
  // Invisible wiring: keep staff<->(future) tactics/training context always ready
  try{
    if(window.HM_ENGINE && typeof window.HM_ENGINE.recompute === 'function'){
      window.HM_ENGINE.recompute(state);
    }
  }catch(e){}


  if(state.screen === "fm"){
    const root = document.getElementById("app");
    if(window.renderFMSkin){
      try{
        window.renderFMSkin(state, root);
      }catch(e){
        console.error("FM skin render error", e);
        root.innerHTML = `<div style="padding:16px">FM skin greška: ${e && e.message ? e.message : e}</div>`;
      }finally{
        try{ applyI18n(document.body); }catch(e2){}
      }
    } else {
      root.innerHTML = "<div style=\"padding:16px\">FM skin nije učitan (modules/fm_skin.js).</div>";
      try{ applyI18n(document.body); }catch(e2){}
    }
    return;
  }
  try{
  const app=document.getElementById('app');
document.querySelectorAll('.ctaStart').forEach(b=>b.remove());
  app.innerHTML='';

  if(state.step===1){
    app.innerHTML=`
      <section class="card">
        <div class="row"><div class="big">Registracija menadžera</div><span class="badge">Korak 1</span></div>
        <p class="muted">Unesi podatke. Ovo utiče na početne ocene i težinu igre.</p>

        <div class="sectionTitle">🪪 Osnovno <span class="chip">Profil</span></div>
        <div class="grid2" style="margin-top:10px">
          <div><label>Ime</label><input id="fn" placeholder="npr. Miloš" value="${state.profile.firstName}"></div>
          <div><label>Prezime</label><input id="ln" placeholder="npr. Jovanović" value="${state.profile.lastName}"></div>
        </div>

        <div class="grid2" style="margin-top:10px">
          <div>
  <label>Dan rođenja</label>
  <select id="bday"></select>
</div>
<div style="margin-top:6px">
  <label>Mesec rođenja</label>
  <select id="bmonth"><option value='1'>01</option><option value='2'>02</option><option value='3'>03</option><option value='4'>04</option><option value='5'>05</option><option value='6'>06</option><option value='7'>07</option><option value='8'>08</option><option value='9'>09</option><option value='10'>10</option><option value='11'>11</option><option value='12'>12</option></select>
</div>
<div style="margin-top:6px">
  <label>Godina rođenja</label>
  <select id="byear"></select>
</div>
        </div>

        <div style="margin-top:10px">
          <label>Nacionalnost (A–Z)</label>
          <select id="nat" class="select-half"></select>
          <div class="help">Poređano abecedno, sa zastavama.</div>
        </div>

        <hr class="hr"/>

        <div class="sectionTitle">🧠 Pozadina <span class="chip">Karijera</span></div>
        <div class="grid2" style="margin-top:10px">
          <div><label>Prethodno trenersko iskustvo</label><select id="ce">${COACH_EXPERIENCES.map(x=>`<option>${x}</option>`).join('')}</select></div>
          <div><label>Specijalnost</label><select id="role">${ROLES.map(x=>`<option>${x}</option>`).join('')}</select></div>
        </div>
        <div style="margin-top:10px">
          <label>Prethodno igračko iskustvo</label>
          <select class="select-ultra select-half" id="pe">${PLAYER_EXPERIENCES.map(x=>`<option>${x}</option>`).join('')}</select>
        </div>

        <hr class="hr"/>

        <div class="sectionTitle">🧩 Preferencije <span class="chip">Stil igre</span></div>

        <div style="margin-top:10px">
          <label>Preferirana formacija (vizuelni izbor)</label>
          <div class="grid2" style="margin-top:10px">
            <button class="btn formationBtn ${state.profile.preferredFormation==='6-0'?'primary':''}" data-f="6-0">6–0</button>
            <button class="btn formationBtn ${state.profile.preferredFormation==='5-1'?'primary':''}" data-f="5-1">5–1</button>
            <button class="btn formationBtn ${state.profile.preferredFormation==='3-2-1'?'primary':''}" data-f="3-2-1">3–2–1</button>
            <button class="btn formationBtn ${state.profile.preferredFormation==='7-6'?'primary':''}" data-f="7-6">7 na 6</button>
          </div>
          <div class="help">Za sada vizuelno (bez efekta u match engine-u).</div>
        </div>

        <div class="grid2" style="margin-top:10px">
          <div>
            <label>7 na 6 (ofanzivna filozofija)</label>
            <select id="use76">
              <option>Ne</option>
              <option>Da</option>
            </select>
          </div>
          <div>
            <label>Stil komunikacije (početni stil vođenja ekipe)</label>
            <select id="cs">
              <option>Smiren i analitičan</option>
              <option>Motivator</option>
              <option>Strogi autoritet</option>
              <option>Prijateljski</option>
            </select>
          </div>
        </div>

<div class="btnRow wizardNav"><button class="btn primary" id="n1">Nastavi ➜</button></div>
      </section>
    `;


    const y=document.getElementById('byear');
    const start=1950, end=2010;
    y.innerHTML = Array.from({length:end-start+1},(_,i)=>{
      const yr=end-i;
      return `<option value="${yr}">${yr}</option>`;
    }).join('');

    populateBirthDay();


    document.getElementById('bday').value = state.profile.birthDay;
    const bmEl=document.getElementById('bmonth'); if(bmEl) bmEl.value = state.profile.birthMonth;
    document.getElementById('byear').value = state.profile.birthYear;

    const natSel=document.getElementById('nat');
    fillCountryOptions(natSel);
    natSel.value = state.profile.nationalityCode;

    document.getElementById('ce').value = state.profile.coachExperience;
    document.getElementById('role').value = state.profile.role;
    document.getElementById('pe').value = state.profile.playerExperience;

    const use76El = document.getElementById('use76');
    if(use76El) use76El.value = state.profile.use7v6 || 'Ne';
    const csEl = document.getElementById('cs');
    if(csEl) csEl.value = state.profile.communicationStyle || 'Smiren i analitičan';

    document.querySelectorAll('.formationBtn').forEach(btn=>{
      btn.onclick=()=>{
        document.querySelectorAll('.formationBtn').forEach(b=>b.classList.remove('primary'));
        btn.classList.add('primary');
        state.profile.preferredFormation = btn.dataset.f;
      };
    });

    document.getElementById('n1').onclick=()=>{
      const fn=document.getElementById('fn').value.trim();
      const ln=document.getElementById('ln').value.trim();
      if(!fn || !ln) return alert('Upiši ime i prezime.');

      state.profile.firstName=fn;
      state.profile.lastName=ln;
      state.profile.birthDay=parseInt(document.getElementById('bday').value,10);
      state.profile.birthMonth=parseInt((document.getElementById('bmonth')||{value:1}).value,10);
      state.profile.birthYear=parseInt(document.getElementById('byear').value,10);

      state.profile.nationalityCode=natSel.value;
      const found=COUNTRIES.find(c=>c[1]===natSel.value);
      state.profile.nationalityName=found?found[0]:'—';

      state.profile.coachExperience=document.getElementById('ce').value;
      state.profile.role=document.getElementById('role').value;
      state.profile.playerExperience=document.getElementById('pe').value;

      const use76Now = document.getElementById('use76');
      if(use76Now) state.profile.use7v6 = use76Now.value;

      const csNow = document.getElementById('cs');
      if(csNow) state.profile.communicationStyle = csNow.value;

      // preferredFormation is set on click; keep default if none
      if(!state.profile.preferredFormation) state.profile.preferredFormation='6-0';

      computeRatingsAndDifficulty();
      state.step=2;
      render();
    };
    return;
  }

  if(state.step===2){
    const r=state.ratings||{};
    const d=state.difficulty||{level:6,avg:10};
    const fullName = `${state.profile.firstName} ${state.profile.lastName}`;

    app.innerHTML=`
      <section class="card">
        <div class="row"><div class="big">Početne trenerske ocene</div><span class="badge">Korak 2</span></div>
        <p class="muted">Ocene su izračunate iz tvoje pozadine. Ovo direktno utiče na težinu igre.</p>

        <div class="kpiGrid" style="margin-top:10px">
          <div class="kpi"><div class="k">Menadžer</div><div class="v">${fullName}</div></div>
          <div class="kpi"><div class="k">Težina igre</div><div class="v">${difficultyLabel(d.level)} (lvl ${d.level})</div></div>
          <div class="kpi"><div class="k">Prosek ocena</div><div class="v">${d.avg}</div></div>
          <div class="kpi"><div class="k">Pozadina</div><div class="v">${state.profile.coachExperience} • ${state.profile.playerExperience}</div></div>
        </div>

        <hr class="hr"/>

        

        <hr class="hr"/>
        <div class="sectionTitle">🧠 Atributi trenera <span class="chip">isti model</span></div>
        <div id="attrGroups" style="margin-top:10px"></div>

        <div class="btnRow wizardNav">
          <button class="btn" id="b2">⬅ Nazad</button>
          <button class="btn primary" id="n2">Nastavi ➜</button>
        </div>
      </section>
    `;
    const btn=document.createElement('button');
    btn.className='ctaStart'; btn.textContent='Započni karijeru';
    btn.onclick=()=>{ startCareer(); };
    document.body.appendChild(btn);


        // Ocene panel uklonjen – koristi se samo atributni prikaz


    
    // Render full coach-attribute groups
    const attrs = state.managerAttributes || {};
    function groupHtml(title, icon, g){
      const rows = Object.entries(g||{}).map(([k,v])=>{
        const pct = Math.round((v/20)*100);
        return `
          <tr>
            <td class="statName">${prettyKey(k)}</td>
            <td class="statRight">
              <span class="statPill">${v}</span>
              <span class="statBar"><i style="width:${pct}%"></i></span>
            </td>
          </tr>`;
      }).join('');
      return `
        <div class="panel" style="margin-bottom:12px">
          <div class="panelTitle">${icon} ${title}</div>
          <table class="statTable">${rows}</table>
        </div>`;
    }
    const ag = document.getElementById('attrGroups');
    if(ag){
      ag.innerHTML = [
        groupHtml('Taktika', '🧩', attrs.tactical),
        groupHtml('Trening', '🏋️', attrs.training),
        groupHtml('Mentalno', '🧠', attrs.mental),
        groupHtml('Strategija', '📌', attrs.strategic),
        groupHtml('Uticaj', '⚡', attrs.impact)
      ].join('');
    }

    document.getElementById('b2').onclick=()=>{ state.step=1; render(); };
    document.getElementById('n2').onclick=()=>{ state.step=3; render(); };
    return;
  }

  if(state.step===3){
    app.innerHTML=`
      <section class="card">
        <div class="row"><div class="big">Način karijere</div><span class="badge">Korak 3</span></div>
        <div class="smallGrid">
          <label class="choice">
            <input type="radio" name="c" value="CLUB" ${state.career==='CLUB'?'checked':''}>
            <div><div class="choiceTitle">🏟️ Samo klub</div><div class="choiceDesc">Vodiš jedan klub u izabranoj ligi.</div></div>
          </label>
          <label class="choice">
            <input type="radio" name="c" value="NT" ${state.career==='NT'?'checked':''}>
            <div><div class="choiceTitle">🏳️ Samo reprezentacija</div><div class="choiceDesc">Vodiš samo reprezentaciju, bez kluba.</div></div>
          </label>
          <label class="choice">
            <input type="radio" name="c" value="BOTH" ${state.career==='BOTH'?'checked':''}>
            <div><div class="choiceTitle">🏟️ + 🏳️ Klub i reprezentacija</div><div class="choiceDesc">Dual job: klub + reprezentacija.</div></div>
          </label>
        </div>
        <div class="btnRow wizardNav">
          <button class="btn" id="b3">⬅ Nazad</button>
          <button class="btn primary" id="n3">Nastavi ➜</button>
        </div>
      </section>
    `;
    const btn=document.createElement('button');
    btn.className='ctaStart'; btn.textContent='Započni karijeru';
    btn.onclick=()=>{ startCareer(); };
    document.body.appendChild(btn);


    document.getElementById('b3').onclick=()=>{ state.step=2; render(); };
    document.getElementById('n3').onclick=()=>{
      state.career = document.querySelector('input[name="c"]:checked').value;
      if(state.career==='NT'){ state.step=5; }
      else { state.step=4; state.leagueView='LEAGUES'; }
      render();
    };
    return;
  }

  if(state.step===4){
    if(state.leagueView==='LEAGUES'){
      app.innerHTML=`
        <section class="card">
          <div class="row"><div class="big">Izaberi ligu</div><span class="badge">Sezona 2025/26</span></div>
          <p class="muted">8 najjačih liga (kurirano). Klikni na ligu da vidiš sve timove.</p>

          <div class="gridCards" style="margin-top:12px">
            ${LEAGUES.map(l=>`
              <div class="cardItem" onclick="selectLeague('${l.id}')">
                <div class="cardTop">
                  <div class="flagBig">${(l.name.match(/🇩🇪|🇫🇷|🇪🇸|🇩🇰|🇵🇱|🇭🇺|🇸🇪|🇳🇴/)||[])[0] || '🏆'}</div>
                  <div style="min-width:0">
                    <div class="itemTitle">${l.name}</div>
                    <div class="itemSub">${l.clubs.length} klubova</div>
                  </div>
                </div>
                <span class="tag">Top liga</span>
              </div>
            `).join('')}
          </div>

          <div class="btnRow wizardNav">
            <button class="btn" id="b4">⬅ Nazad</button>
          </div>
        </section>
      `;

      document.getElementById('b4').onclick=()=>{ state.step=3; render(); };
      return;
    }

    const league = leagueById(state.leagueId) || LEAGUES[0];
    app.innerHTML=`
      <section class="card">
        <div class="row"><div class="big">Izaberi tim</div><span class="badge">Korak 4</span></div>
        <p class="muted">Liga: <b>${league.name}</b> — Klikni na tim da započneš.</p>

        <div class="gridCards" style="margin-top:12px">
          ${league.clubs.map(c=>`
            <div class="cardItem" onclick="selectClub('${encodeURIComponent(c)}')">
              <div class="cardTop">
                <div class="crestWrap">${crestSVG(c)}</div>
                <div style="min-width:0">
                  <div class="itemTitle">${c}</div>
                  <div class="itemSub">Grb je originalno generisan (bez licenci) • Profesionalni tim</div>
                  <div class="miniBars">
                    <div class="miniRow">
                      <div class="miniLbl">Ciljevi</div>
                      ${progressBarHTML(startGoalProgress(league, c))}
                    </div>
                    <div class="miniRow">
                      <div class="miniLbl">Pritisak</div>
                      ${progressBarHTML(startPressureProgress(league, c))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="btnRow wizardNav">
          <button class="btn" id="backToLeagues">⬅ Lige</button>
        </div>
      </section>
    `;
    const btn=document.createElement('button');
    btn.className='ctaStart'; btn.textContent='Započni karijeru';
    btn.onclick=()=>{ startCareer(); };
    document.body.appendChild(btn);


    document.getElementById('backToLeagues').onclick=()=>{ state.leagueView='LEAGUES'; render(); };
    return;
  }

  
if(state.step===5){
    const nt = state.nt || '';
    const code = nt ? ntToNationCode(nt) : null;
    const fed = nt ? generateFederationOfficials(code) : null;
    const goals = nt ? generateNTGoals(code) : null;
    const staffListNT = nt ? generateNTStaffList(code, nt) : null;
    const staff = nt ? generateNTStaff(code) : null;
    const roster = nt ? buildNationalRoster(code) : null;

    app.innerHTML=`
      <section class="card">
        <div class="row"><div class="big">Izaberi reprezentaciju</div><span class="badge">${state.career==='NT'?'Korak 4':'Korak 5'}</span></div>
        <p class="muted">Izaberi reprezentaciju i ispod vidi: rukovodstvo saveza, ciljeve i stručni štab.</p>

        <label>Reprezentacija</label>
        <select id="ntSel">
          <option value="">— izaberi —</option>
          ${NTS.map(n=>`<option ${nt===n?'selected':''}>${n}</option>`).join('')}
        </select>

        ${nt ? `
          <div class="sectionTitle" style="margin-top:16px">🏛️ Savez <span class="chip">Rukovodstvo</span></div>
          <div class="clubPreviewGrid">
            <div class="clubMiniCard"><div class="miniTitle">Predsednik saveza</div><div class="miniValue">${fed.president}</div></div>
            <div class="clubMiniCard"><div class="miniTitle">Potpredsednik saveza</div><div class="miniValue">${fed.vice}</div></div>
            <div class="clubMiniCard"><div class="miniTitle">Generalni sekretar</div><div class="miniValue">${fed.secretary}</div></div>
            <div class="clubMiniCard"><div class="miniTitle">Portparol</div><div class="miniValue">${fed.spokesperson}</div></div>
          </div>

          <div class="sectionTitle" style="margin-top:16px">🎯 Ciljevi saveza <span class="chip">Realno</span></div>
          <div class="goalsBox">
            <div class="goalRow"><div class="goalLabel">Primarni cilj</div><div class="goalValue">${goals.primary}</div></div>
            <div class="goalRow"><div class="goalLabel">Sekundarni cilj</div><div class="goalValue">${goals.secondary}</div></div>
            <div class="goalRow"><div class="goalLabel">Pritisak javnosti</div><div class="goalValue">${goals.pressure}</div></div>
          </div>

          <div class="sectionTitle" style="margin-top:16px">👥 Reprezentativni roster <span class="chip">Top 16</span></div>
          <div class="tableWrap">
            <table class="table">
              <thead><tr><th>Poz.</th><th>Igrač</th><th>Klub</th><th>Ovr</th></tr></thead>
              <tbody>
                ${(state._ntBrowsePlayers = roster, '')}${roster.map((p,i)=>`<tr><td>${p.pos}</td><td><button type="button" class="linkBtn" onclick="openPlayerCard('BROWSE_NT', ${i})"><b>${p.flag} ${p.name}</b></button></td><td>${p.club}</td><td><b>${getDisplayedOverall(p, 'NT')}</b></td></tr>`).join('')}
              </tbody>
            </table>
          </div>

          <div class="sectionTitle" style="margin-top:16px">🧑‍🏫 Stručni štab <span class="chip">Reprezentacija</span></div>
          <div class="tableWrap">
            <table class="table">
              <thead><tr><th>Uloga</th><th>Ime</th><th>Država</th></tr></thead>
              <tbody>
                ${(state._ntBrowseStaff = (staffListNT||[]), '')}${(staffListNT||[]).map((s,i)=>`
                  <tr>
                    <td><b>${s.role}</b></td>
                    <td><button type="button" class="linkBtn" onclick="openStaffCard('BROWSE_NT', ${i})"><b>${s.name}</b></button></td>
                    <td>${s.flag||''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ``}

        <div class="btnRow wizardNav">
          <button class="btn" id="b5">⬅ Nazad</button>
          <button class="btn primary" id="n5" ${nt?'':'disabled'}>${state.career==='NT'?'Započni ✅':'Nastavi ✅'}</button>
        </div>
      </section>
    `;

    const sel = document.getElementById('ntSel');
    sel.onchange = ()=>{
      state.nt = sel.value;
      // reset per-selection generated data so it refreshes cleanly
      state.federation = null;
      state.ntStaff = null;
      render();
    };

    document.getElementById('b5').onclick=()=>{
      if(state.career==='NT') state.step=3;
      else { state.step=6; }
      render();
    };

    document.getElementById('n5').onclick=()=>{
      if(!state.nt) return;
      state.ntRoster = roster ? roster : null;
      state.step=7;
      render();
    };
    return;
  }
  
  // (Korak 8 - Match centar uklonjen po zahtevu)


if(state.step===6){
    const league = leagueById(state.leagueId) || LEAGUES[0];
    const data = genClubData(league, state.club || '—');
    // Browsing mode: no commitment until Start button

    // Build clickable staff list for this preview (head coach + staff)
    const staffList = [
      { role:'Glavni trener', first:data.previousCoach.first, last:data.previousCoach.last, flag:data.previousCoach.flag, team: state.club, attributes: data.previousCoach.attributes },
      ...(data.staff||[]).map(s=>({ ...s, team: state.club }))
    ].map(s=>({
      ...s,
      name: (s.name || ((s.first||'')+' '+(s.last||''))).trim(),
    }));
    state._clubBrowseStaff = staffList;

    const fullName = `${state.profile.firstName} ${state.profile.lastName}`;

    app.innerHTML = `
      <section class="card">
        <div class="row"><div class="big">Klub: ${state.club}</div><span class="badge">Pregled</span></div>
        <div class="pill2">📅 Sezona <b>2025/26</b></div>
        <div class="pill2" style="margin-left:8px">🎯 Model B: realne procene</div>
        <div class="pill2" style="margin-left:8px">🏆 ${league.name}
</div>

        <div class="topRow">
          <div class="panelCompact">
            <div class="panelTitle">💶 Budžet kluba</div>
            <div class="bigMoney">${euro(data.budget)}</div>
            <div class="itemSub" style="margin-top:6px">Model B (realistična procena).</div>
          </div>

          <div class="panelCompact">
            <div class="panelTitle">👔 Uprava kluba</div>
            <table class="table">
              <thead><tr><th>Uloga</th><th>Ime</th><th>Zemlja</th></tr></thead>
              <tbody>
                ${(data.board && data.board.length ? data.board : []).map(b=>`
                  <tr>
                    <td><b>${b.role}</b></td>
                    <td>${b.first} ${b.last}</td>
                    <td>${b.flag}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="metaGrid">
          <div class="metaBox">
            <div class="metaK">Postojeći trener</div>
            <div class="metaV">${data.previousCoach.first} ${data.previousCoach.last} ${data.previousCoach.flag}</div>
            <div class="itemSub" style="margin-top:4px">Klub već ima trenera; ti preuzimaš projekat.</div>
          </div>
          <div class="metaBox">
            <div class="metaK">Ciljevi uprave</div>
            <div class="objectiveList">
              ${objectiveFor(league, state.club).map(o=>`<div class=\"objective\"><b>${o.k}:</b> ${o.v}</div>`).join('')}
            </div>
          </div>
        </div>

<div class="twoCol" style="margin-top:14px">
          <div class="panel">
            <div class="panelTitle">🧑‍💼 Stručni štab</div>
            <table class="table">
              <thead><tr><th>Uloga</th><th>Ime</th><th>Zemlja</th></tr></thead>
              <tbody>
                ${(staffList||[]).map((s,i)=>`
                  <tr>
                    <td><b>${s.role}</b></td>
                    <td><button type="button" class="linkBtn" onclick="openStaffCard('BROWSE_CLUB', ${i})"><b>${s.name}</b></button></td>
                    <td>${s.flag||''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="panel">
            <div class="panelTitle">⭐ Ključni ljudi</div>
            <div class="playerCard" style="margin-top:10px; cursor:pointer" onclick="openPlayerByName(\'${data.keyPlayer.name}\')">
              <div class="avatar">⭐</div>
              <div>
                <div class="itemTitle">Glavni igrač: ${data.keyPlayer.name}</div>
                <div class="itemSub">${data.keyPlayer.flag} • ${data.keyPlayer.pos} • ${data.keyPlayer.age} god • Ocena ${data.keyPlayer.overall}/20</div>
              </div>
            </div>
            <div class="playerCard" style="margin-top:10px; cursor:pointer" onclick="openPlayerByName(\'${data.keyPlayer.name}\')">
              <div class="avatar">🧢</div>
              <div>
                <div class="itemTitle">Kapiten: ${data.captain.name}</div>
                <div class="itemSub">${data.captain.flag} • ${data.captain.pos} • ${data.captain.age} god • Ocena ${data.captain.overall}/20</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel" style="margin-top:14px">
          <div class="panelTitle">🤾 Ekipa (svi igrači)</div>
          <table class="table">
            <thead><tr><th>#</th><th>Ime</th><th>Poz</th><th>Zemlja</th><th>God</th><th>Ocena</th></tr></thead>
            <tbody>
              ${(state._clubBrowsePlayers = data.squad, state._clubSummaryPlayers = data.squad, '')}
              ${data.squad.map((p,i)=>`
                <tr>
                  <td>${i+1}</td>
                  <td><button type="button" class="linkBtn" onclick="openPlayerCard('BROWSE_CLUB', ${i})"><b>${p.name}</b></button></td>
                  <td>${p.pos}</td>
                  <td>${p.flag}</td>
                  <td>${p.age}</td>
                  <td><b>${getDisplayedOverall(p, (state._summaryTab==='NT'?'NT':'CLUB'))}</b></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="btnRow" style="margin-top:14px">
          <button class="btn" id="backTeams">⬅ Timovi</button>
          <button class="btn primary" id="continueClub">${state.career==='BOTH' ? 'Nastavi ➜ (Reprezentacija)' : 'Započni ✅'}</button>
        </div>
      </section>
    `;
    const btn=document.createElement('button');
    btn.className='ctaStart'; btn.textContent='Započni karijeru';
    btn.onclick=()=>{ startCareer(); };
    document.body.appendChild(btn);


    document.getElementById('backTeams').onclick = ()=>{ state.step=4; state.leagueView='CLUBS'; render(); };
    document.getElementById('continueClub').onclick = ()=>{
      state.step = (state.career==='BOTH') ? 5 : 7;
      render();
    };
    return;
  }

if(state.step===7){
    // Final summary before starting career (club / NT / both)
    const league = leagueById(state.leagueId) || LEAGUES[0];

    const hasClub = !!state.club;
    const hasNT = !!state.nt;

    // Determine which panel to show first in BOTH mode
    if(state._summaryTab == null){
      state._summaryTab = (state.career === 'NT') ? 'NT' : 'CLUB';
      if(state.career === 'BOTH' && !hasClub && hasNT) state._summaryTab = 'NT';
      if(state.career === 'BOTH' && hasClub && !hasNT) state._summaryTab = 'CLUB';
    }

    // Build club summary
    let clubSummary = null;
    if(hasClub){
      const cd = genClubData(league, state.club);
      const gp = clubGoalsAndPressure(league, state.club);
      const pressureNum = gp.pressure;
      const goalsText = gp.primary;

      state._ctxClub = { goalsText, pressureNum };

      // Add fitness if missing (backward compatibility)
      cd.squad = cd.squad.map(p => ({...p, fitness: (p.fitness!=null ? p.fitness : clamp(Math.round(70 + (seedFrom(p.name)%31)),55,100))}));

      clubSummary = {
        name: state.club,
        budget: cd.budget,
        goalsText,
        pressureNum,
        objectives: gp.objectives,
        players: cd.squad.map(p=>({ ...p, club: state.club }))
      };
    }

    // Build NT summary
    let ntSummary = null;
    if(hasNT){
      const code = ntToNationCode(state.nt);
      // ensure roster includes newest fields
      try{ delete _ntRosterCache[code]; }catch(e){}
      const goals = generateNTGoals(code);
      const pressureNum = pressureToNum(goals.pressure);
      const goalsText = goals.primary;
      state._ctxNT = { goalsText, pressureNum };
      const roster = buildNationalRoster(code).map(p => ({
        ...p,
        fitness: (p.fitness!=null ? p.fitness : clamp(Math.round(72 + (seedFrom(p.name)%29)),55,100))
      }));

      ntSummary = {
        name: state.nt,
        budget: Math.round(650000 + (pressureNum*95000)), // lightweight federation budget model
        goalsText: goals.primary,
        pressureNum,
        goalsSecondary: goals.secondary,
        players: roster
      };
    }

    // Cache players for click -> modal
    state._clubSummaryPlayers = clubSummary ? clubSummary.players : null;
    state._ntSummaryPlayers = ntSummary ? ntSummary.players : null;

    // cache current list for modal access
    state._clubSummaryPlayers = clubSummary ? clubSummary.players : null;
    state._ntSummaryPlayers = ntSummary ? ntSummary.players : null;

    // Difficulty depends on public pressure (and existing base difficulty)
    const baseLevel = (state.difficulty && state.difficulty.level) ? state.difficulty.level : 4;
    const pressureForDiff =
      (state.career === 'BOTH')
        ? Math.max(clubSummary?clubSummary.pressureNum:1, ntSummary?ntSummary.pressureNum:1)
        : (state.career === 'NT' ? (ntSummary?ntSummary.pressureNum:3) : (clubSummary?clubSummary.pressureNum:3));
    const finalDifficulty = difficultyWithPressure(baseLevel, pressureForDiff);

    function badgeForDifficulty(lvl){
      if(lvl>=9) return '🔥 Ekstremno';
      if(lvl>=7) return '😈 Teško';
      if(lvl>=5) return '⚖️ Srednje';
      return '🙂 Lakše';
    }

    function pressureLabel(n){
      if(n>=5) return 'Veoma visok';
      if(n===4) return 'Visok';
      if(n===3) return 'Srednji';
      if(n===2) return 'Niži';
      return 'Nizak';
    }

    function renderTeamCard(sum, kind){
      const goalsExtra = (kind==='NT' && sum.goalsSecondary) ? `
        <div class="goalRow"><div class="goalLabel">Sekundarni cilj</div><div class="goalValue">${sum.goalsSecondary}</div></div>
      ` : '';

      const pressurePct = sum.pressureNum * 20;
      const diffPct = clamp(finalDifficulty * 10, 10, 100);

      return `
        <div class="row">
          <div class="big">${kind==='CLUB' ? 'Klub' : 'Reprezentacija'}: ${sum.name}</div>
          <span class="pill2">🎯 Cilj • ${sum.goalsText}</span>
        </div>

        <div class="metaGrid" style="margin-top:12px">
          <div class="metaBox">
            <div class="metaK">Budžet</div>
            <div class="metaV">${euro(sum.budget)}</div>
          </div>
          <div class="metaBox">
            <div class="metaK">Pritisak javnosti</div>
            <div class="metaV">${sum.pressureNum}/5 • ${pressureLabel(sum.pressureNum)}</div>
            <div class="bar" style="margin-top:10px"><div class="fill" style="width:${pressurePct}%"></div></div>
          </div>
          <div class="metaBox">
            <div class="metaK">Težina (zbog pritiska)</div>
            <div class="metaV">${badgeForDifficulty(finalDifficulty)} • lvl ${finalDifficulty}/10</div>
            <div class="bar" style="margin-top:10px"><div class="fill" style="width:${diffPct}%"></div></div>
          </div>
        </div>

        <div class="sectionTitle" style="margin-top:16px">🎯 Ciljevi ekipe <span class="chip">+ pritisak</span></div>
        <div class="goalsBox">
          <div class="goalRow"><div class="goalLabel">Primarni cilj</div><div class="goalValue">${sum.goalsText}</div></div>
          ${goalsExtra}
          <div class="goalRow"><div class="goalLabel">Pritisak javnosti</div><div class="goalValue">${sum.pressureNum}/5 (${pressureLabel(sum.pressureNum)})</div></div>
        </div>

        <div class="sectionTitle" style="margin-top:16px">👥 Igrači <span class="chip">Ovr • Kond • Moral</span></div>
        <div class="panel">
          <div class="panelTitle">Spisak igrača</div>
          <table class="table">
            <thead>
              <tr><th>#</th><th>Igrač</th><th>Poz</th><th>Klub</th><th>Ovr</th><th>Kond.</th><th>Moral</th></tr>
            </thead>
            <tbody>
              ${sum.players.map((p,i)=>{
                const morale = getMorale(p, sum.goalsText, sum.pressureNum);
                const clubCell = (kind==='NT' ? (p.club ? p.club : '—') : sum.name);
                return `
                  <tr>
                    <td>${i+1}</td>
                    <td><button type="button" class="linkBtn" onclick="openPlayerCard('${kind}', ${i})"><b>${p.flag||''} ${p.name}</b></button></td>
                    <td>${p.pos}</td>
                    <td>${clubCell}</td>
                    <td><b>${getDisplayedOverall(p, (state._summaryTab==='NT'?'NT':'CLUB'))}</b></td>
                    <td>${p.fitness}%</td>
                    <td class="moraleArrow ${moraleToArrow(morale).cls}"><b>${moraleToArrow(morale).arrow}</b></td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
          <div class="help">Moral je po igraču (0–25), zavisi od ciljeva i pritiska, a kroz sezonu reaguje na rezultate.</div>
<div class="btnRow" style="margin-top:10px">
  <button class="btn" onclick="applyResult('W')">✅ Pobeda</button>
  <button class="btn" onclick="applyResult('D')">🤝 Nerešeno</button>
  <button class="btn" onclick="applyResult('L')">❌ Poraz</button>
</div>
        </div>
      `;
    }

    app.innerHTML = `
      <section class="card">
        <div class="row">
          <div>
            <div class="big">Sumarni pregled (poslednji korak)</div>
            <div class="muted" style="margin-top:6px">Ovde se sabira: tim, budžet, ciljevi, pritisak i kompletan spisak igrača.</div>
          </div>
          <span class="badge">Korak 5</span>
        </div>

        ${state.career==='BOTH' ? `
          <div class="btnRow" style="margin-top:12px">
            <button class="btn ${state._summaryTab==='CLUB'?'primary':''}" onclick="state._summaryTab='CLUB'; render();">🏟️ Klub</button>
            <button class="btn ${state._summaryTab==='NT'?'primary':''}" onclick="state._summaryTab='NT'; render();">🏳️ Reprezentacija</button>
          </div>
          <div class="help">U režimu <b>Klub + Reprezentacija</b> prebacuješ pregled jednim klikom.</div>
        ` : ''}

        <hr class="hr"/>

        <div>
          ${state.career==='NT'
            ? (ntSummary ? renderTeamCard(ntSummary,'NT') : `<div class="muted">Nema izabrane reprezentacije.</div>`)
            : (state.career==='CLUB'
                ? (clubSummary ? renderTeamCard(clubSummary,'CLUB') : `<div class="muted">Nema izabranog kluba.</div>`)
                : (state._summaryTab==='NT'
                    ? (ntSummary ? renderTeamCard(ntSummary,'NT') : `<div class="muted">Nema izabrane reprezentacije.</div>`)
                    : (clubSummary ? renderTeamCard(clubSummary,'CLUB') : `<div class="muted">Nema izabranog kluba.</div>`)
                  )
              )
          }
        </div>

        <div class="btnRow" style="margin-top:16px">
          <button class="btn" id="backFromSummary">⬅ Nazad</button>
          <button class="btn primary" id="startCareer">Započni ✅</button>
        </div>
      </section>
    `;

    document.getElementById('backFromSummary').onclick = ()=>{
      if(state.career === 'NT') state.step = 5;               // back to NT select
      else if(state.career === 'CLUB') state.step = 6;        // back to club preview
      else state.step = 5;                                    // BOTH: go back to NT select (last thing)
      render();
    };

    document.getElementById('startCareer').onclick = ()=>{ startCareer(); };;
    return;
  }


  } catch(e){
    const app = document.getElementById('app');
    if(app){
      app.innerHTML = `
        <section class="card soft">
          <div class="row"><div class="big">Greška u prikazu</div><span class="badge">Debug</span></div>
          <p class="muted">Ako vidiš ovo, pošalji mi tekst ispod i popravljamo odmah.</p>
          <pre style="white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.35);padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.10)">${String(e && (e.stack||e.message||e))}</pre>
        </section>
      `;
    }
    console.error(e);
  }
}


/* --- Ensure modals (player/staff) render immediately on any screen --- */
const __baseRender = render;
render = function(){
  __baseRender();
  try{
    const appEl = document.getElementById('app');
    if(!appEl) return;

    // Always remove any existing modal first (prevents "click but nothing" issues)
    const existing = document.querySelector('.modalBackdrop');
    if(existing) existing.remove();

    if(state && state._openPlayer){
      appEl.insertAdjacentHTML('beforeend', renderPlayerModal());
    } else if(state && state._openStaff){
      appEl.insertAdjacentHTML('beforeend', renderStaffModal());
    }

    // Hide all legacy per-step navigation buttons/rows (navigation is only via global controls)
    try{ hideLegacyStepNav(); }catch(e3){}
    // Sync global back/next enabled state
    try{ syncGlobalNavState(); }catch(e4){}
  }catch(e){
    console.error(e);
  }
};

/* ===== Global navigation (Back/Next) + animated transition overlay ===== */

function _getTransitionEls(){
  return {
    overlay: document.getElementById('transitionOverlay'),
    title: document.getElementById('transitionTitle'),
    sub: document.getElementById('transitionSub')
  };
}

function showTransitionOverlay({durationMs=600, title='Učitavanje…', sub='Pripremamo sledeći korak.'}={}){
  const {overlay, title: tEl, sub: sEl} = _getTransitionEls();
  if(!overlay) return Promise.resolve();
  if(tEl) tEl.textContent = title;
  if(sEl) sEl.textContent = sub;

  overlay.classList.remove('hidden');
  // restart progress animation duration
  overlay.style.setProperty('--hmDur', `${Math.max(200, durationMs)}ms`);
  // force reflow to ensure animation restarts
  void overlay.offsetWidth;
  overlay.classList.add('show');

  return new Promise((resolve)=>{
    setTimeout(()=>{
      overlay.classList.remove('show');
      setTimeout(()=>{
        overlay.classList.add('hidden');
        resolve();
      }, 220);
    }, durationMs);
  });
}

function hideLegacyStepNav(){
  // These are the per-step buttons we keep for logic, but hide from the user.
  const ids = [
    'n1','n2','n3','n4','n5','continueClub','startCareer','ntConfirm','ntBack',
    'b2','b3','b4','backTeams','backFromSummary'
  ];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    const row = el.closest('.btnRow') || el.closest('.wizardNav') || el.parentElement;
    if(row) row.classList.add('legacyNavHidden');
    else el.classList.add('legacyNavHidden');
  });
}

function _navTarget(kind){
  // Returns the first existing legacy nav button for the current screen.
  if(state && state.screen === 'fm'){
    // In FM phase, we keep Back/Next for future (days), but currently disable Next.
    return null;
  }
  const candidatesNext = ['n1','n2','n3','n4','n5','continueClub','startCareer','ntConfirm'];
  const candidatesBack = ['b2','b3','b4','backTeams','backFromSummary','ntBack'];
  const list = (kind==='next') ? candidatesNext : candidatesBack;
  for(const id of list){
    const el = document.getElementById(id);
    if(el && !el.disabled) return el;
  }
  return null;
}

function syncGlobalNavState(){
  const back = document.getElementById('navBackBtn');
  const next = document.getElementById('navNextBtn');
  if(back) back.disabled = !_navTarget('back');
  if(next) next.disabled = !_navTarget('next');
}

async function handleGlobalNav(kind){
  const target = _navTarget(kind);
  if(!target) return;

  // Phase 1 -> Phase 2 (wizard -> FM skin): 4 seconds loading splash
  const isCareerStart = (target.id === 'startCareer');
  if(isCareerStart){
    await showTransitionOverlay({
      durationMs: 4000,
      title: 'Trener i štab analiziraju…',
      sub: 'Učitavamo FM skin i prebacujemo podatke iz FAZE 1.'
    });
    target.click();
    return;
  }

  // Normal step transitions: short animated splash
  await showTransitionOverlay({ durationMs: 550, title: 'Učitavanje…', sub: 'Prelazak na sledeći korak.' });
  target.click();
}


function selectLeague(id){
  state.leagueId = id;
  const l = leagueById(id);
  state.leagueName = l ? l.name : null;
  state.leagueView = 'CLUBS';
  render();
}
function selectClub(encoded){
  state.club = decodeURIComponent(encoded);
  state.step = 6; // club preview before NT/finish
  render();
}

render();
function renderNTPreview(nation){
  const app = document.getElementById('app');
  const officials = generateFederationOfficials(nation.code);
  app.innerHTML = `
    <div class="preview">
      <h2>${nation.flag || ''} ${nation.name} – Reprezentacija</h2>
      <div class="card">
        <h3>Savez</h3>
        <ul>
          <li><strong>Predsednik saveza:</strong> ${officials.president}</li>
          <li><strong>Potpredsednik saveza:</strong> ${officials.vice}</li>
          <li><strong>Generalni sekretar:</strong> ${officials.secretary}</li>
          <li><strong>Portparol saveza:</strong> ${officials.spokesperson}</li>
        </ul>
      </div>
      <button class="btn" id="ntConfirm">Potvrdi izbor</button>
      <button class="btn secondary" id="ntBack">Nazad</button>
    </div>
  `;
  document.getElementById('ntBack').onclick = () => renderStep(5);
  document.getElementById('ntConfirm').onclick = () => {
    state.ntOfficials = officials;
    renderStep(7);
  };
}

window.selectNT = (ntEnc)=>{ state.nt = decodeURIComponent(ntEnc); render(); };

window.applyResult = applyResult;

/* ===== Global i18n + Settings (Options) UI ===== */
window.__HM_LANGS = [
  {
    "code": "sr",
    "flag": "🇷🇸",
    "name": "Srpski"
  },
  {
    "code": "en",
    "flag": "🇬🇧",
    "name": "English"
  },
  {
    "code": "de",
    "flag": "🇩🇪",
    "name": "Deutsch"
  },
  {
    "code": "fr",
    "flag": "🇫🇷",
    "name": "Français"
  },
  {
    "code": "es",
    "flag": "🇪🇸",
    "name": "Español"
  },
  {
    "code": "da",
    "flag": "🇩🇰",
    "name": "Dansk"
  },
  {
    "code": "sv",
    "flag": "🇸🇪",
    "name": "Svenska"
  },
  {
    "code": "no",
    "flag": "🇳🇴",
    "name": "Norsk"
  },
  {
    "code": "hr",
    "flag": "🇭🇷",
    "name": "Hrvatski"
  },
  {
    "code": "bs",
    "flag": "🇧🇦",
    "name": "Bosanski"
  },
  {
    "code": "me",
    "flag": "🇲🇪",
    "name": "Crnogorski"
  },
  {
    "code": "hu",
    "flag": "🇭🇺",
    "name": "Magyar"
  },
  {
    "code": "pl",
    "flag": "🇵🇱",
    "name": "Polski"
  },
  {
    "code": "sl",
    "flag": "🇸🇮",
    "name": "Slovenščina"
  },
  {
    "code": "mk",
    "flag": "🇲🇰",
    "name": "Македонски"
  },
  {
    "code": "ro",
    "flag": "🇷🇴",
    "name": "Română"
  },
  {
    "code": "it",
    "flag": "🇮🇹",
    "name": "Italiano"
  },
  {
    "code": "pt",
    "flag": "🇵🇹",
    "name": "Português"
  },
  {
    "code": "nl",
    "flag": "🇳🇱",
    "name": "Nederlands"
  },
  {
    "code": "ru",
    "flag": "🇷🇺",
    "name": "Русский"
  },
  {
    "code": "tr",
    "flag": "🇹🇷",
    "name": "Türkçe"
  }
];

window.__HM_I18N = {
  "sr": {
    "options": "Opcije",
    "settings_title": "Podešavanja igre",
    "language": "Jezik",
    "autosave": "Auto čuvanje",
    "save": "Sačuvaj",
    "autosave_off": "Isključeno",
    "autosave_week": "Na nedelju dana",
    "autosave_month": "Na mesec dana",
    "autosave_year": "Na godinu dana",
    "players": "Igrači",
    "team_status": "Status tima",
    "position": "Pozicija",
    "age": "Godine",
    "form": "Forma",
    "rating": "Ocena",
    "morale": "Moral",
    "condition": "Kondicija",
    "cohesion": "Kompaktnost",
    "name": "Ime",
    "staff": "Stručni štab",
    "club": "Klub",
    "team": "Tim"
  },
  "en": {
    "options": "Options",
    "settings_title": "Game Settings",
    "language": "Language",
    "autosave": "Auto-save",
    "save": "Save",
    "autosave_off": "Off",
    "autosave_week": "Weekly",
    "autosave_month": "Monthly",
    "autosave_year": "Yearly",
    "players": "Players",
    "team_status": "Team Status",
    "position": "Position",
    "age": "Age",
    "form": "Form",
    "rating": "Rating",
    "morale": "Morale",
    "condition": "Condition",
    "cohesion": "Cohesion",
    "name": "Name",
    "staff": "Staff",
    "club": "Club",
    "team": "Team"
  },
  "de": {
    "options": "Optionen",
    "settings_title": "Spieleinstellungen",
    "language": "Sprache",
    "autosave": "Auto-Speichern",
    "save": "Speichern",
    "autosave_off": "Aus",
    "autosave_week": "Wöchentlich",
    "autosave_month": "Monatlich",
    "autosave_year": "Jährlich",
    "players": "Spieler",
    "team_status": "Teamstatus",
    "position": "Position",
    "age": "Alter",
    "form": "Form",
    "rating": "Bewertung",
    "morale": "Moral",
    "condition": "Fitness",
    "cohesion": "Zusammenhalt",
    "name": "Name",
    "staff": "Stab",
    "club": "Verein",
    "team": "Team"
  },
  "fr": {
    "options": "Options",
    "settings_title": "Paramètres du jeu",
    "language": "Langue",
    "autosave": "Sauvegarde auto",
    "save": "Enregistrer",
    "autosave_off": "Désactivée",
    "autosave_week": "Hebdomadaire",
    "autosave_month": "Mensuelle",
    "autosave_year": "Annuelle",
    "players": "Joueurs",
    "team_status": "Statut de l’équipe",
    "position": "Poste",
    "age": "Âge",
    "form": "Forme",
    "rating": "Note",
    "morale": "Moral",
    "condition": "Condition",
    "cohesion": "Cohésion",
    "name": "Nom",
    "staff": "Staff",
    "club": "Club",
    "team": "Équipe"
  },
  "es": {
    "options": "Opciones",
    "settings_title": "Ajustes del juego",
    "language": "Idioma",
    "autosave": "Guardado automático",
    "save": "Guardar",
    "autosave_off": "Desactivado",
    "autosave_week": "Semanal",
    "autosave_month": "Mensual",
    "autosave_year": "Anual",
    "players": "Jugadores",
    "team_status": "Estado del equipo",
    "position": "Posición",
    "age": "Edad",
    "form": "Forma",
    "rating": "Calificación",
    "morale": "Moral",
    "condition": "Condición",
    "cohesion": "Cohesión",
    "name": "Nombre",
    "staff": "Cuerpo técnico",
    "club": "Club",
    "team": "Equipo"
  },
  "da": {
    "options": "Indstillinger",
    "settings_title": "Spilindstillinger",
    "language": "Sprog",
    "autosave": "Autosave",
    "save": "Gem",
    "autosave_off": "Fra",
    "autosave_week": "Ugentligt",
    "autosave_month": "Månedligt",
    "autosave_year": "Årligt",
    "players": "Spillere",
    "team_status": "Holdstatus",
    "position": "Position",
    "age": "Alder",
    "form": "Form",
    "rating": "Vurdering",
    "morale": "Moral",
    "condition": "Form (fysik)",
    "cohesion": "Sammenhold",
    "name": "Navn",
    "staff": "Stab",
    "club": "Klub",
    "team": "Hold"
  },
  "sv": {
    "options": "Alternativ",
    "settings_title": "Spelinställningar",
    "language": "Språk",
    "autosave": "Autospara",
    "save": "Spara",
    "autosave_off": "Av",
    "autosave_week": "Veckovis",
    "autosave_month": "Månadsvis",
    "autosave_year": "Årsvis",
    "players": "Spelare",
    "team_status": "Lagstatus",
    "position": "Position",
    "age": "Ålder",
    "form": "Form",
    "rating": "Betyg",
    "morale": "Moral",
    "condition": "Kondition",
    "cohesion": "Sammanhållning",
    "name": "Namn",
    "staff": "Stab",
    "club": "Klubb",
    "team": "Lag"
  },
  "no": {
    "options": "Innstillinger",
    "settings_title": "Spillinnstillinger",
    "language": "Språk",
    "autosave": "Autolagring",
    "save": "Lagre",
    "autosave_off": "Av",
    "autosave_week": "Ukentlig",
    "autosave_month": "Månedlig",
    "autosave_year": "Årlig",
    "players": "Spillere",
    "team_status": "Lagstatus",
    "position": "Posisjon",
    "age": "Alder",
    "form": "Form",
    "rating": "Vurdering",
    "morale": "Moral",
    "condition": "Kondisjon",
    "cohesion": "Samhold",
    "name": "Navn",
    "staff": "Stab",
    "club": "Klubb",
    "team": "Lag"
  },
  "hr": {
    "options": "Opcije",
    "settings_title": "Postavke igre",
    "language": "Jezik",
    "autosave": "Auto spremanje",
    "save": "Spremi",
    "autosave_off": "Isključeno",
    "autosave_week": "Tjedno",
    "autosave_month": "Mjesečno",
    "autosave_year": "Godišnje",
    "players": "Igrači",
    "team_status": "Status ekipe",
    "position": "Pozicija",
    "age": "Godine",
    "form": "Forma",
    "rating": "Ocjena",
    "morale": "Moral",
    "condition": "Kondicija",
    "cohesion": "Uigranost",
    "name": "Ime",
    "staff": "Stručni stožer",
    "club": "Klub",
    "team": "Tim"
  },
  "bs": {
    "options": "Opcije",
    "settings_title": "Postavke igre",
    "language": "Jezik",
    "autosave": "Auto čuvanje",
    "save": "Sačuvaj",
    "autosave_off": "Isključeno",
    "autosave_week": "Sedmično",
    "autosave_month": "Mjesečno",
    "autosave_year": "Godišnje",
    "players": "Igrači",
    "team_status": "Status tima",
    "position": "Pozicija",
    "age": "Godine",
    "form": "Forma",
    "rating": "Ocjena",
    "morale": "Moral",
    "condition": "Kondicija",
    "cohesion": "Uigranost",
    "name": "Ime",
    "staff": "Stručni štab",
    "club": "Klub",
    "team": "Tim"
  },
  "me": {
    "options": "Opcije",
    "settings_title": "Podešavanja igre",
    "language": "Jezik",
    "autosave": "Auto čuvanje",
    "save": "Sačuvaj",
    "autosave_off": "Isključeno",
    "autosave_week": "Sedmično",
    "autosave_month": "Mjesečno",
    "autosave_year": "Godišnje",
    "players": "Igrači",
    "team_status": "Status tima",
    "position": "Pozicija",
    "age": "Godine",
    "form": "Forma",
    "rating": "Ocjena",
    "morale": "Moral",
    "condition": "Kondicija",
    "cohesion": "Uigranost",
    "name": "Ime",
    "staff": "Stručni štab",
    "club": "Klub",
    "team": "Tim"
  },
  "hu": {
    "options": "Beállítások",
    "settings_title": "Játékbeállítások",
    "language": "Nyelv",
    "autosave": "Automatikus mentés",
    "save": "Mentés",
    "autosave_off": "Ki",
    "autosave_week": "Hetente",
    "autosave_month": "Havonta",
    "autosave_year": "Évente",
    "players": "Játékosok",
    "team_status": "Csapatállapot",
    "position": "Poszt",
    "age": "Kor",
    "form": "Forma",
    "rating": "Értékelés",
    "morale": "Morál",
    "condition": "Kondíció",
    "cohesion": "Összhang",
    "name": "Név",
    "staff": "Stáb",
    "club": "Klub",
    "team": "Csapat"
  },
  "pl": {
    "options": "Opcje",
    "settings_title": "Ustawienia gry",
    "language": "Język",
    "autosave": "Autozapis",
    "save": "Zapisz",
    "autosave_off": "Wyłączony",
    "autosave_week": "Co tydzień",
    "autosave_month": "Co miesiąc",
    "autosave_year": "Co rok",
    "players": "Zawodnicy",
    "team_status": "Status zespołu",
    "position": "Pozycja",
    "age": "Wiek",
    "form": "Forma",
    "rating": "Ocena",
    "morale": "Morale",
    "condition": "Kondycja",
    "cohesion": "Zgranie",
    "name": "Imię",
    "staff": "Sztab",
    "club": "Klub",
    "team": "Drużyna"
  },
  "sl": {
    "options": "Možnosti",
    "settings_title": "Nastavitve igre",
    "language": "Jezik",
    "autosave": "Samodejno shranjevanje",
    "save": "Shrani",
    "autosave_off": "Izklopljeno",
    "autosave_week": "Tedensko",
    "autosave_month": "Mesečno",
    "autosave_year": "Letno",
    "players": "Igralci",
    "team_status": "Status ekipe",
    "position": "Položaj",
    "age": "Starost",
    "form": "Forma",
    "rating": "Ocena",
    "morale": "Morala",
    "condition": "Kondicija",
    "cohesion": "Uigranost",
    "name": "Ime",
    "staff": "Strokovni štab",
    "club": "Klub",
    "team": "Ekipa"
  },
  "mk": {
    "options": "Опции",
    "settings_title": "Поставки на играта",
    "language": "Јазик",
    "autosave": "Авто-зачувување",
    "save": "Зачувај",
    "autosave_off": "Исклучено",
    "autosave_week": "Неделно",
    "autosave_month": "Месечно",
    "autosave_year": "Годишно",
    "players": "Играчите",
    "team_status": "Статус на тимот",
    "position": "Позиција",
    "age": "Возраст",
    "form": "Форма",
    "rating": "Оцена",
    "morale": "Морал",
    "condition": "Кондиција",
    "cohesion": "Уиграност",
    "name": "Име",
    "staff": "Стручен штаб",
    "club": "Клуб",
    "team": "Тим"
  },
  "ro": {
    "options": "Opțiuni",
    "settings_title": "Setări joc",
    "language": "Limbă",
    "autosave": "Salvare automată",
    "save": "Salvează",
    "autosave_off": "Dezactivată",
    "autosave_week": "Săptămânal",
    "autosave_month": "Lunar",
    "autosave_year": "Anual",
    "players": "Jucători",
    "team_status": "Starea echipei",
    "position": "Poziție",
    "age": "Vârstă",
    "form": "Formă",
    "rating": "Notă",
    "morale": "Moral",
    "condition": "Condiție",
    "cohesion": "Coeziune",
    "name": "Nume",
    "staff": "Staff",
    "club": "Club",
    "team": "Echipă"
  },
  "it": {
    "options": "Opzioni",
    "settings_title": "Impostazioni di gioco",
    "language": "Lingua",
    "autosave": "Salvataggio automatico",
    "save": "Salva",
    "autosave_off": "Disattivato",
    "autosave_week": "Settimanale",
    "autosave_month": "Mensile",
    "autosave_year": "Annuale",
    "players": "Giocatori",
    "team_status": "Stato squadra",
    "position": "Ruolo",
    "age": "Età",
    "form": "Forma",
    "rating": "Valutazione",
    "morale": "Morale",
    "condition": "Condizione",
    "cohesion": "Coesione",
    "name": "Nome",
    "staff": "Staff",
    "club": "Club",
    "team": "Squadra"
  },
  "pt": {
    "options": "Opções",
    "settings_title": "Configurações do jogo",
    "language": "Idioma",
    "autosave": "Salvamento automático",
    "save": "Salvar",
    "autosave_off": "Desligado",
    "autosave_week": "Semanal",
    "autosave_month": "Mensal",
    "autosave_year": "Anual",
    "players": "Jogadores",
    "team_status": "Estado da equipa",
    "position": "Posição",
    "age": "Idade",
    "form": "Forma",
    "rating": "Avaliação",
    "morale": "Moral",
    "condition": "Condição",
    "cohesion": "Coesão",
    "name": "Nome",
    "staff": "Equipa técnica",
    "club": "Clube",
    "team": "Equipa"
  },
  "nl": {
    "options": "Opties",
    "settings_title": "Spelinstellingen",
    "language": "Taal",
    "autosave": "Automatisch opslaan",
    "save": "Opslaan",
    "autosave_off": "Uit",
    "autosave_week": "Wekelijks",
    "autosave_month": "Maandelijks",
    "autosave_year": "Jaarlijks",
    "players": "Spelers",
    "team_status": "Teamstatus",
    "position": "Positie",
    "age": "Leeftijd",
    "form": "Vorm",
    "rating": "Beoordeling",
    "morale": "Moraal",
    "condition": "Conditie",
    "cohesion": "Samenhang",
    "name": "Naam",
    "staff": "Staf",
    "club": "Club",
    "team": "Team"
  },
  "ru": {
    "options": "Опции",
    "settings_title": "Настройки игры",
    "language": "Язык",
    "autosave": "Автосохранение",
    "save": "Сохранить",
    "autosave_off": "Выключено",
    "autosave_week": "Еженедельно",
    "autosave_month": "Ежемесячно",
    "autosave_year": "Ежегодно",
    "players": "Игроки",
    "team_status": "Статус команды",
    "position": "Позиция",
    "age": "Возраст",
    "form": "Форма",
    "rating": "Оценка",
    "morale": "Мораль",
    "condition": "Форма",
    "cohesion": "Сыгранность",
    "name": "Имя",
    "staff": "Штаб",
    "club": "Клуб",
    "team": "Команда"
  },
  "tr": {
    "options": "Seçenekler",
    "settings_title": "Oyun Ayarları",
    "language": "Dil",
    "autosave": "Otomatik kayıt",
    "save": "Kaydet",
    "autosave_off": "Kapalı",
    "autosave_week": "Haftalık",
    "autosave_month": "Aylık",
    "autosave_year": "Yıllık",
    "players": "Oyuncular",
    "team_status": "Takım durumu",
    "position": "Pozisyon",
    "age": "Yaş",
    "form": "Form",
    "rating": "Puan",
    "morale": "Moral",
    "condition": "Kondisyon",
    "cohesion": "Uyum",
    "name": "İsim",
    "staff": "Teknik ekip",
    "club": "Kulüp",
    "team": "Takım"
  }
};

function hmT(key){
  const lang = (state && state.settings && state.settings.language) ? state.settings.language : 'sr';
  const dict = (window.__HM_I18N && window.__HM_I18N[lang]) ? window.__HM_I18N[lang] : (window.__HM_I18N ? window.__HM_I18N.sr : null);
  const fallback = (window.__HM_I18N && window.__HM_I18N.sr) ? window.__HM_I18N.sr : {};
  return (dict && dict[key]) || fallback[key] || key;
}
window.hmT = hmT;

function updateOptionsChrome(){
  const btn = document.getElementById('optionsBtn');
  if(btn) btn.textContent = `⚙ ${hmT('options')}`;
  const title = document.getElementById('settingsTitle');
  if(title) title.textContent = hmT('settings_title');
  const langLabel = document.getElementById('langLabel');
  if(langLabel) langLabel.textContent = hmT('language');
  const asLabel = document.getElementById('autosaveLabel');
  if(asLabel) asLabel.textContent = hmT('autosave');
  const saveBtn = document.getElementById('settingsSave');
  if(saveBtn) saveBtn.textContent = hmT('save');
}

function buildSettingsOptions(){
  const langSel = document.getElementById('langSelect');
  const asSel = document.getElementById('autosaveSelect');
  if(langSel){
    langSel.innerHTML = (window.__HM_LANGS||[]).map(l => {
      const selected = (state.settings && state.settings.language===l.code) ? 'selected' : '';
      return `<option value="${l.code}" ${selected}>${l.flag} ${l.name}</option>`;
    }).join('');
  }
  if(asSel){
    const cur = (state.settings && state.settings.autosave) ? state.settings.autosave : 'off';
    const opts = [
      {v:'off', k:'autosave_off'},
      {v:'week', k:'autosave_week'},
      {v:'month', k:'autosave_month'},
      {v:'year', k:'autosave_year'},
    ];
    asSel.innerHTML = opts.map(o => {
      const selected = (cur===o.v) ? 'selected' : '';
      return `<option value="${o.v}" ${selected}>${hmT(o.k)}</option>`;
    }).join('');
  }
}

function openSettings(){
  const modal = document.getElementById('settingsModal');
  if(!modal) return;
  buildSettingsOptions();
  updateOptionsChrome();
  modal.classList.remove('hidden');
}
function closeSettings(){
  const modal = document.getElementById('settingsModal');
  if(!modal) return;
  modal.classList.add('hidden');
}

function applySettingsFromUI(){
  const langSel = document.getElementById('langSelect');
  const asSel = document.getElementById('autosaveSelect');
  const newLang = langSel ? langSel.value : 'sr';
  const newAS = asSel ? asSel.value : 'off';
  if(!state.settings) state.settings = {language:'sr', autosave:'off'};
  state.settings.language = newLang;
  state.settings.autosave = newAS;
  document.documentElement.lang = newLang;
  updateOptionsChrome();
  render(); // re-render app to apply translations
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('optionsBtn');
  const backBtn = document.getElementById('navBackBtn');
  const nextBtn = document.getElementById('navNextBtn');
  const closeBtn = document.getElementById('settingsClose');
  const saveBtn = document.getElementById('settingsSave');
  const overlay = document.getElementById('settingsModal');

  if(btn) btn.addEventListener('click', openSettings);
  if(backBtn) backBtn.addEventListener('click', () => handleGlobalNav('back'));
  if(nextBtn) nextBtn.addEventListener('click', () => handleGlobalNav('next'));
  if(closeBtn) closeBtn.addEventListener('click', closeSettings);
  if(saveBtn) saveBtn.addEventListener('click', () => {
    applySettingsFromUI();
    closeSettings();
  });
  if(overlay) overlay.addEventListener('click', (e) => {
    if(e.target === overlay) closeSettings();
  });

  updateOptionsChrome();
  try{ syncGlobalNavState(); }catch(e){}
});


// --- HM: Global delegated handler for Auto izbor (prevents lost listeners across re-renders) ---
if(!window.__hmAutoDelegation){
  window.__hmAutoDelegation = true;
  document.addEventListener("change", (e)=>{
    const t = e && e.target;
    if(!t) return;
    if(t.id === "autoSelect"){
      const v = t.value || "";
      // reset immediately so user can re-pick same option
      t.value = "";
      if(v && typeof window.__hmAutoHandler === "function"){
        try{ window.__hmAutoHandler(v); }
        catch(err){ console.error("Auto izbor delegated error", err); }
      }
    }
  }, true);
}


// =========================================================
// STRUČNI ŠTAB – POZADINSKI ENGINE (ne vidi se u skinu)
// Implementacija: logika + state management, bez UI izmena.
// =========================================================
(function(){
  function nowId(){
    return 'pred_' + Math.random().toString(36).slice(2,10) + '_' + Date.now();
  }

  function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

  function ensureEngine(state){
    if(!state) return null;
    if(!state.strucniStabEngine){
      state.strucniStabEngine = {
        fazaSezone: 'priprema', // 'priprema' | 'sezona' | 'zavrsetak'
        nedeljaIndex: 0,
        poslednjaUtakmicaId: null,
        sezonskiPlan: {
          fokus: 'stabilnost', // razvoj | stabilnost | rotacija | odbrana | napad
          politikaMladih: 'uravnotezeno', // uravnotezeno | prioritet_mladi | prioritet_rezultati
          politikaRotacije: 'srednja', // niska | srednja | visoka
          fokusTreninga: 'tim', // fizicka | taktika | tim
        },
        odnos: {
          pomocnik: 50,
          analiticar: 50,
          skaut: 50,
          kondicioni: 50,
          fizioterapeut: 50,
        },
        dnevnikOdluka: [],
        aktivniPredlozi: [], // max 3
        redPredloga: [],
        ignorisanjaZaredom: { pomocnik:0, analiticar:0, skaut:0, kondicioni:0, fizioterapeut:0 },
        ogranicenjeAutoraDo: { pomocnik:0, analiticar:0, skaut:0, kondicioni:0, fizioterapeut:0 },
      };
    }
    return state.strucniStabEngine;
  }

  function autorNaziv(author){
    const map = {
      pomocnik: 'Pomoćnik',
      analiticar: 'Analitičar',
      skaut: 'Skaut',
      kondicioni: 'Kondicioni trener',
      fizioterapeut: 'Fizioterapeut'
    };
    return map[author] || author;
  }

  function tipNaziv(type){
    const map = {
      rotacija: 'Rotacija',
      taktika: 'Taktika',
      trening: 'Trening',
      regrutacija: 'Regrutacija',
      komunikacija: 'Komunikacija'
    };
    return map[type] || type;
  }

  function stilObrazlozenja(stil){
    const a = [
      'Na osnovu forme i uigranosti predlažem sledeće:',
      'Podaci iz poslednjih utakmica pokazuju sledeće:',
      'Raspored je gust i umor raste, zato predlažem:',
      'Ovo je najbezbednija opcija u ovom trenutku:'
    ];
    return a[stil % a.length];
  }

  // Helperi za roster (fallback tolerantno)
  function getClubFromState(state){
    try{
      return state?.club || state?.career?.club || state?.currentClub || null;
    }catch(e){ return null; }
  }

  function getRoster(club){
    if(!club) return [];
    return club.players || club.roster || club.squad || [];
  }

  function pName(p){ return (p?.name || p?.ime || p?.fullName || 'Igrač').toString(); }
  function pPos(p){ return (p?.pos || p?.position || p?.poz || p?.pozicija || '').toString(); }
  function pFit(p){
    const v = p?.fitness ?? p?.kondicija ?? p?.condition ?? 100;
    const n = Number(v);
    return Number.isFinite(n) ? n : 100;
  }
  function pForm(p){
    const v = p?.form ?? p?.forma ?? p?.avgRating ?? p?.prosecnaOcena ?? 7.0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 7.0;
  }
  function pMor(p){
    const v = p?.morale ?? p?.moral ?? 15;
    const n = Number(v);
    return Number.isFinite(n) ? n : 15;
  }
  function pStreak3(p){
    // ako postoji eksplicitno, koristimo; inače 0
    const v = p?.playedStreak ?? p?.streak ?? p?.utakmiceZaredom ?? 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function enqueue(engine, s){
    if(!s) return;
    engine.redPredloga.push(s);
    popNext(engine);
  }

  function popNext(engine){
    while(engine.aktivniPredlozi.length < 3 && engine.redPredloga.length){
      engine.aktivniPredlozi.push(engine.redPredloga.shift());
    }
  }

  function resolve(engine, id, odluka){
    const idx = engine.aktivniPredlozi.findIndex(x=>x.id===id);
    let s = null;
    if(idx>=0){
      s = engine.aktivniPredlozi.splice(idx,1)[0];
    } else {
      const qidx = engine.redPredloga.findIndex(x=>x.id===id);
      if(qidx>=0) s = engine.redPredloga.splice(qidx,1)[0];
    }
    if(!s) return;

    const author = s.autor;
    const accepted = (odluka === 'prihvati');
    const delta = accepted ? (2 + Math.floor(Math.random()*4)) : -(1 + Math.floor(Math.random()*4));
    if(engine.odnos[author] == null) engine.odnos[author] = 50;
    engine.odnos[author] = clamp(engine.odnos[author] + delta, 0, 100);

    // praćenje ignorisanja autora
    if(accepted){
      engine.ignorisanjaZaredom[author] = 0;
    } else {
      engine.ignorisanjaZaredom[author] = (engine.ignorisanjaZaredom[author]||0) + 1;
      if(engine.ignorisanjaZaredom[author] >= 3){
        // 2 nedelje pauze
        engine.ogranicenjeAutoraDo[author] = engine.nedeljaIndex + 2;
      }
    }

    engine.dnevnikOdluka.push({
      vreme: Date.now(),
      id: s.id,
      tip: s.tip,
      autor: s.autor,
      odluka: accepted ? 'prihvaceno' : 'ignorisano',
      pouzdanost: s.pouzdanost,
    });

    popNext(engine);
  }

  function mkSuggestion({tip, autor, naslov, tekst, obrazlozenje, pouzdanost, uticaj}){
    return {
      id: nowId(),
      tip,
      autor,
      naslov: naslov || tipNaziv(tip),
      tekst: tekst || '',
      obrazlozenje: obrazlozenje || '',
      pouzdanost: clamp(Number(pouzdanost ?? 70), 0, 100),
      uticaj: uticaj || {},
      status: 'na_cekanju' // na_cekanju | prihvaceno | ignorisano (UI može mapirati)
    };
  }

  function genRotacija(state, engine, author){
    const club = getClubFromState(state);
    const roster = getRoster(club);
    if(!roster.length) return null;

    const kandidatiOut = roster
      .map(p=>({p, fit:pFit(p), form:pForm(p), streak:pStreak3(p)}))
      .filter(x => x.fit < 70 || x.form < 6.5 || x.streak >= 3)
      .sort((a,b)=> (a.fit-b.fit) || (a.form-b.form));

    if(!kandidatiOut.length) return null;

    const outA = kandidatiOut.slice(0,2);
    const outPos = new Set(outA.map(x=>pPos(x.p)));

    const kandidatiIn = roster
      .filter(p => !outA.some(o=>o.p===p))
      .map(p=>({p, fit:pFit(p), form:pForm(p), mor:pMor(p)}))
      .filter(x => outPos.has(pPos(x.p)))
      .sort((a,b)=> (b.fit-a.fit) || (b.form-a.form));

    const inA = [];
    for(const pos of outPos){
      const cand = kandidatiIn.find(x=>pPos(x.p)===pos && !inA.some(y=>y.p===x.p));
      if(cand) inA.push(cand);
    }

    if(!inA.length) return null;

    const linesOut = outA.map(x=>`- ${pName(x.p)} (${pPos(x.p)}) – kondicija ${Math.round(x.fit)}%, forma ${x.form.toFixed(1)}`);
    const linesIn  = inA.map(x=>`- ${pName(x.p)} (${pPos(x.p)}) – kondicija ${Math.round(x.fit)}%, forma ${x.form.toFixed(1)}`);

    const stil = Math.floor(Math.random()*4);
    const obraz = [
      stilObrazlozenja(stil),
      'Ovo smanjuje rizik pada intenziteta i povreda u narednom ciklusu.',
      'Rotacija će pomoći da zadržimo ritam i svežinu u ključnim minutima.'
    ].join(' ');

    const tekst = [
      'Predlažem rotaciju:',
      ...linesOut,
      'Umesto njih:',
      ...linesIn
    ].join('\n');

    return mkSuggestion({
      tip: 'rotacija',
      autor: author,
      naslov: 'Predlog rotacije',
      tekst,
      obrazlozenje: obraz,
      pouzdanost: 70 + Math.floor(Math.random()*21),
      uticaj: { rizik_povreda: -5, svežina: +3 }
    });
  }

  function genKomunikacija(state, engine, author){
    const club = getClubFromState(state);
    const roster = getRoster(club);
    if(!roster.length) return null;
    const avgMor = roster.reduce((s,p)=>s+pMor(p),0)/roster.length;
    if(avgMor >= 12) return null;

    const stil = Math.floor(Math.random()*4);
    const obraz = [
      stilObrazlozenja(stil),
      'Primećujemo pad morala kod većeg dela ekipe.',
      'Predlažem kratke individualne razgovore i jasnu poruku u svlačionici.'
    ].join(' ');

    return mkSuggestion({
      tip:'komunikacija',
      autor: author,
      naslov:'Komunikacija i moral',
      tekst:'Predlažem pojačanu komunikaciju: individualni razgovori sa 2–3 ključna igrača i jasna poruka o cilju za sledeći meč.',
      obrazlozenje: obraz,
      pouzdanost: 65 + Math.floor(Math.random()*26),
      uticaj: { moral: +2 }
    });
  }

  function genTrening(state, engine, author){
    const stil = Math.floor(Math.random()*4);
    const fokus = engine.sezonskiPlan.fokusTreninga;
    const fokusTxt = {
      fizicka: 'fizička priprema i prevencija umora',
      taktika: 'taktika i automatizmi u odbrani/napadu',
      tim: 'timwork i uigranost'
    }[fokus] || 'uigranost';

    const obraz = [
      stilObrazlozenja(stil),
      `Trenutni plan sugeriše fokus na: ${fokusTxt}.`,
      'Ovo bi trebalo da stabilizuje performans u sledećem periodu.'
    ].join(' ');

    return mkSuggestion({
      tip:'trening',
      autor: author,
      naslov:'Predlog trening fokusa',
      tekst:`Predlažem da narednih 7 dana stavimo naglasak na: ${fokusTxt}.`,
      obrazlozenje: obraz,
      pouzdanost: 60 + Math.floor(Math.random()*31),
      uticaj: { forma: +1, kondicija: +1 }
    });
  }

  function genTaktika(state, engine, author){
    const stil = Math.floor(Math.random()*4);
    const obraz = [
      stilObrazlozenja(stil),
      'U poslednjem ciklusu primećena je nestabilnost u završnici akcija.',
      'Predlažem jasnije uloge bekova i bržu loptu ka krilu kada se zatvori sredina.'
    ].join(' ');

    return mkSuggestion({
      tip:'taktika',
      autor: author,
      naslov:'Taktička korekcija',
      tekst:'Predlažem korekciju: brža cirkulacija lopte i raniji ulaz pivota, uz čuvanje protivničkog šutera na spolja.',
      obrazlozenje: obraz,
      pouzdanost: 55 + Math.floor(Math.random()*36),
      uticaj: { efikasnost: +2 }
    });
  }

  function genRegrutacija(state, engine, author){
    const stil = Math.floor(Math.random()*4);
    const obraz = [
      stilObrazlozenja(stil),
      'Na osnovu profila ekipe, preporučujem da pratimo jednu poziciju kao prioritet.',
      'To smanjuje rizik kada uđe zgusnut raspored i rotacije postanu nužne.'
    ].join(' ');

    return mkSuggestion({
      tip:'regrutacija',
      autor: author,
      naslov:'Skaut predlog',
      tekst:'Predlažem da otvorimo skauting fokus za: levog beka (LB) ili pivota (PIV) kao dubinsku opciju za rotaciju.',
      obrazlozenje: obraz,
      pouzdanost: 60 + Math.floor(Math.random()*31),
      uticaj: { transferi: +1 }
    });
  }

  function canAuthor(engine, author){
    // ako autor ima zabranu do neke nedelje
    const until = engine.ogranicenjeAutoraDo?.[author] ?? 0;
    return engine.nedeljaIndex >= until;
  }

  function generate(state, eventType){
    const engine = ensureEngine(state);
    if(!engine) return;

    const authors = ['pomocnik','analiticar','skaut','kondicioni','fizioterapeut'];

    // Sezonski set (3–6)
    if(eventType === 'POCETAK_SEZONE'){
      engine.fazaSezone = 'sezona';
      const n = 3 + Math.floor(Math.random()*4);
      for(let i=0;i<n;i++){
        const a = authors[i % authors.length];
        if(!canAuthor(engine,a)) continue;
        const pick = i % 3;
        const s = (pick===0) ? genTrening(state,engine,a)
          : (pick===1) ? genTaktika(state,engine,a)
          : genRegrutacija(state,engine,a);
        if(s) enqueue(engine,s);
      }
    }

    if(eventType === 'PRE_UTAKMICE'){
      // taktički + umor/rotacija
      if(canAuthor(engine,'analiticar')){
        const s = genTaktika(state,engine,'analiticar');
        if(s) enqueue(engine,s);
      }
      if(canAuthor(engine,'kondicioni')){
        const s = genRotacija(state,engine,'kondicioni');
        if(s) enqueue(engine,s);
      }
    }

    if(eventType === 'POSLE_UTAKMICE'){
      if(canAuthor(engine,'analiticar')){
        const s = genTaktika(state,engine,'analiticar');
        if(s) enqueue(engine,s);
      }
      if(canAuthor(engine,'fizioterapeut')){
        const s = genRotacija(state,engine,'fizioterapeut');
        if(s) enqueue(engine,s);
      }
      if(canAuthor(engine,'pomocnik')){
        const s = genKomunikacija(state,engine,'pomocnik');
        if(s) enqueue(engine,s);
      }
    }

    if(eventType === 'NEDELJNI_CIKLUS'){
      engine.nedeljaIndex = (engine.nedeljaIndex||0) + 1;
      if(canAuthor(engine,'kondicioni')){
        const s = genTrening(state,engine,'kondicioni');
        if(s) enqueue(engine,s);
      }
      // skaut max 1 nedeljno
      if(canAuthor(engine,'skaut')){
        const s = genRegrutacija(state,engine,'skaut');
        if(s) enqueue(engine,s);
      }
    }
  }

  function tick(state, eventType, meta){
    const engine = ensureEngine(state);
    if(!engine) return state;

    if(eventType === 'POCETAK_SEZONE'){
      engine.poslednjaUtakmicaId = null;
    }

    if(eventType === 'POSLE_UTAKMICE'){
      if(meta && meta.lastMatchId != null) engine.poslednjaUtakmicaId = meta.lastMatchId;
    }

    generate(state, eventType);
    return state;
  }

  // Public API (srpski)
  window.inicijalizujStrucniStabEngine = function(state){ ensureEngine(state); return state; };
  window.strucniStabEngineTick = function(state, tipDogadjaja, meta){ return tick(state, tipDogadjaja, meta); };
  window.generisiPredlogeStrucnogStaba = function(state, tipDogadjaja){ generate(state, tipDogadjaja); return state; };
  window.dodajPredlogURed = function(state, predlog){ const e=ensureEngine(state); if(e) enqueue(e,predlog); return state; };
  window.ubaciSledeciPredlogUAktivne = function(state){ const e=ensureEngine(state); if(e) popNext(e); return state; };
  window.razresiPredlogStrucnogStaba = function(state, id, odluka){ const e=ensureEngine(state); if(e) resolve(e,id,odluka); return state; };
})();
