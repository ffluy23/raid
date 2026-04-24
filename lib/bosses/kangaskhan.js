// lib/bosses/kangaskhan.js
// ── 캥카 레이드 보스 AI ──────────────────────────────────────────────
//
// Firestore 구조:
//   boss/kangaskhan 문서
//     .boss_baby: { name, type, hp, maxHp, attack, defense, speed }
//     .boss_state: { phase: 1|2, babyAlive: boolean }
//
// decideBossMove 반환:
//   { command: "kangaskhan_dual", nextState, moveName: null, targetSlot: null }
//   → raidBossAction.js "kangaskhan_dual" 분기에서
//     processKangaskhanTurn(data, entries, logEntries) 를 호출
//
// 아기 캥카 공격 (플레이어 → 아기):
//   raidUseMove.js 에서 targetSlot === "boss_baby" 일 때
//   data.boss_baby.hp 를 깎고, 0 이하이면 phase2 트리거
//   (raidBossAction.js update 에 boss_baby 포함 필요)

import { getTypeMultiplier } from "../typeChart.js"
import { josa }              from "../effecthandler.js"
import { rollD10 }           from "../gameUtils.js"
import { activateUmbreon } from "../umbreon.js"

// ── 상수 ─────────────────────────────────────────────────────────────
const PLAYER_SLOTS = ["p1", "p2", "p3"]
const MOM_NAME     = "엄마 캥카"
const BABY_NAME    = "아기 캥카"

// ── 엄마 캥카 기술 ───────────────────────────────────────────────────
const MOM_MOVES = {
  "누르기":       { power: 85,  type: "노말", accuracy: 100, alwaysHit: true },
  "깨트리기":     { power: 75,  type: "격투", accuracy: 100, alwaysHit: true },
  "깨물어부수기": { power: 80,  type: "악",   accuracy: 100, alwaysHit: true },
  "아이언테일":   { power: 100, type: "강철", accuracy: 100, alwaysHit: true },
}

// 기술 → 약점을 찌를 수 있는 방어 타입 목록
const MOM_WEAKNESS_MAP = {
  "깨트리기":     ["강철", "노말", "바위", "악", "얼음"],
  "깨물어부수기": ["고스트", "에스퍼"],
  "아이언테일":   ["페어리", "얼음", "바위"],
}

// ── 아기 캥카 기술 ───────────────────────────────────────────────────
const BABY_MOVES = [
  { name: "번개펀치", power: 75, type: "전기", accuracy: 100, alwaysHit: true },
  { name: "냉동펀치", power: 75, type: "얼음", accuracy: 100, alwaysHit: true },
  { name: "불꽃펀치", power: 75, type: "불", accuracy: 100, alwaysHit: true },
]

// ── 내부 유틸 ────────────────────────────────────────────────────────
function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function getActiveRankVal(ranks, key) {
  return (ranks?.[`${key}Turns`] ?? 0) > 0 ? (ranks?.[key] ?? 0) : 0
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function getAlivePlayers(data, entries) {
  return PLAYER_SLOTS.filter(s => {
    const pkmn = entries[s]?.[data[`${s}_active_idx`] ?? 0]
    return pkmn && pkmn.hp > 0
  })
}

function getLowestHpSlot(data, entries, aliveSlots) {
  let minHp = Infinity, minSlot = null
  for (const s of aliveSlots) {
    const pkmn = entries[s]?.[data[`${s}_active_idx`] ?? 0]
    if (pkmn && pkmn.hp < minHp) { minHp = pkmn.hp; minSlot = s }
  }
  return minSlot
}

// 날따름 redirect
function getTauntSelfTarget(data, entries) {
  const taunters = PLAYER_SLOTS.filter(s => {
    const pkmn = entries[s]?.[data[`${s}_active_idx`] ?? 0]
    return pkmn && pkmn.hp > 0 && (pkmn.tauntSelfTurns ?? 0) > 0
  })
  return taunters.length > 0 ? randomFrom(taunters) : null
}

// ── 약점 기반 기술 선택 ───────────────────────────────────────────────
// 수정: wt를 실제로 사용해서 방어 타입과 비교
function chooseMomMove(defender) {
  const defTypes = Array.isArray(defender.type) ? defender.type : [defender.type]
  const candidates = []
  for (const [moveName, weakTypes] of Object.entries(MOM_WEAKNESS_MAP)) {
    const moveType = MOM_MOVES[moveName].type
    // defTypes 중 weakTypes에 포함되고 실제 배율이 1.2 이상인 타입이 있으면 유효
    if (defTypes.some(dt => weakTypes.includes(dt) && getTypeMultiplier(moveType, dt) >= 1.2))
      candidates.push(moveName)
  }
  return candidates.length > 0 ? randomFrom(candidates) : "누르기"
}

// ── 데미지 계산 (캥카 전용, weather 없음) ────────────────────────────
export function calcKangaskhanDamage(attackStat, moveInfo, defenderPkmn, bossRanks) {
  const dice     = rollD10()
  const defTypes = Array.isArray(defenderPkmn.type) ? defenderPkmn.type : [defenderPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, dice, critical: false }

  const base     = moveInfo.power + attackStat * 4 + dice
  const raw      = Math.floor(base * mult)
  const atkRank  = getActiveRankVal(bossRanks, "atk")
  const afterAtk = Math.max(0, raw + atkRank)
  const defStat  = defenderPkmn.defense ?? 3
  const defRank  = getActiveRankVal(defenderPkmn.ranks ?? {}, "def")
  const baseDmg  = afterAtk - defStat * 3 - defRank * 3

  if (baseDmg <= 0) {
    const minDice = Math.floor(Math.random() * 5) + 1
    return { damage: minDice * 5, multiplier: mult, dice, critical: false, minRoll: true, minDice }
  }
  const critical = Math.random() * 100 < Math.min(100, attackStat * 2)
  return {
    damage:     critical ? Math.floor(baseDmg * 1.5) : baseDmg,
    multiplier: mult,
    dice,
    critical,
  }
}

// ── 플레이어에게 데미지 적용 ──────────────────────────────────────────
function applyDmgToPlayer(slot, dmg, entries, data, logEntries, attackerLabel = "boss") {
  const idx  = data[`${slot}_active_idx`] ?? 0
  const pkmn = entries[slot]?.[idx]
  if (!pkmn || pkmn.hp <= 0) return
  
  const damages = { [slot]: dmg }
  activateUmbreon(damages, data, entries, logEntries)
  if (damages[slot] <= 0) return
  dmg = damages[slot]

  if (pkmn.defending) {
    logEntries.push({ type: "normal", text: `${pkmn.name}${josa(pkmn.name, "은는")} 방어했다!` })
    pkmn.defending = false; pkmn.defendTurns = 0
    return
  }

  if (pkmn.enduring && dmg >= pkmn.hp) {
    pkmn.hp = 1; pkmn.enduring = false
    logEntries.push({ type: "after_hit", text: `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!` })
  } else {
    pkmn.hp = Math.max(0, pkmn.hp - dmg)
  }

  pkmn.tookDamageLastTurn = true
  pkmn.last_damage_taken  = dmg
  pkmn.defending = false; pkmn.defendTurns = 0

  logEntries.push({ type: "hit",  text: "",  meta: { defender: slot } })
  logEntries.push({ type: "hp",   text: "",  meta: { slot, hp: pkmn.hp, maxHp: pkmn.maxHp } })
  if (pkmn.hp <= 0)
    logEntries.push({ type: "faint", text: `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, meta: { slot } })
  if (pkmn.bideState) {
    pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + dmg
    pkmn.bideState.lastAttackerSlot = attackerLabel
  }
}

// ── 엄마 캥카 공격 1회 ───────────────────────────────────────────────
function processMomAttack(data, entries, logEntries, phase) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return

  // 날따름 redirect → 없으면 페이즈별 타겟팅
  const taunt = getTauntSelfTarget(data, entries)
  let targetSlot
  if (taunt && alive.includes(taunt)) {
    targetSlot = taunt
    const tp = entries[taunt]?.[data[`${taunt}_active_idx`] ?? 0]
    if (tp) logEntries.push({ type: "normal", text: `${tp.name}에게 시선이 집중되었다!` })
  } else {
    targetSlot = phase === 2
      ? (getLowestHpSlot(data, entries, alive) ?? randomFrom(alive))
      : randomFrom(alive)
  }

  const defender = entries[targetSlot]?.[data[`${targetSlot}_active_idx`] ?? 0]
  if (!defender || defender.hp <= 0) return

  const moveName = chooseMomMove(defender)
  const moveInfo = MOM_MOVES[moveName]
  const bossAtk  = data.boss_attack ?? 6
  const bossRank = data.boss_rank   ?? defaultRanks()

  if (moveName !== "누르기")
    logEntries.push({ type: "normal", text: `${MOM_NAME}${josa(MOM_NAME, "은는")} 상대의 약점을 정확히 노린다!` })
  logEntries.push({ type: "move_announce", text: `${MOM_NAME}의 ${moveName}!` })

  const { damage, multiplier, dice, critical, minRoll, minDice } =
    calcKangaskhanDamage(bossAtk, moveInfo, defender, bossRank)

  logEntries.push({ type: "dice", text: "", meta: { slot: "boss", roll: dice } })

  if (multiplier === 0) {
    logEntries.push({ type: "normal", text: `${defender.name}에게는 효과가 없다…` })
    return
  }

  let finalDmg = Math.max(1, damage)
  if ((defender.lightScreen ?? 0) > 0) {
    finalDmg = Math.max(1, Math.floor(finalDmg * 0.75))
    logEntries.push({ type: "normal", text: `${defender.name}${josa(defender.name, "은는")} 빛의장막으로 피해를 줄였다!` })
  }

  applyDmgToPlayer(targetSlot, finalDmg, entries, data, logEntries, "boss")

  if (multiplier > 1) logEntries.push({ type: "after_hit", text: "효과가 굉장했다!" })
  if (multiplier < 1) logEntries.push({ type: "after_hit", text: "효과가 별로인 듯하다…" })
  if (minRoll)        logEntries.push({ type: "after_hit", text: `${minDice}! (최소 피해 보장)` })
  else if (critical)  logEntries.push({ type: "after_hit", text: "급소에 맞았다!" })
}

// ── 아기 캥카 공격 1회 ───────────────────────────────────────────────
function processBabyAttack(data, entries, logEntries) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return

  const taunt = getTauntSelfTarget(data, entries)
  const targetSlot = (taunt && alive.includes(taunt)) ? taunt : randomFrom(alive)
  if (taunt && alive.includes(taunt) && taunt !== targetSlot) {
    const tp = entries[taunt]?.[data[`${taunt}_active_idx`] ?? 0]
    if (tp) logEntries.push({ type: "normal", text: `${tp.name}에게 시선이 집중되었다!` })
  }

  const defender = entries[targetSlot]?.[data[`${targetSlot}_active_idx`] ?? 0]
  if (!defender || defender.hp <= 0) return

  const moveInfo = randomFrom(BABY_MOVES)
  const babyAtk  = data.boss_baby?.attack ?? 3

  logEntries.push({ type: "normal",        text: `${BABY_NAME}${josa(BABY_NAME, "이가")} 서툴지만 힘껏 공격한다!` })
  logEntries.push({ type: "move_announce", text: `${BABY_NAME}의 ${moveInfo.name}!` })

  const { damage, multiplier, dice, critical, minRoll, minDice } =
    calcKangaskhanDamage(babyAtk, moveInfo, defender, defaultRanks())

  logEntries.push({ type: "dice", text: "", meta: { slot: "boss_baby", roll: dice } })

  if (multiplier === 0) {
    logEntries.push({ type: "normal", text: `${defender.name}에게는 효과가 없다…` })
    return
  }

  let finalDmg = Math.max(1, damage)
  if ((defender.lightScreen ?? 0) > 0) {
    finalDmg = Math.max(1, Math.floor(finalDmg * 0.75))
    logEntries.push({ type: "normal", text: `${defender.name}${josa(defender.name, "은는")} 빛의장막으로 피해를 줄였다!` })
  }

  applyDmgToPlayer(targetSlot, finalDmg, entries, data, logEntries, "boss_baby")

  if (multiplier > 1) logEntries.push({ type: "after_hit", text: "효과가 굉장했다!" })
  if (multiplier < 1) logEntries.push({ type: "after_hit", text: "효과가 별로인 듯하다…" })
  if (minRoll)        logEntries.push({ type: "after_hit", text: `${minDice}! (최소 피해 보장)` })
  else if (critical)  logEntries.push({ type: "after_hit", text: "급소에 맞았다!" })
}

// ── 2페이즈 전환 ──────────────────────────────────────────────────────
export function triggerPhase2(data, logEntries) {
  logEntries.push({ type: "normal", text: `${MOM_NAME}${josa(MOM_NAME, "은는")} 분노에 휩싸였다!` })

  const r        = { ...(data.boss_rank ?? defaultRanks()) }
  const RANK_CAP = { atk: 4, def: 3, spd: 5 }
  for (const key of ["atk", "def", "spd"]) {
    const cur   = r[key] ?? 0
    const delta = Math.min(2, RANK_CAP[key] - cur)
    if (delta > 0) {
      r[key]           = cur + delta
      r[`${key}Turns`] = 3
      const label = key === "atk" ? "공격" : key === "def" ? "방어" : "스피드"
      logEntries.push({ type: "normal", text: `${MOM_NAME}${josa(MOM_NAME, "의")} ${label} 랭크가 ${delta} 올라갔다! (+${r[key]})` })
    }
  }
  data.boss_rank  = r
  data.boss_state = { ...(data.boss_state ?? {}), phase: 2, babyAlive: false }
  if (data.boss_baby) data.boss_baby = { ...data.boss_baby, hp: 0 }
}

// ════════════════════════════════════════════════════════════════════
//  executeBossAction 호환 exports
// ════════════════════════════════════════════════════════════════════

export function decideBossMove(data, entries, playerSlots) {
  const state     = data.boss_state ?? {}
  const phase     = state.phase     ?? 1
  const babyAlive = state.babyAlive ?? true

  return {
    command:    "kangaskhan_dual",
    nextState:  { ...state, phase, babyAlive: babyAlive && (data.boss_baby?.hp ?? 0) > 0 },
    moveName:   null,
    targetSlot: null,
  }
}

export function processKangaskhanTurn(data, entries, logEntries) {
  const state     = data.boss_state ?? {}
  const phase     = state.phase     ?? 1
  const babyAlive = state.babyAlive ?? true

  if (phase === 1) {
    processMomAttack(data, entries, logEntries, 1)

    // 아기 캥카 행동 (살아있을 때만)
    if (babyAlive && (data.boss_baby?.hp ?? 0) > 0) {
      processBabyAttack(data, entries, logEntries)
    }

    // 행동 후 아기 HP 재확인 → 2페이즈 전환
    if (babyAlive && (data.boss_baby?.hp ?? 0) <= 0) {
      triggerPhase2(data, logEntries)
    }
  } else {
    // 2페이즈: 엄마 캥카만 행동
    processMomAttack(data, entries, logEntries, 2)
  }
}

// ── ult 없음 ─────────────────────────────────────────────────────────
export function shouldTriggerUlt()  { return false }
export function getUltTarget()      { return null  }
export function nextUltCooldown()   { return 0     }

// ── 등장 / 사망 로그 ─────────────────────────────────────────────────
export function getBossIntroLogs() {
  return [
    "엄마 캥카는 아기캥카를 지키려는 듯 으르렁거린다!",
    "아기 캥카는 엄마 캥카의 손을 잡고 있다!",
  ]
}

export function getDeathLogs() {
  return ["엄마 캥카가 쓰러졌다... 아기 캥카는 엄마 곁을 떠나지 않는다."]
}