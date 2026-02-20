
/* =========================================================
   HM_TEAM_API (invisible shared team accessor)
   Goal:
   - One canonical way to resolve the "active team" (club or NT)
   - Future features (tactics/training/staff/team power) use this,
     so everything automatically works for BOTH clubs and national teams.
   ========================================================= */
(function(){
  function getDB(state){
    return (state && state.db) ? state.db : (window.HM_DB || null);
  }

  function resolve(state){
    const db = getDB(state);
    const career = state?.career || {};
    const clubKey = career.clubKey || career.clubId || null;
    const ntKey   = career.ntKey   || career.ntId   || null;

    // active flag is the single source of truth ("CLUB" or "NT")
    const active = (career.active === 'NT' || career.active === 'CLUB')
      ? career.active
      : (career.mode === 'NT' ? 'NT' : 'CLUB');

    if(!db) return { kind: active, key: active === 'NT' ? ntKey : clubKey, team: null, db: null };

    if(active === 'NT'){
      const team = (ntKey && db.nts && db.nts[ntKey]) ? db.nts[ntKey] : null;
      if(team) return { kind:'NT', key: ntKey, team, db };
      // fallback to club if NT missing
      const cteam = (clubKey && db.clubs && db.clubs[clubKey]) ? db.clubs[clubKey] : null;
      return { kind: cteam ? 'CLUB' : 'NT', key: cteam ? clubKey : ntKey, team: cteam, db };
    }

    const team = (clubKey && db.clubs && db.clubs[clubKey]) ? db.clubs[clubKey] : null;
    if(team) return { kind:'CLUB', key: clubKey, team, db };
    // fallback to NT if club missing
    const nteam = (ntKey && db.nts && db.nts[ntKey]) ? db.nts[ntKey] : null;
    return { kind: nteam ? 'NT' : 'CLUB', key: nteam ? ntKey : clubKey, team: nteam, db };
  }

  function getPlayers(state){
    const r = resolve(state);
    const t = r.team || {};
    return Array.isArray(t.players) ? t.players : (Array.isArray(t.squad) ? t.squad : []);
  }

  function getStaff(state){
    const r = resolve(state);
    const t = r.team || {};
    return Array.isArray(t.staff) ? t.staff : [];
  }

  function setPlayers(state, players){
    const r = resolve(state);
    if(!r.db || !r.team) return false;
    const list = Array.isArray(players) ? players : [];
    if(r.kind === 'NT') r.db.nts[r.key].players = list;
    else r.db.clubs[r.key].players = list;
    return true;
  }

  function setStaff(state, staff){
    const r = resolve(state);
    if(!r.db || !r.team) return false;
    const list = Array.isArray(staff) ? staff : [];
    if(r.kind === 'NT') r.db.nts[r.key].staff = list;
    else r.db.clubs[r.key].staff = list;
    return true;
  }

  window.HM_TEAM = { getDB, resolve, getPlayers, getStaff, setPlayers, setStaff };
})();
