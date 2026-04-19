// lib/bosses/앱솔.js
// 앱솔 보스 AI — 패턴, 타겟 선택, 기습 ult 처리

import { josa } from "../effecthandler.js"

// ── 로그 텍스트 풀 ────────────────────────────────────────────────
const LOGS = {
  // 1. 등장 (3개 순차 출력)
  intro: [
    "앱솔은 조용히 서 있다...",
    "앱솔은 플레이어를 노려보고 있다...",
    "익숙한 듯 낯선 눈빛이다...",
  ],
  // 2. 물기 (랜덤)
  bite: [
    "앱솔은 본능적으로 물어뜯는다!",
    "앱솔은 갑자기 공격해온다!",
  ],
  // 3. 아이언테일
  ironTail: [
    "앱솔은 거칠게 꼬리를 휘두른다!",
  ],
  // 4. 할퀴기 (랜덤)
  scratch: [
    "앱솔은 주변을 마구 할퀸다!",
    "앱솔은 눈앞의 모든 것을 공격하고 있다!",
  ],
  // 5. 악의파동 (랜덤)
  darkPulse: [
    "앱솔은 검은 파동을 퍼뜨린다!",
    "앱솔은 괴로운 듯 힘을 쏟아낸다!",
  ],
  // 6. HP 70% 이하 최초 — raidBossAction에서 한 번만 출력 (2개 순차)
  phase2Enter: [
    "앱솔의 움직임이 점점 거칠어지고 있다...",
    "앱솔은 점점 이성을 잃고 있다...",
  ],
  // 7. 2페이즈 확정 (HP ≤ 70% 이후 decideBossMove 내 commandLog)
  phase2Battle: [
    "앱솔은 완전히 이성을 잃어버렸다!",
  ],
  // 8. 기습 직전
  ultWindup: [
    "앱솔은 어둠 속으로 몸을 감춘다...",
  ],
  // 9. 기습 실행 (기습 기술 moveLog)
  ultStrike: [
    "앱솔이 순식간에 거리를 좁힌다!",
  ],
  // 10. 턴 시작 15% 플레이버 (랜덤)
  flavor: [
    "앱솔은 흔들리는 듯하다...",
    "앱솔은 무언가를 떠올리는 듯하다...",
  ],
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ── 페이즈 판정 ──────────────────────────────────────────────────────
export function getPhase(data) {
  const hp    = data.boss_current_hp ?? 0
  const maxHp = data.boss_max_hp     ?? 1
  return hp / maxHp <= 0.7 ? 2 : 1
}

// ── 단일기 타겟 선택 ─────────────────────────────────────────────────
export function selectBiteTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  const lastAttacker = data.boss_last_attacker ?? null
  if (lastAttacker && alive.includes(lastAttacker)) return lastAttacker

  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = alive.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg > 0) {
    const topDmg = alive.filter(s => (dmgMap[s] ?? 0) === maxDmg)
    if (topDmg.length === 1) return topDmg[0]
  }

  return selectLowestHpTarget(data, entries, alive)
}

export function selectIronTailTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  const lowestHp    = selectLowestHpTarget(data, entries, alive)
  const lowestHpVal = getActiveHp(data, entries, lowestHp)
  const tiedLowest  = alive.filter(s => getActiveHp(data, entries, s) === lowestHpVal)
  if (tiedLowest.length === 1) return tiedLowest[0]

  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = tiedLowest.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg > 0) {
    const topDmg = tiedLowest.filter(s => (dmgMap[s] ?? 0) === maxDmg)
    if (topDmg.length === 1) return topDmg[0]
  }

  return alive[Math.floor(Math.random() * alive.length)]
}

// ── 패턴 결정 ────────────────────────────────────────────────────────
export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const phase     = getPhase(data)
  const bossState = data.boss_state ?? { phase1Step: "bite", repeatLeft: 0 }
  const alive     = getAlivePlayers(data, entries, PLAYER_SLOTS)

  let moveName   = null
  let targetSlot = null
  let nextState  = { ...bossState }
  let moveLog    = null
  let commandLog = null

  // 15% 확률 플레이버 로그
  const flavorLog = Math.random() < 0.15 ? rand(LOGS.flavor) : null

  if (bossState.phase1Step === "bite" || !bossState.phase1Step) {
    moveName   = "물기"
    targetSlot = selectBiteTarget(data, entries, PLAYER_SLOTS)
    moveLog    = rand(LOGS.bite)
    nextState.phase1Step = "repeat"
    nextState.repeatLeft = Math.floor(Math.random() * 3) + 1
  } else if (bossState.phase1Step === "repeat") {
    const useAoe = Math.random() < 0.5
    if (useAoe) {
      moveName   = "할퀴기"
      targetSlot = null
      moveLog    = rand(LOGS.scratch)
    } else {
      moveName   = "아이언테일"
      targetSlot = selectIronTailTarget(data, entries, PLAYER_SLOTS)
      moveLog    = rand(LOGS.ironTail)
    }
    nextState.repeatLeft = (bossState.repeatLeft ?? 1) - 1
    if (nextState.repeatLeft <= 0) {
      nextState.phase1Step = "aoe"
      nextState.repeatLeft = 0
    }
  } else if (bossState.phase1Step === "aoe") {
    moveName             = "악의파동"
    targetSlot           = null
    moveLog              = rand(LOGS.darkPulse)
    nextState.phase1Step = "bite"
    nextState.repeatLeft = 0
  }

  // 2페이즈면 배틀 로그
  if (phase === 2 && !bossState.phase2BattleLogged) {
    commandLog = rand(LOGS.phase2Battle)
    nextState.phase2BattleLogged = true
  }

  return { moveName, targetSlot, nextState, moveLog, log: commandLog ?? flavorLog }
}

// ── 기습 ult 처리 ────────────────────────────────────────────────────
export function shouldTriggerUlt(data) {
  if (getPhase(data) < 2) return false
  return (data.boss_ult_cooldown ?? 0) <= 0
}

export function getUltTarget(data, entries, PLAYER_SLOTS) {
  const order    = data.current_order ?? []
  const nextSlot = order[1] ?? null
  if (nextSlot && nextSlot !== "boss" && PLAYER_SLOTS.includes(nextSlot)) {
    const idx  = data[`${nextSlot}_active_idx`] ?? 0
    const pkmn = entries[nextSlot]?.[idx]
    if (pkmn && pkmn.hp > 0) return nextSlot
  }
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  return alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : null
}

export function nextUltCooldown() {
  return Math.floor(Math.random() * 3) + 3
}

// ── 로그 export ──────────────────────────────────────────────────────

/** 등장 로그 배열 (3개 순차 출력용) */
export function getBossIntroLogs() {
  return [...LOGS.intro]
}

/** HP 70% 이하 최초 진입 시 순차 로그 (2개) */
export function getPhase2EnterLogs() {
  return [...LOGS.phase2Enter]
}

/** 기습 직전 로그 */
export function getUltWindupLog() {
  return rand(LOGS.ultWindup)
}

/** 기습 실행 로그 */
export function getUltStrikeLog() {
  return rand(LOGS.ultStrike)
}

// beequeen.js와 인터페이스 통일을 위한 단일 intro export
export function getBossIntroLog() {
  return LOGS.intro[0]
}

export function getBeedrillIdleLog(_data) { return null }
export function getDeathLogs() { return [] }

/**
 * 2페이즈 진입 체크 훅
 * raidBossAction에서 매 보스 턴 호출 — 조건 충족 시 로그+nextState 반환, 아니면 null
 */
export function checkPhase2Enter(data, nextState, _command) {
  if (data.boss_state?.phase2EnterLogged) return null
  const hpRatio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
  if (hpRatio > 0.7) return null

  return {
    logs:      getPhase2EnterLogs(),
    nextState: { ...nextState, phase2EnterLogged: true },
    clearBeedrills: false,
  }
}

// ── 공통 유틸 ────────────────────────────────────────────────────────
function getAlivePlayers(data, entries, PLAYER_SLOTS) {
  return PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0
  })
}

function getActiveHp(data, entries, slot) {
  const idx = data[`${slot}_active_idx`] ?? 0
  return entries[slot]?.[idx]?.hp ?? 0
}

function selectLowestHpTarget(data, entries, alive) {
  return alive.reduce((min, s) => {
    return getActiveHp(data, entries, s) < getActiveHp(data, entries, min) ? s : min
  }, alive[0])
}