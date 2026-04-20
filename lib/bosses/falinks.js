// lib/bosses/대여르.js
// 대여르 보스 AI — 6개체 순차 교체, 배수의진 랭크 인계

import { josa } from "../effecthandler.js"

// ── HP 구간 → 개체 교체 임계값 ──────────────────────────────────────
// "총 HP의 X% 소모 시 현재 개체 퇴장"
// currentUnit 1 → 10% 소모 시 2번으로
// currentUnit 2 → 20% 소모 시 3번으로
// currentUnit 3 → 40% 소모 시 4번으로
// currentUnit 4 → 50% 소모 시 5번으로
// currentUnit 5 → 70% 소모 시 6번으로
// currentUnit 6 → 마지막 (교체 없음)
const UNIT_THRESHOLDS = {
  1: 0.10,
  2: 0.20,
  3: 0.40,
  4: 0.50,
  5: 0.70,
}

// ── 로그 텍스트 풀 ────────────────────────────────────────────────
const LOGS = {
  intro: [
    "대여르 부대가 행진해 온다...",
    "선두의 개체가 눈을 빛낸다...",
    "전열을 가다듬는다...",
  ],
  infight: [
    "대여르는 전력으로 덤벼든다!",
    "대여르는 격렬하게 맞부딪힌다!",
  ],
  stoneShower: [
    "대여르는 바위를 마구 뿌린다!",
    "대여르는 사방에 돌을 날린다!",
  ],
  psyshock: [
    "대여르는 강렬한 사념을 쏘아낸다!",
    "대여르의 눈에서 빛이 쏟아진다!",
  ],
  unitSwap: [
    "개체가 힘을 넘겨주고 물러난다!",
    "다음 개체가 앞으로 나선다!",
  ],
  // 각 개체 등장 대사 (인덱스 = unit - 1)
  unitEnter: [
    "1번 개체가 선두에 섰다!",
    "2번 개체가 나타났다!",
    "3번 개체가 앞으로 나섰다! 뭔가 다르다...",
    "4번 개체가 등장했다! 기세가 심상치 않다!",
    "5번 개체가 나타났다! 강한 압박감이 느껴진다!",
    "마지막 개체가 등장했다!! 전력을 다해야 한다!",
  ],
  flavor: [
    "대여르 부대는 흔들리지 않는다...",
    "대여르는 냉정하게 상황을 파악하고 있다...",
    "대여르 부대의 발소리가 울린다...",
  ],
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ── 페이즈 판정 ──────────────────────────────────────────────────────
export function getPhase(data) {
  const unit = data.boss_state?.currentUnit ?? 1
  return unit >= 3 ? 2 : 1
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

// ── 인파이트 타겟 선택 ───────────────────────────────────────────────
// 우선순위:
// 1. 직전 턴에 공격 기술을 사용하지 않은 적 (power=0인 기술 사용한 사람)
// 2. HP가 가장 낮은 적
// 3. HP가 가장 높은 적
// 4. 랜덤
export function selectInfightTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  // 1. 직전에 비공격 기술 사용자
  const nonAttackers = alive.filter(s => {
    const lastMove = data[`${s}_last_move`] ?? null
    if (!lastMove) return false
    // power=0 이거나 공격 기술이 아닌 경우
    return lastMove.power === 0 || !lastMove.power
  })
  if (nonAttackers.length > 0) return nonAttackers[Math.floor(Math.random() * nonAttackers.length)]

  // 2. HP 가장 낮은 적
  const hpList = alive.map(s => ({ s, hp: getActiveHp(data, entries, s) }))
  hpList.sort((a, b) => a.hp - b.hp)
  const minHp = hpList[0].hp
  const lowestGroup = hpList.filter(x => x.hp === minHp)
  if (lowestGroup.length === 1) return lowestGroup[0].s

  // 3. HP 가장 높은 적
  hpList.sort((a, b) => b.hp - a.hp)
  const maxHp = hpList[0].hp
  const highestGroup = hpList.filter(x => x.hp === maxHp)
  if (highestGroup.length === 1) return highestGroup[0].s

  // 4. 랜덤
  return alive[Math.floor(Math.random() * alive.length)]
}

// ── 사념의박치기 타겟 선택 ───────────────────────────────────────────
// 우선순위:
// 1. 직전 턴에 공격 기술을 사용한 적 (power>0)
// 2. HP가 가장 높은 적
// 3. HP가 가장 낮은 적
// 4. 랜덤
export function selectPsyshockTarget(data, entries, PLAYER_SLOTS) {
  const alive = getAlivePlayers(data, entries, PLAYER_SLOTS)
  if (alive.length === 0) return null

  // 1. 직전에 공격 기술 사용자
  const attackers = alive.filter(s => {
    const lastMove = data[`${s}_last_move`] ?? null
    if (!lastMove) return false
    return (lastMove.power ?? 0) > 0
  })
  if (attackers.length > 0) return attackers[Math.floor(Math.random() * attackers.length)]

  // 2. HP 가장 높은 적
  const hpList = alive.map(s => ({ s, hp: getActiveHp(data, entries, s) }))
  hpList.sort((a, b) => b.hp - a.hp)
  const maxHp = hpList[0].hp
  const highestGroup = hpList.filter(x => x.hp === maxHp)
  if (highestGroup.length === 1) return highestGroup[0].s

  // 3. HP 가장 낮은 적
  hpList.sort((a, b) => a.hp - b.hp)
  const minHp = hpList[0].hp
  const lowestGroup = hpList.filter(x => x.hp === minHp)
  if (lowestGroup.length === 1) return lowestGroup[0].s

  // 4. 랜덤
  return alive[Math.floor(Math.random() * alive.length)]
}

// ── 다음 개체로 교체해야 하는지 체크 ────────────────────────────────
// returns: { shouldSwap: bool, nextUnit: number }
export function checkUnitSwap(data) {
  const currentUnit = data.boss_state?.currentUnit ?? 1
  if (currentUnit >= 6) return { shouldSwap: false, nextUnit: 6 }

  const threshold = UNIT_THRESHOLDS[currentUnit]
  if (threshold === undefined) return { shouldSwap: false, nextUnit: currentUnit }

  const maxHp     = data.boss_max_hp ?? 1
  const currentHp = data.boss_current_hp ?? 0
  const lostRatio = 1 - (currentHp / maxHp)

  if (lostRatio >= threshold) {
    return { shouldSwap: true, nextUnit: currentUnit + 1 }
  }
  return { shouldSwap: false, nextUnit: currentUnit }
}

// ── 배수의진 랭크 계산 ───────────────────────────────────────────────
// 각 교체 시 atk/def/spd +1씩 누적
// nextUnit 번째 개체가 받을 inheritedRanks 반환
function calcInheritedRanks(currentInherited) {
  const base = currentInherited ?? { atk: 0, def: 0, spd: 0 }
  return {
    atk: base.atk + 1,
    def: base.def + 1,
    spd: base.spd + 1,
  }
}

// ── 패턴 결정 ────────────────────────────────────────────────────────
export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const bossState   = data.boss_state ?? {}
  const currentUnit = bossState.currentUnit ?? 1
  const specialCooldown = bossState.specialCooldown ?? 0
  const canUseUlt   = currentUnit >= 3

  let moveName   = null
  let targetSlot = null
  let nextState  = { ...bossState }
  let moveLog    = null
  let commandLog = null

  // 15% 확률 플레이버
  const flavorLog = Math.random() < 0.15 ? rand(LOGS.flavor) : null

  // 스페셜 쿨다운이 0이면 스페셜 기술 발동
  if (specialCooldown <= 0) {
    if (canUseUlt && Math.random() < 0.5) {
      // 3번 개체 이상: 사념의박치기 또는 스톤샤워 중 하나 선택
      // 50% 확률로 사념의박치기, 50% 스톤샤워
      if (Math.random() < 0.5) {
        moveName   = "사념의박치기"
        targetSlot = selectPsyshockTarget(data, entries, PLAYER_SLOTS)
        moveLog    = rand(LOGS.psyshock)
      } else {
        moveName   = "스톤샤워"
        targetSlot = null // aoe
        moveLog    = rand(LOGS.stoneShower)
      }
    } else {
      // 1~2번 개체 또는 확률 미달: 스톤샤워
      moveName   = "스톤샤워"
      targetSlot = null
      moveLog    = rand(LOGS.stoneShower)
    }
    // 다음 쿨다운 설정: 2~3턴
    nextState.specialCooldown = Math.floor(Math.random() * 2) + 2
  } else {
    // 기본: 인파이트
    moveName   = "인파이트"
    targetSlot = selectInfightTarget(data, entries, PLAYER_SLOTS)
    moveLog    = rand(LOGS.infight)
    nextState.specialCooldown = specialCooldown - 1
  }

  return {
    moveName,
    targetSlot,
    nextState,
    moveLog,
    log: commandLog ?? flavorLog,
  }
}

// ── ult 관련 (대여르는 decideBossMove 내에서 처리하므로 shouldTriggerUlt=false) ──
export function shouldTriggerUlt(_data) { return false }
export function getUltTarget(_data, _entries, _PLAYER_SLOTS) { return null }
export function nextUltCooldown() { return 0 }

// ── 로그 export ──────────────────────────────────────────────────────
export function getBossIntroLogs() {
  return [...LOGS.intro]
}

export function getBossIntroLog() {
  return LOGS.intro[0]
}

export function getPhase2EnterLogs() { return [] }
export function getBeedrillIdleLog(_data) { return null }
export function getDeathLogs() { return [] }
export function getUltWindupLog() { return null }
export function getUltStrikeLog() { return null }

// ── 2페이즈 진입 훅 (대여르는 개체 교체로 처리하므로 null 반환) ──────
export function checkPhase2Enter(_data, _nextState, _command) {
  return null
}

// ── 개체 교체 처리 (raidBossAction에서 호출) ─────────────────────────
// returns: { logs: string[], nextState: object } | null
export function processUnitSwap(data, nextState) {
  const { shouldSwap, nextUnit } = checkUnitSwap(data)
  if (!shouldSwap) return null

  const currentUnit      = data.boss_state?.currentUnit ?? 1
  const currentInherited = data.boss_state?.inheritedRanks ?? { atk: 0, def: 0, spd: 0 }
  const newInherited     = calcInheritedRanks(currentInherited)

  const logs = [
    rand(LOGS.unitSwap),
    LOGS.unitEnter[nextUnit - 1] ?? `${nextUnit}번 개체가 등장했다!`,
    `배수의진! 공격/방어/스피드 랭크가 각각 +${newInherited.atk} 올라간다!`,
  ]

  const newState = {
    ...nextState,
    currentUnit:    nextUnit,
    inheritedRanks: newInherited,
    // 교체 시 쿨다운 초기화 (새 개체는 첫 턴에 인파이트부터)
    specialCooldown: Math.floor(Math.random() * 2) + 1,
    phase2BattleLogged: nextUnit >= 3 ? (nextState.phase2BattleLogged ?? false) : false,
  }

  return { logs, nextState: newState }
}

// ── boss_rank에 inheritedRanks 반영 ──────────────────────────────────
// executeBossAction에서 개체 교체 후 호출
// 주의: 기존 랭크(인파이트 페널티 등)에 더하지 않고 inheritedRanks를 그대로 세팅
// 이전 개체가 깎아먹은 방어 랭크는 다음 개체에 이어지지 않음
export function applyInheritedRanks(data, inheritedRanks) {
  if (!inheritedRanks) return
  const ATK_MAX = 4, DEF_MAX = 3, SPD_MAX = 5
  data.boss_rank = {
    atk:      Math.min(ATK_MAX, inheritedRanks.atk),
    atkTurns: 999,
    def:      Math.min(DEF_MAX, inheritedRanks.def),
    defTurns: 999,
    spd:      Math.min(SPD_MAX, inheritedRanks.spd),
    spdTurns: 999,
  }
}