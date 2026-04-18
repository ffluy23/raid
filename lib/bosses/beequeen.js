// lib/bosses/비퀸.js
// 비퀸 보스 AI — 1페이즈(독침붕 소환/지령), 2페이즈(직접 공격)

// ════════════════════════════════════════════════════════════════════
//  상수
// ════════════════════════════════════════════════════════════════════
const PLAYER_SLOTS = ["p1", "p2", "p3"]

// 2페이즈 기술 정의 (bossMoves.js에 추가 필요)
// "독침"    { power: 50, type: "독",  alwaysHit: true }
// "시저크로스" { power: 45, type: "벌레", alwaysHit: true, aoe: true }
// "달려들기"  { power: 50, type: "벌레", alwaysHit: true }
// "벌레의저항" { power: 60, type: "벌레", alwaysHit: true, aoe: true }

// ════════════════════════════════════════════════════════════════════
//  페이즈 판정
// ════════════════════════════════════════════════════════════════════
export function getPhase(data) {
  const hp    = data.boss_current_hp ?? 0
  const maxHp = data.boss_max_hp     ?? 1
  // HP 60% 이하이면 즉시 2페이즈
  if (hp / maxHp <= 0.6) return 2
  // 독침붕 6마리 누적 처치 달성 시 2페이즈
  if ((data.boss_state?.beedrillKillCount ?? 0) >= 6) return 2
  return 1
}

// ════════════════════════════════════════════════════════════════════
//  공통 유틸
// ════════════════════════════════════════════════════════════════════
function getAlivePlayers(data, entries) {
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

function getActiveMaxHp(data, entries, slot) {
  const idx = data[`${slot}_active_idx`] ?? 0
  return entries[slot]?.[idx]?.maxHp ?? 1
}

function selectLowestHpTarget(data, entries, alive) {
  return alive.reduce((min, s) =>
    getActiveHp(data, entries, s) < getActiveHp(data, entries, min) ? s : min
  , alive[0])
}

// 누적 딜 최대 대상 (boss_damage_taken: { p1: 100, p2: 50, ... })
function selectHighestDamageTarget(data, alive) {
  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = alive.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg <= 0) return null
  const top = alive.filter(s => (dmgMap[s] ?? 0) === maxDmg)
  return top.length === 1 ? top[0] : null
}

// ════════════════════════════════════════════════════════════════════
//  독침붕 유틸
// ════════════════════════════════════════════════════════════════════

// 살아있는 독침붕 목록 반환 (인덱스 기준)
export function getAliveBeedrills(data) {
  const beedrills = data.boss_beedrills ?? []
  return beedrills
    .map((b, i) => ({ ...b, _idx: i }))
    .filter(b => b.hp > 0)
}

// 독침붕 중 한 마리라도 HP 비율이 threshold 이하인지
function anyBeedrill(data, threshold) {
  const beedrills = data.boss_beedrills ?? []
  return beedrills.some(b => b.hp > 0 && b.hp / (b.maxHp ?? 1) <= threshold)
}

// ════════════════════════════════════════════════════════════════════
//  1페이즈 — 타겟 선택
// ════════════════════════════════════════════════════════════════════

// 공격지령 타겟: 1) 누적딜 최대 2) HP 최저 3) 랜덤
export function selectAttackCommandTarget(data, entries) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return null

  // 1) 누적 딜 최대
  const topDmg = selectHighestDamageTarget(data, alive)
  if (topDmg) return { slot: topDmg, priority: "revenge" }

  // 2) HP 최저
  return { slot: selectLowestHpTarget(data, entries, alive), priority: "normal" }
}

// ════════════════════════════════════════════════════════════════════
//  1페이즈 — 비퀸 행동 결정
// ════════════════════════════════════════════════════════════════════
// bossState 구조:
// {
//   phase: 1 | 2,
//   step: "summon" | "attack" | "defend" | "heal" | "recharge" | "recharge2",
//   beedrillKillCount: number,   // 누적 독침붕 처치 수
//   rechargeLeft: number,        // 소환 대기 남은 턴
// }

export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const phase     = getPhase(data)
  const bossState = data.boss_state ?? { step: "summon", beedrillKillCount: 0, rechargeLeft: 0 }

  if (phase === 2) return decideBossMove_Phase2(data, entries, bossState)
  return decideBossMove_Phase1(data, entries, bossState)
}

function decideBossMove_Phase1(data, entries, bossState) {
  const step      = bossState.step ?? "summon"
  const beedrills = data.boss_beedrills ?? []
  const aliveBees = getAliveBeedrills(data)

  // ── 재충전 대기 (독침붕 전멸 후 2턴) ──────────────────────────
  if (step === "recharge" || step === "recharge2") {
    const nextStep    = step === "recharge" ? "recharge2" : "summon"
    const nextState   = { ...bossState, step: nextStep }
    return {
      moveName:   null,         // 행동 없음
      targetSlot: null,
      command:    "recharge",
      nextState,
      log: "여왕은 힘을 비축하고 있다!",
    }
  }

  // ── 소환 ──────────────────────────────────────────────────────
  if (step === "summon" || aliveBees.length === 0) {
    const nextState = { ...bossState, step: "attack" }
    return {
      moveName:   null,
      targetSlot: null,
      command:    "summon",
      nextState,
      log: "비퀸이 독침붕을 두 마리 소환했다!",
    }
  }

  // ── 회복 조건 (30% 이하) ──────────────────────────────────────
  if (anyBeedrill(data, 0.3)) {
    // 회복 후 판단은 raidBossAction에서 HP 복구 뒤 처리
    const nextState = { ...bossState, step: "attack" }  // 회복 후 attack으로 돌아감 (실제 분기는 executeBossAction에서)
    return {
      moveName:   null,
      targetSlot: null,
      command:    "heal",
      nextState,
      log: "비퀸이 회복지령을 내렸다!",
    }
  }

  // ── 방어 조건 (50% 이하) ──────────────────────────────────────
  if (anyBeedrill(data, 0.5)) {
    const nextState = { ...bossState, step: "attack" }
    return {
      moveName:   null,
      targetSlot: null,
      command:    "defend",
      nextState,
      log: "비퀸이 방어지령을 내렸다!",
    }
  }

  // ── 공격지령 ──────────────────────────────────────────────────
  const target    = selectAttackCommandTarget(data, entries)
  const nextState = { ...bossState, step: "attack" }
  return {
    moveName:   "마구찌르기",
    targetSlot: target?.slot ?? null,
    command:    "attack",
    priority:   target?.priority ?? "normal",
    nextState,
    log: target?.priority === "revenge"
      ? "독침붕은 여왕을 지킨다!"
      : null,
  }
}

// ════════════════════════════════════════════════════════════════════
//  2페이즈 — 비퀸 직접 공격
// ════════════════════════════════════════════════════════════════════
// phase2Step: "sting1" | "sting2" | "scissor" | "enrage" | "resist"

function decideBossMove_Phase2(data, entries, bossState) {
  const alive   = getAlivePlayers(data, entries)
  if (alive.length === 0) return { moveName: null, targetSlot: null, command: null, nextState: bossState }

  const hp      = data.boss_current_hp ?? 0
  const maxHp   = data.boss_max_hp     ?? 1
  const hpRatio = hp / maxHp

  // 20% 이하: 벌레의저항/시저크로스 반복
  if (hpRatio <= 0.2) {
    const useResist = Math.random() < 0.5
    const moveName  = useResist ? "벌레의저항" : "시저크로스"
    const nextState = { ...bossState, phase2Step: "resist" }
    return {
      moveName,
      targetSlot: null,  // 광역
      command:    "direct",
      nextState,
    }
  }

  // 40% 이하: 달려들기 삽입 후 독침 루프 복귀
  if (hpRatio <= 0.4) {
    const step = bossState.phase2Step ?? "sting1"
    // 달려들기 발동 조건: sting1 차례일 때 삽입
    if (step === "sting1" || step === "enrage") {
      const target    = selectEnrageTarget(data, entries, alive)
      const nextState = { ...bossState, phase2Step: "sting1" }
      return {
        moveName:   "달려들기",
        targetSlot: target,
        command:    "direct",
        nextState,
        log: "비퀸이 달려들었다!",
      }
    }
  }

  // 기본 루프: 독침→독침→시저크로스
  const step      = bossState.phase2Step ?? "sting1"
  let moveName, targetSlot, nextStep

  if (step === "sting1") {
    moveName   = "독침"
    targetSlot = selectStingTarget(data, entries, alive)
    nextStep   = "sting2"
  } else if (step === "sting2") {
    moveName   = "독침"
    targetSlot = selectStingTarget(data, entries, alive)
    nextStep   = "scissor"
  } else {
    // scissor 또는 그 외 → 시저크로스
    moveName   = "시저크로스"
    targetSlot = null   // 광역
    nextStep   = "sting1"
  }

  const nextState = { ...bossState, phase2Step: nextStep }
  return {
    moveName,
    targetSlot,
    command: "direct",
    nextState,
  }
}

// 독침 타겟: 1) HP 최저 2) 누적딜 최대 3) 랜덤
function selectStingTarget(data, entries, alive) {
  // 1) HP 최저
  const lowestHp  = selectLowestHpTarget(data, entries, alive)
  const lowestVal = getActiveHp(data, entries, lowestHp)
  const tiedLow   = alive.filter(s => getActiveHp(data, entries, s) === lowestVal)
  if (tiedLow.length === 1) return tiedLow[0]

  // 2) 누적딜 최대
  const topDmg = selectHighestDamageTarget(data, tiedLow)
  if (topDmg) return topDmg

  // 3) 랜덤
  return alive[Math.floor(Math.random() * alive.length)]
}

// 달려들기 타겟: 1) 누적딜 최대 2) HP 최저 3) 랜덤
function selectEnrageTarget(data, entries, alive) {
  // 1) 누적딜 최대
  const topDmg = selectHighestDamageTarget(data, alive)
  if (topDmg) return topDmg

  // 2) HP 최저
  return selectLowestHpTarget(data, entries, alive)
}

// ════════════════════════════════════════════════════════════════════
//  shouldTriggerUlt — 비퀸은 ult 개념 없음 (앱솔 호환용)
// ════════════════════════════════════════════════════════════════════
export function shouldTriggerUlt(_data) {
  return false
}

export function getUltTarget(_data, _entries) {
  return null
}

export function nextUltCooldown() {
  return 0
}