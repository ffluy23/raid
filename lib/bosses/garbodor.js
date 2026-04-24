// lib/bosses/garbodor.js
// 더스트나 보스 AI

// ════════════════════════════════════════════════════════════════════
//  상수
// ════════════════════════════════════════════════════════════════════
const CORRUPTION_THRESHOLD = 500   // [부식] 해제에 필요한 누적 딜

// ════════════════════════════════════════════════════════════════════
//  딜체크 로그 헬퍼 (raidBossAction.js 에서도 import)
// ════════════════════════════════════════════════════════════════════
export function getDealCheckLog(ratio) {
  if (ratio >= 1.0)  return "지금이다! 오염을 억제해!"
  if (ratio >= 0.9)  return "곧 폭발한다...!"
  if (ratio >= 0.6)  return "오염이 한계에 가까워지고 있다!"
  if (ratio >= 0.3)  return "부식이 가속되고 있다!\n체내 오염 농도가 빠르게 상승한다...!"
  return Math.random() < 0.5
    ? "오염이 점점 축적되고 있다..."
    : "부식이 서서히 진행 중이다..."
}

// ════════════════════════════════════════════════════════════════════
//  보스 등장 / 사망 로그
// ════════════════════════════════════════════════════════════════════
export function getBossIntroLogs() {
  return ["더스트나는 썩은 독기를 퍼뜨리며 대기를 오염시킨다!"]
}

export function getDeathLogs() {
  return ["더스트나의 오염이 흩어졌다..."]
}

// ════════════════════════════════════════════════════════════════════
//  ult — 더스트나는 패턴 내에서 부패폭발을 직접 처리하므로
//        shouldTriggerUlt 는 항상 false
// ════════════════════════════════════════════════════════════════════
export function shouldTriggerUlt(_data) { return false }
export function getUltTarget(_data, _entries, _slots) { return null }
export function nextUltCooldown() { return 0 }

// ════════════════════════════════════════════════════════════════════
//  1페이즈 패턴 결정
//
//  step 1: 독가스 (플레이어 1명 랜덤 → [부식] 부여)
//  step 2: 오물웨이브 (광역)
//  step 3: 행동 없음 (부식 경고 로그)
//  step 4: 부패폭발 (부식 폭발 or 해제 판정)
//  step 5: HP회복
//  → step 1 로 반복
// ════════════════════════════════════════════════════════════════════
export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const state    = data.boss_state ?? {}
  const step     = state.step ?? 1
  const bossName = data.boss_name ?? "더스트나"

  const corruptedSlot = state.corruptedSlot ?? null

  const alive = PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0
  })

  // ── step 1: 독가스 ───────────────────────────────────────────────
  if (step === 1) {
    // 부식 대상이 아직 살아있으면 재사용, 아니면 랜덤 선택
    const targetSlot =
      (corruptedSlot && alive.includes(corruptedSlot))
        ? corruptedSlot
        : (alive[Math.floor(Math.random() * alive.length)] ?? null)

    return {
      command:    "direct",
      moveName:   "독가스",
      targetSlot,
      commandLog: null,
      // nextState: 부식 대상 등록, 딜체크 초기화
      nextState: {
        ...state,
        step:           2,
        corruptedSlot:  targetSlot,
        dealCheckDmg:   0,
      },
    }
  }

  // ── step 2: 오물웨이브 ───────────────────────────────────────────
  if (step === 2) {
    return {
      command:    "direct",
      moveName:   "오물웨이브",
      targetSlot: alive[0] ?? null,
      commandLog: null,
      moveLog:    "몸속에 오염이 축적되기 시작한다...",
      nextState:  { ...state, step: 3 },
    }
  }

  // ── step 3: 행동 없음 ────────────────────────────────────────────
  if (step === 3) {
    const tIdx  = corruptedSlot ? (data[`${corruptedSlot}_active_idx`] ?? 0) : 0
    const tPkmn = corruptedSlot ? entries[corruptedSlot]?.[tIdx] : null
    const tName = tPkmn?.name ?? "????"

    const dmgSoFar = state.dealCheckDmg ?? 0
    const dealLog  = getDealCheckLog(dmgSoFar / CORRUPTION_THRESHOLD)

    return {
      command:    "idle",
      moveName:   null,
      targetSlot: null,
      commandLog: `${tName}의 부식이 점점 심해지고 있다...!`,
      moveLog:    dealLog,
      nextState:  { ...state, step: 4 },
    }
  }

  // ── step 4: 부패폭발 ─────────────────────────────────────────────
  if (step === 4) {
    return {
      command:    "corruption_blast",
      moveName:   "부패폭발",
      targetSlot: corruptedSlot,
      commandLog: "더스트나는 축적된 오염을 폭발시켰다!",
      nextState:  { ...state, step: 5, corruptedSlot: null, dealCheckDmg: 0 },
    }
  }

  // ── step 5: HP회복 ───────────────────────────────────────────────
  if (step === 5) {
    return {
      command:    "direct",
      moveName:   "HP회복",
      targetSlot: null,
      commandLog: "더스트나는 주변의 오염을 흡수했다!",
      nextState:  { ...state, step: 1, corruptedSlot: null },
    }
  }

  // fallback
  return {
    command:    "direct",
    moveName:   "오물웨이브",
    targetSlot: alive[0] ?? null,
    commandLog: null,
    nextState:  { ...state, step: 1 },
  }
}