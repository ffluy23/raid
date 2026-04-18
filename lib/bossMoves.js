// lib/bossMoves.js

export const bossMoves = {
  // ── 앱솔 기술 ──────────────────────────────────────────────────
  "악의파동": {
    power: 45, type: "악", accuracy: 100, alwaysHit: true,
    effect: { chance: 0.2, volatile: "풀죽음" },
    aoe: true
  },
  "아이언테일": {
    power: 45, type: "강철", accuracy: 100, alwaysHit: true,
    effect: null,
    rank: { chance: 0.3, targetDef: -1, turns: 3 }
  },
  "할퀴기": {
    power: 35, type: "노말", accuracy: 100, alwaysHit: true,
    effect: null,
    aoe: true
  },
  "물기": {
    power: 50, type: "악", accuracy: 100, alwaysHit: true,
    effect: { chance: 0.3, volatile: "풀죽음" }
  },

  // ── 앱솔 ult ───────────────────────────────────────────────────
  "기습": {
    power: 50, type: "악", accuracy: 100, alwaysHit: true,
    effect: null,
    ult: true
  },

  // ── 비퀸 직접 공격 ──────────────────────────────────────────────
  "독침":      { power: 50, type: "독",   accuracy: 100, alwaysHit: true },
  "시저크로스": { power: 45, type: "벌레", accuracy: 100, alwaysHit: true, aoe: true },
  "달려들기":  { power: 50, type: "벌레", accuracy: 100, alwaysHit: true },
  "벌레의저항": { power: 60, type: "벌레", accuracy: 100, alwaysHit: true, aoe: true },

  // ── 비퀸 독침붕 기술 ────────────────────────────────────────────
  "마구찌르기": {
    power: 1, type: "노말", accuracy: 85, alwaysHit: false,
    multiHit: { min: 2, max: 5, fixedDamage: 20 },
  },
}