// Handball Manager — Central DB (source of truth)
// This file defines a single shared in-memory database that ALL phases read from.
// FAZA 1 writes selection into state.career (clubKey), FAZA 2 reads club data from HM_DB.

(function(){
  const DB = {
    version: 1,
    leagues: [],        // [{id,name,clubs:[names]}]
    clubs: {},          // key: "LEAGUEID|Club Name" -> clubData (incl squad/staff/board/budget...)
    nts: {},            // key: "NT|CODE" -> ntData (roster/staff/federation/meta...)
          // key: "LEAGUEID|Club Name" -> clubData (incl squad/staff/board/budget...)
    // optional normalized indices (not mandatory in this phase)
    players: {},
    staff: {},
    career: null,
    ensureClub(clubKey, producer){
      if(!clubKey) return null;
      if(!DB.clubs[clubKey] && typeof producer === "function"){
        DB.clubs[clubKey] = producer();
      }
      return DB.clubs[clubKey] || null;
    },

    ensureNT(ntKey, producer){
      if(!ntKey) return null;
      if(!DB.nts[ntKey] && typeof producer === "function"){
        DB.nts[ntKey] = producer();
      }
      return DB.nts[ntKey] || null;
    },
  };

  window.HM_DB = DB;
})();
