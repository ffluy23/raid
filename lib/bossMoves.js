// lib/bossMoves.js
// 보스 전용 기술 정의
// 모든 보스 기술은 alwaysHit: true (명중 계산 없음)
// 기본 moves.js와 동일한 구조지만 power가 다름

export const bossMoves = {
  // ── 앱솔 기술 ─────────────────────────────────────────────────────
  "악의파동": {
    power: 45, type: "악", accuracy: 100, alwaysHit: true,
    effect: { chance: 0.2, volatile: "풀죽음" },
    aoe: true   // 3명 전체 광역
  },
  "아이언테일": {
    power: 45, type: "강철", accuracy: 100, alwaysHit: true,
    effect: null,
    rank: { chance: 0.3, targetDef: -1, turns: 3 }
  },
  "할퀴기": {
    power: 35, type: "노말", accuracy: 100, alwaysHit: true,
    effect: null,
    aoe: true   // 3명 전체 광역
  },
  "물기": {
    power: 50, type: "악", accuracy: 100, alwaysHit: true,
    effect: { chance: 0.3, volatile: "풀죽음" }
  },

  // ── 앱솔 ult ──────────────────────────────────────────────────────
  "기습": {
    power: 50, type: "악", accuracy: 100, alwaysHit: true,
    effect: null,
    ult: true   // ult 표시 (raidBossTurn에서 구분용)
  },

  // -- 비퀸
  "독침":    { power: 50, type: "독",  accuracy: 100, alwaysHit: true },
"시저크로스": { power: 45, type: "벌레", accuracy: 100, alwaysHit: true, aoe: true },
"달려들기":  { power: 50, type: "벌레", accuracy: 100, alwaysHit: true },
"벌레의저항": { power: 60, type: "벌레", accuracy: 100, alwaysHit: true, aoe: true },

}