// lib/bosses/앱솔.js
// 앱솔 보스 AI — 패턴, 타겟 선택, 기습 ult 처리

// ── 페이즈 판정 ──────────────────────────────────────────────────────
export function getPhase(data) {
  const hp    = data.boss_current_hp ?? 0
  const maxHp = data.boss_max_hp     ?? 1
  return hp / maxHp <= 0.7 ? 2 : 1
}

// ── 단일기 타겟 선택 ─────────────────────────────────────────────────
// 물기: 1) 가장 최근 공격자 2) 누적 딜 최대 3) HP 최저
export function selectBiteTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  // 1) 가장 최근 공격자
  const lastAttacker = data.boss_last_attacker ?? null
  if (lastAttacker && alive.includes(lastAttacker)) return lastAttacker

  // 2) 누적 딜 최대
  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = alive.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg > 0) {
    const topDmg = alive.filter(s => (dmgMap[s] ?? 0) === maxDmg)
    if (topDmg.length === 1) return topDmg[0]
  }

  // 3) HP 최저
  return selectLowestHpTarget(data, entries, alive)
}

// 아이언테일: 1) HP 최저 2) 누적 딜 최대 3) 랜덤
export function selectIronTailTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  // 1) HP 최저
  const lowestHp = selectLowestHpTarget(data, entries, alive)
  const lowestHpVal = getActiveHp(data, entries, lowestHp)
  const tiedLowest  = alive.filter(s => getActiveHp(data, entries, s) === lowestHpVal)
  if (tiedLowest.length === 1) return tiedLowest[0]

  // 2) 누적 딜 최대
  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = tiedLowest.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg > 0) {
    const topDmg = tiedLowest.filter(s => (dmgMap[s] ?? 0) === maxDmg)
    if (topDmg.length === 1) return topDmg[0]
  }

  // 3) 랜덤
  return alive[Math.floor(Math.random() * alive.length)]
}

// ── 패턴 결정 ────────────────────────────────────────────────────────
// bossState: { phase1Step, repeatCount, repeatLeft }
// phase1Step: "bite" | "repeat" | "aoe"
// repeatLeft: 남은 반복 횟수 (1~3 랜덤)

export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const phase     = getPhase(data)
  const bossState = data.boss_state ?? { phase1Step: "bite", repeatLeft: 0 }
  const alive     = getAlivePlayers(data, entries, PLAYER_SLOTS)

  let moveName   = null
  let targetSlot = null   // null이면 광역
  let nextState  = { ...bossState }

  if (bossState.phase1Step === "bite" || !bossState.phase1Step) {
    // 1. 물기
    moveName       = "물기"
    targetSlot     = selectBiteTarget(data, entries, PLAYER_SLOTS)
    nextState.phase1Step = "repeat"
    nextState.repeatLeft = Math.floor(Math.random() * 3) + 1  // 1~3회
  } else if (bossState.phase1Step === "repeat") {
    // 2. 아이언테일 또는 할퀴기 (랜덤)
    const useAoe = Math.random() < 0.5
    if (useAoe) {
      moveName   = "할퀴기"
      targetSlot = null   // 광역
    } else {
      moveName   = "아이언테일"
      targetSlot = selectIronTailTarget(data, entries, PLAYER_SLOTS)
    }
    nextState.repeatLeft = (bossState.repeatLeft ?? 1) - 1
    if (nextState.repeatLeft <= 0) {
      nextState.phase1Step = "aoe"
      nextState.repeatLeft = 0
    }
  } else if (bossState.phase1Step === "aoe") {
    // 3. 악의파동 → 다시 처음으로
    moveName             = "악의파동"
    targetSlot           = null   // 광역
    nextState.phase1Step = "bite"
    nextState.repeatLeft = 0
  }

  return { moveName, targetSlot, nextState }
}

// ── 기습 ult 처리 ────────────────────────────────────────────────────
// 2페이즈에서 3~5턴마다 한 번씩 끼어들어 원래 행동해야 했던 플레이어를 공격
// current_order에서 다음 행동자를 타겟으로 삼음

export function shouldTriggerUlt(data) {
  const phase = getPhase(data)
  if (phase < 2) return false

  const ultCooldown = data.boss_ult_cooldown ?? 0
  if (ultCooldown > 0) return false

  // 첫 기습은 2페이즈 진입 직후 바로
  return true
}

export function getUltTarget(data, entries, PLAYER_SLOTS) {
  // current_order에서 다음 행동자 (보스 자신 제외, 현재 행동 중인 슬롯 다음)
  const order = data.current_order ?? []
  // 현재 처리 중인 슬롯은 order[0]이므로 order[1]이 다음 행동자
  const nextSlot = order[1] ?? null
  if (nextSlot && nextSlot !== "boss" && PLAYER_SLOTS.includes(nextSlot)) {
    const idx  = data[`${nextSlot}_active_idx`] ?? 0
    const pkmn = entries[nextSlot]?.[idx]
    if (pkmn && pkmn.hp > 0) return nextSlot
  }
  // 다음 행동자가 없거나 기절 → 살아있는 랜덤 플레이어
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  return alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : null
}

// 기습 사용 후 cooldown 설정 (3~5턴 랜덤)
export function nextUltCooldown() {
  return Math.floor(Math.random() * 3) + 3  // 3~5
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
  const idx  = data[`${slot}_active_idx`] ?? 0
  return entries[slot]?.[idx]?.hp ?? 0
}

function selectLowestHpTarget(data, entries, alive) {
  return alive.reduce((min, s) => {
    return getActiveHp(data, entries, s) < getActiveHp(data, entries, min) ? s : min
  }, alive[0])
}