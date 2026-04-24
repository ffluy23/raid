// lib/bosses/누리레느.js
import { josa } from "../effecthandler.js"
import { PLAYER_SLOTS, getAlivePlayers, makeLog, defaultRanks, getActiveRankVal } from "../raidBossAction.js"

// ── 페이즈 판정 ──────────────────────────────────────────────────
export function getPhase(data) {
  const ratio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
  return ratio <= 0.70 ? 2 : 1
}

// ── 유혹 걸린 플레이어 목록 ──────────────────────────────────────
function getSeducedSlots(data, entries) {
  return PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0 && (pkmn.seducedTurns ?? 0) > 0
  })
}

// ── 헤롱헤롱 걸린 플레이어 ───────────────────────────────────────
function getCharmedSlot(data, entries) {
  return PLAYER_SLOTS.find(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0 && pkmn.charmed === true
  }) ?? null
}

// ── 가장 많은 누적 딜을 넣은 슬롯 ───────────────────────────────
function getTopDamageDealer(data) {
  let top = null, topDmg = -1
  for (const s of PLAYER_SLOTS) {
    const dmg = data[`${s}_total_damage`] ?? 0
    if (dmg > topDmg) { topDmg = dmg; top = s }
  }
  return top
}

// ── 가장 최근에 공격한 슬롯 ─────────────────────────────────────
function getLastAttacker(data) {
  return data.boss_last_attacker ?? null
}

// ── 가장 HP 낮은 살아있는 슬롯 ──────────────────────────────────
function getLowestHpSlot(data, entries, excludeSlot = null) {
  let target = null, minHp = Infinity
  for (const s of PLAYER_SLOTS) {
    if (s === excludeSlot) continue
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue
    if (pkmn.hp < minHp) { minHp = pkmn.hp; target = s }
  }
  return target
}

// ── 하이드로펌프 타겟 선정 (1페이즈) ────────────────────────────
// 1순위: 유혹 걸린 대상, 2순위: 최근 가장 딜 많이 넣은 대상, 3순위: HP 가장 낮은 대상
function selectHydroPumpTarget1(data, entries) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return null
  const seduced = getSeducedSlots(data, entries).filter(s => alive.includes(s))
  if (seduced.length > 0) return seduced[Math.floor(Math.random() * seduced.length)]
  const topDealer = getTopDamageDealer(data)
  if (topDealer && alive.includes(topDealer)) return topDealer
  return getLowestHpSlot(data, entries)
}

// ── 하이드로펌프 타겟 선정 (1페이즈 4번째 턴) ───────────────────
// 1순위: HP 가장 낮은 대상, 2순위: 최근 공격한 대상, 3순위: 딜 가장 많이 넣은 대상
function selectHydroPumpTarget2(data, entries) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return null
  const lowest = getLowestHpSlot(data, entries)
  if (lowest && alive.includes(lowest)) return lowest
  const last = getLastAttacker(data)
  if (last && alive.includes(last)) return last
  const top = getTopDamageDealer(data)
  if (top && alive.includes(top)) return top
  return alive[Math.floor(Math.random() * alive.length)]
}

// ── 2페이즈 하이드로펌프 타겟 (헤롱헤롱 대상 제외) ──────────────
function selectHydroPumpTarget2P(data, entries, charmedSlot) {
  const alive = getAlivePlayers(data, entries).filter(s => s !== charmedSlot)
  if (alive.length === 0) return null
  // 1순위: HP 낮은 대상
  return getLowestHpSlot(data, entries, charmedSlot) ?? alive[Math.floor(Math.random() * alive.length)]
}

// ════════════════════════════════════════════════════════════════════
//  shouldTriggerUlt / getUltTarget (2페이즈 전용)
// ════════════════════════════════════════════════════════════════════
export function shouldTriggerUlt(data) {
  // 2페이즈에서만. 헤롱헤롱은 루프 내부에서 직접 처리하므로 여기선 false
  return false
}

export function getUltTarget() { return null }
export function nextUltCooldown() { return 0 }

// ════════════════════════════════════════════════════════════════════
//  보스 등장 로그
// ════════════════════════════════════════════════════════════════════
export function getBossIntroLogs() {
  return [
    "누리레느가 등장했다!",
    "아름다운 노래가 울려 퍼지기 시작한다...",
  ]
}

// ════════════════════════════════════════════════════════════════════
//  2페이즈 진입 훅
// ════════════════════════════════════════════════════════════════════
export function checkPhase2Enter(data, nextState, command) {
  if (data._phase2Entered) return null
  const ratio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
  if (ratio > 0.70) return null

  data._phase2Entered = true
  return {
    logs: [
      "누리레느의 노래가 변했다!",
      "누리레느가 선공을 빼앗았다!",
    ],
    nextState: {
      ...nextState,
      phase: 2,
      loopStep: 0,          // 2페이즈 루프 스텝
      hydro1Done: false,
      hydro2Done: false,
      waveDone: false,
      dealCheckDmg: 0,      // 딜체크 누적 데미지
      dealCheckActive: false,
      charmedSlot: null,
    },
    clearBeedrills: false,
  }
}

// ════════════════════════════════════════════════════════════════════
//  메인: decideBossMove
// ════════════════════════════════════════════════════════════════════
export function decideBossMove(data, entries, playerSlots) {
  const state    = data.boss_state ?? {}
  const phase    = state.phase ?? 1
  const bossName = data.boss_name ?? "누리레느"
  const alive    = getAlivePlayers(data, entries)

  // ── 생명의물방울 체크 (HP 80% 이하, 최초 1회) ─────────────────
  if (!state.dropletUsed) {
    const ratio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
    if (ratio <= 0.80) {
      return {
        command:   "direct",
        moveName:  "생명의물방울",
        targetSlot: null,
        log:       `${bossName}${josa(bossName, "은는")} 생명의물방울로 체력을 회복했다!`,
        nextState: { ...state, dropletUsed: true },
      }
    }
  }

  if (phase === 2) return _decidePh2(data, entries, state, bossName, alive)
  return _decidePh1(data, entries, state, bossName, alive)
}

// ────────────────────────────────────────────────────────────────────
//  1페이즈 행동 결정
// ────────────────────────────────────────────────────────────────────
function _decidePh1(data, entries, state, bossName, alive) {
  const step = (state.loopStep ?? 0) % 6  // 0~5

  // 유혹 중인 대상이 있으면 스텝 1부터 시작 (스텝 0 건너뜀)
  const seduced = getSeducedSlots(data, entries)

  // 스텝 0 → 차밍보이스: 유혹 부여
  if (step === 0) {
    const target = alive.length > 0
      ? alive[Math.floor(Math.random() * alive.length)]
      : null
    const idx  = target ? (data[`${target}_active_idx`] ?? 0) : null
    const pkmn = target ? entries[target]?.[idx] : null
    const pkmnName = pkmn?.name ?? "???"

    return {
      command:   "nuri_charm",
      moveName:  "차밍보이스",
      targetSlot: target,
      log:       `${bossName}${josa(bossName, "이가")} 노래를 부르기 시작한다...`,
      moveLog:   `${pkmnName}${josa(pkmnName, "이가")} 노래에 홀린다!`,
      nextState: { ...state, loopStep: 1, lastCharmedSlot: target },
    }
  }

  // 스텝 1 → 하이드로펌프 (유혹 타겟 우선)
  if (step === 1) {
    const target   = selectHydroPumpTarget1(data, entries)
    const idx      = target ? (data[`${target}_active_idx`] ?? 0) : null
    const pkmnName = target ? (entries[target]?.[idx]?.name ?? "???") : "???"
    return {
      command:   "direct",
      moveName:  "하이드로펌프",
      targetSlot: target,
      log:       `${bossName}${josa(bossName, "의")} 시선이 ${pkmnName}에게 꽂힌다...!`,
      nextState: { ...state, loopStep: 2 },
    }
  }

  // 스텝 2 → 파도타기 80%
  if (step === 2) {
    return {
      command:   "nuri_wave_weak",
      moveName:  "파도타기",
      targetSlot: null,
      log:       null,
      nextState: { ...state, loopStep: 3 },
    }
  }

  // 스텝 3 → 하이드로펌프 (다른 대상)
  if (step === 3) {
    const target = selectHydroPumpTarget2(data, entries)
    const idx      = target ? (data[`${target}_active_idx`] ?? 0) : null
    const pkmnName = target ? (entries[target]?.[idx]?.name ?? "???") : "???"
    return {
      command:   "direct",
      moveName:  "하이드로펌프",
      targetSlot: target,
      log:       `${bossName}${josa(bossName, "의")} 시선이 ${pkmnName}에게 꽂힌다...!`,
      nextState: { ...state, loopStep: 4 },
    }
  }

  // 스텝 4 → 파도 예고 (행동 없음)
  if (step === 4) {
    return {
      command:   "wave_warning",
      moveName:  null,
      targetSlot: null,
      log:       "거대한 파도가 몰려온다...",
      nextState: { ...state, loopStep: 5 },
    }
  }

  // 스텝 5 → 파도타기 100%
  return {
    command:   "nuri_wave_full",
    moveName:  "파도타기",
    targetSlot: null,
    log:       null,
    nextState: { ...state, loopStep: 0 },  // 루프 리셋
  }
}

// ────────────────────────────────────────────────────────────────────
//  2페이즈 행동 결정
// ────────────────────────────────────────────────────────────────────
function _decidePh2(data, entries, state, bossName, alive) {
  const loopStep = state.loopStep ?? 0

  // step 0: 헤롱헤롱 부여
  if (loopStep === 0) {
    const target   = alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : null
    const idx      = target ? (data[`${target}_active_idx`] ?? 0) : null
    const pkmnName = target ? (entries[target]?.[idx]?.name ?? "???") : "???"
    return {
      command:    "nuri_charm2",
      moveName:   "헤롱헤롱",
      targetSlot: target,
      log:        `${bossName}${josa(bossName, "의")} 노래가 정신을 잠식한다...`,
      moveLog:    `${pkmnName}${josa(pkmnName, "이가")} 마음을 빼앗긴다!`,
      nextState: {
        ...state,
        loopStep:       1,
        charmedSlot:    target,
        dealCheckDmg:   0,
        dealCheckActive: true,
        dealCheckRound: 0,
      },
    }
  }

  // step 1~3: 하이드로펌프→하이드로펌프→파도타기
  const charmedSlot = state.charmedSlot ?? null

  if (loopStep === 1) {
    const target = selectHydroPumpTarget2P(data, entries, charmedSlot)
    const idx      = target ? (data[`${target}_active_idx`] ?? 0) : null
    const pkmnName = target ? (entries[target]?.[idx]?.name ?? "???") : "???"
    const charmedPkmn = charmedSlot
      ? entries[charmedSlot]?.[data[`${charmedSlot}_active_idx`] ?? 0]
      : null
    const charmedName = charmedPkmn?.name ?? "???"
    return {
      command:    "direct",
      moveName:   "하이드로펌프",
      targetSlot: target,
      log:        `${charmedName}${josa(charmedName, "을를")} 구해야 한다!`,
      nextState:  { ...state, loopStep: 2 },
    }
  }

  if (loopStep === 2) {
    const target = selectHydroPumpTarget2P(data, entries, charmedSlot)
    return {
      command:    "direct",
      moveName:   "하이드로펌프",
      targetSlot: target,
      log:        null,
      nextState:  { ...state, loopStep: 3 },
    }
  }

  if (loopStep === 3) {
    // 랜덤 하나 (헤롱헤롱 제외)
    const candidates = getAlivePlayers(data, entries).filter(s => s !== charmedSlot)
    const target = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null
    return {
      command:    "nuri_wave_weak",
      moveName:   "파도타기",
      targetSlot: target,
      log:        null,
      nextState:  { ...state, loopStep: 4 },
    }
  }

  // step 4: 딜 체크 + 문포스
  if (loopStep === 4) {
    return {
      command:    "nuri_deal_check",
      moveName:   null,
      targetSlot: charmedSlot,
      log:        null,
      nextState:  { ...state, loopStep: 0, charmedSlot: null, dealCheckActive: false, dealCheckDmg: 0 },
    }
  }

  // fallback
  return {
    command:    "nuri_charm2",
    moveName:   "헤롱헤롱",
    targetSlot: alive[0] ?? null,
    log:        `${bossName}${josa(bossName, "의")} 노래가 정신을 잠식한다...`,
    moveLog:    null,
    nextState:  { ...state, loopStep: 1, charmedSlot: alive[0] ?? null, dealCheckDmg: 0, dealCheckActive: true },
  }
}

export function getDeathLogs() {
  return ["누리레느가 쓰러졌다!", "노래가 멈췄다..."]
}