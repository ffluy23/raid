// lib/bosses/beequeen.js
// 비퀸 보스 AI — 1페이즈(독침붕 소환/지령), 2페이즈(직접 공격)

const PLAYER_SLOTS = ["p1", "p2", "p3"]

// ── 로그 텍스트 풀 ────────────────────────────────────────────────
const LOGS = {
  // 1. 비퀸 등장
  bossIntro: [
    "비퀸은 조용히 전장을 지배하고 있다!",
  ],
  // 2. 독침붕 소환 (비퀸 로그)
  summon: [
    "비퀸은 호위 병력을 집결시키고 있다!",
  ],
  // 3. 공격지령 (비퀸 로그)
  attackCommand: [
    "비퀸은 공격 지령을 내리고 있다!",
    "비퀸은 적을 배제하라고 명령하고 있다!",
  ],
  // 4. 방어지령 (비퀸 로그)
  defendCommand: [
    "비퀸은 방어 태세를 유지하라고 지시하고 있다!",
    "비퀸은 전열을 정비하고 있다!",
  ],
  // 5. 회복지령 (비퀸 로그)
  healCommand: [
    "비퀸은 회복을 지시하고 있다!",
    "비퀸은 전력을 복구하려 하고 있다!",
  ],
  // 6-1. 독침붕 등장
  beedrillIntro: [
    "독침붕은 여왕을 위해 모습을 드러낸다!",
  ],
  // 6-2. 독침붕 대기 (매 턴)
  beedrillIdle: [
    "독침붕은 여왕의 곁을 지키고 있다!",
    "독침붕은 여왕의 명령을 기다리고 있다!",
  ],
  // 6-3. 공격지령 — 최저HP 타겟
  beedrillAttackNormal: [
    "독침붕은 여왕을 지키기 위해 분노하고 있다!",
  ],
  // 6-3. 공격지령 — 최고데미지 타겟
  beedrillAttackRevenge: [
    "독침붕은 여왕을 위협한 적에게 달려든다!",
    "독침붕은 여왕을 건드린 대가를 치르게 하려 한다!",
  ],
  // 6-4. 방어지령 (독침붕 로그)
  beedrillDefend: [
    "독침붕은 여왕을 위해 몸을 낮추고 있다!",
    "독침붕은 여왕을 지키기 위해 방어 태세에 들어간다!",
    "독침붕은 여왕을 향한 공격을 막아내려 한다!",
  ],
  // 6-5. 회복지령 (독침붕 로그)
  beedrillHeal: [
    "독침붕은 여왕의 명령에 따라 회복하고 있다!",
    "독침붕은 여왕을 위해 다시 일어서려 한다!",
    "독침붕은 여왕을 지키기 위해 힘을 되찾고 있다!",
  ],
  // 6-6. 회복 이후 생존 중 매 턴 (idle 대신 출력)
  beedrillAfterHeal: [
    "독침붕은 상처를 입었지만 여왕을 지키고 있다!",
    "독침붕은 흔들리면서도 여왕 곁을 떠나지 않는다!",
    "독침붕은 여왕을 위해 버티고 있다!",
  ],
  // 7. 독침붕 퇴장 (recharge 첫 턴)
  beedrillRetreat: [
    "독침붕은 여왕의 부름에 따라 물러난다!",
    "독침붕은 여왕을 남기고 사라진다…",
    "독침붕은 여왕의 명령으로 전장에서 이탈한다!",
  ],
  // 8. 독침
  sting: [
    "비퀸은 날카로운 독침을 쏘아내고 있다!",
    "비퀸은 적을 향해 독을 날리고 있다!",
  ],
  // 9. 시저크로스
  scissorCross: [
    "비퀸은 거칠게 휘둘러 모두를 베고 있다!",
    "비퀸은 광범위하게 공격하고 있다!",
  ],
  // 10. HP 40% 이하 최초 돌입 (1회성)
  enrageFirst: [
    "비퀸은 점점 흥분하고 있다!",
    "비퀸은 공격을 멈추지 않고 있다!",
  ],
  // 11. 달려들기
  charge: [
    "비퀸은 목표를 향해 거칠게 돌진하고 있다!",
    "비퀸은 제어를 잃은 채 공격하고 있다!",
  ],
  // 12. HP 20% 이하 매 턴
  rageLoop: [
    "비퀸은 완전히 제어를 잃고 있다!",
    "비퀸은 무차별적으로 공격하고 있다!",
    "비퀸은 끝까지 버티려 하고 있다!",
  ],
  // 13. 벌레의저항
  bugResist: [
    "비퀸은 광란 상태로 날뛰고 있다!",
    "비퀸은 주변을 가리지 않고 공격하고 있다!",
  ],
  // 14. 사망 (순차 출력 — 3개 전부)
  death: [
    "비퀸은 더 이상 형태를 유지하지 못하고 있다…",
    "비퀸은 힘이 완전히 고갈되고 있다…",
    "비퀸은 무너지고 있다…",
  ],
  // 15. 2페이즈 진입 (순차 출력 — 3개 전부)
  phase2Enter: [
    "비퀸은 직접 전투에 나서고 있다!",
    "비퀸은 더 이상 지휘하지 않는다!",
    "비퀸은 스스로 공격을 시작한다!",
  ],
  // 16. recharge 2턴차
  recharge2: [
    "여왕은 힘을 비축하고 있다!",
  ],
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ── getPhase ─────────────────────────────────────────────────────
export function getPhase(data) {
  const hp    = data.boss_current_hp ?? 0
  const maxHp = data.boss_max_hp     ?? 1
  if (hp / maxHp <= 0.6) return 2
  if ((data.boss_state?.beedrillKillCount ?? 0) >= 3) return 2
  return 1
}

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

function selectLowestHpTarget(data, entries, alive) {
  return alive.reduce((min, s) =>
    getActiveHp(data, entries, s) < getActiveHp(data, entries, min) ? s : min
  , alive[0])
}

function selectHighestDamageTarget(data, alive) {
  const dmgMap = data.boss_damage_taken ?? {}
  const maxDmg = alive.reduce((a, s) => Math.max(a, dmgMap[s] ?? 0), 0)
  if (maxDmg <= 0) return null
  const top = alive.filter(s => (dmgMap[s] ?? 0) === maxDmg)
  return top.length === 1 ? top[0] : null
}

export function getAliveBeedrills(data) {
  return (data.Beedrill ?? [])
    .map((b, i) => ({ ...b, _idx: i }))
    .filter(b => b.hp > 0)
}

function anyBeedrill(data, threshold) {
  return (data.Beedrill ?? []).some(b => b.hp > 0 && b.hp / (b.maxHp ?? b.hp) <= threshold)
}

export function selectAttackCommandTarget(data, entries) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return null
  const topDmg = selectHighestDamageTarget(data, alive)
  if (topDmg) return { slot: topDmg, priority: "revenge" }
  return { slot: selectLowestHpTarget(data, entries, alive), priority: "normal" }
}

// ── decideBossMove ────────────────────────────────────────────────
export function decideBossMove(data, entries, _PLAYER_SLOTS) {
  const phase     = getPhase(data)
  const bossState = data.boss_state ?? { step: "summon", beedrillKillCount: 0 }
  if (phase === 2) return decideBossMove_Phase2(data, entries, bossState)
  return decideBossMove_Phase1(data, entries, bossState)
}

function decideBossMove_Phase1(data, entries, bossState) {
  const step      = bossState.step ?? "summon"
  const aliveBees = getAliveBeedrills(data)

  // ── recharge (독침붕 전멸 후 휴식) ──────────────────────────────
  if (step === "recharge") {
    // 1턴차: 독침붕 퇴장 연출 + step을 recharge2로
    const nextState = { ...bossState, step: "recharge2" }
    return {
      moveName: null, targetSlot: null, command: "recharge", nextState,
      log: rand(LOGS.beedrillRetreat),
    }
  }

  if (step === "recharge2") {
    // 2턴차: 힘 비축 + step을 summon으로
    const nextState = { ...bossState, step: "summon" }
    return {
      moveName: null, targetSlot: null, command: "recharge", nextState,
      log: rand(LOGS.recharge2),
    }
  }

  // ── 소환 ─────────────────────────────────────────────────────────
  // step이 "summon"이거나, 살아있는 독침붕이 없는 경우
  if (step === "summon" || aliveBees.length === 0) {
    const nextState = { ...bossState, step: "attack" }
    return {
      moveName: null, targetSlot: null, command: "summon", nextState,
      log:         rand(LOGS.summon),
      beedrillLog: rand(LOGS.beedrillIntro),
    }
  }

  // ── 회복지령: 독침붕 중 한 마리라도 HP 30% 이하 ────────────────
  if (anyBeedrill(data, 0.3)) {
    // heal 후 50% 이상 회복됐는지는 raidBossAction에서 processHealCommand가 판단해
    // nextState.step은 raidBossAction이 anyAbove50 결과로 덮어쓰므로 여기선 임시값
    const nextState = { ...bossState, step: "attack" }
    return {
      moveName: null, targetSlot: null, command: "heal", nextState,
      log:         rand(LOGS.healCommand),
      beedrillLog: rand(LOGS.beedrillHeal),
    }
  }

  // ── 방어지령: 독침붕 중 한 마리라도 HP 50% 이하 ────────────────
  if (anyBeedrill(data, 0.5)) {
    const nextState = { ...bossState, step: "attack" }
    return {
      moveName: null, targetSlot: null, command: "defend", nextState,
      log:         rand(LOGS.defendCommand),
      beedrillLog: rand(LOGS.beedrillDefend),
    }
  }

  // ── 공격지령 ─────────────────────────────────────────────────────
  const target      = selectAttackCommandTarget(data, entries)
  const nextState   = { ...bossState, step: "attack" }
  const beedrillLog = target?.priority === "revenge"
    ? rand(LOGS.beedrillAttackRevenge)
    : rand(LOGS.beedrillAttackNormal)

  return {
    moveName:    "마구찌르기",
    targetSlot:  target?.slot ?? null,
    command:     "attack",
    priority:    target?.priority ?? "normal",
    nextState,
    log:         rand(LOGS.attackCommand),
    beedrillLog,
  }
}

function decideBossMove_Phase2(data, entries, bossState) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return { moveName: null, targetSlot: null, command: null, nextState: bossState }

  const hp      = data.boss_current_hp ?? 0
  const maxHp   = data.boss_max_hp     ?? 1
  const hpRatio = hp / maxHp

  // ── HP 20% 이하: 벌레의저항 or 시저크로스 랜덤 반복 ─────────────
  if (hpRatio <= 0.2) {
    const moveName  = Math.random() < 0.5 ? "벌레의저항" : "시저크로스"
    const moveLog   = moveName === "벌레의저항" ? rand(LOGS.bugResist) : rand(LOGS.scissorCross)
    const nextState = { ...bossState, enragedBelow40: true, enragedBelow20: true }
    return {
      moveName, targetSlot: null, command: "direct", nextState,
      log:     rand(LOGS.rageLoop),
      moveLog,
    }
  }

  // ── HP 40% 이하: 달려들기 후 독침 루프로 복귀 ───────────────────
  if (hpRatio <= 0.4) {
    const firstBelow40 = !bossState.enragedBelow40
    const target    = selectEnrageTarget(data, entries, alive)
    // 달려들기 후 다음 step은 sting1로 복귀
    const nextState = { ...bossState, phase2Step: "sting1", enragedBelow40: true }
    return {
      moveName: "달려들기", targetSlot: target, command: "direct", nextState,
      log:     firstBelow40 ? rand(LOGS.enrageFirst) : null,
      moveLog: rand(LOGS.charge),
    }
  }

  // ── 기본 사이클: 독침 → 독침 → 시저크로스 ──────────────────────
  const step = bossState.phase2Step ?? "sting1"
  let moveName, targetSlot, nextStep, moveLog

  if (step === "sting1") {
    moveName  = "독침"
    targetSlot = selectStingTarget(data, entries, alive)
    nextStep  = "sting2"
    moveLog   = rand(LOGS.sting)
  } else if (step === "sting2") {
    moveName  = "독침"
    targetSlot = selectStingTarget(data, entries, alive)
    nextStep  = "scissor"
    moveLog   = rand(LOGS.sting)
  } else {
    // scissor
    moveName  = "시저크로스"
    targetSlot = null
    nextStep  = "sting1"
    moveLog   = rand(LOGS.scissorCross)
  }

  return {
    moveName, targetSlot, command: "direct",
    nextState: { ...bossState, phase2Step: nextStep },
    moveLog,
  }
}

function selectStingTarget(data, entries, alive) {
  const lowestHp  = selectLowestHpTarget(data, entries, alive)
  const lowestVal = getActiveHp(data, entries, lowestHp)
  const tiedLow   = alive.filter(s => getActiveHp(data, entries, s) === lowestVal)
  if (tiedLow.length === 1) return tiedLow[0]
  const topDmg = selectHighestDamageTarget(data, tiedLow)
  if (topDmg) return topDmg
  return alive[Math.floor(Math.random() * alive.length)]
}

function selectEnrageTarget(data, entries, alive) {
  const topDmg = selectHighestDamageTarget(data, alive)
  if (topDmg) return topDmg
  return selectLowestHpTarget(data, entries, alive)
}

// ── 외부 유틸 export ──────────────────────────────────────────────

/**
 * [FIX] 원래 getBossIntroLog (단수, 문자열 리턴)였는데
 * raidBossAction.js가 getBossIntroLogs (복수, 배열) for...of 순회를 기대하므로
 * 배열로 리턴하도록 수정
 */
export function getBossIntroLogs() {
  return [...LOGS.bossIntro]
}

export function getBeedrillIdleLog(data) {
  const healedAlive = (data.Beedrill ?? []).some(b => b.hp > 0 && b.wasHealed)
  return healedAlive ? rand(LOGS.beedrillAfterHeal) : rand(LOGS.beedrillIdle)
}

export function getDeathLogs() {
  return [...LOGS.death]
}

/** 2페이즈 진입 순차 로그 (3개) */
export function getPhase2EnterLogs() {
  return [...LOGS.phase2Enter]
}

/**
 * 2페이즈 진입 체크 훅
 * [FIX] command === "direct" 일 때도 체크 제외하지 않음
 * (기존 코드는 direct면 null 리턴해서 진입 연출이 찍히지 않았음)
 * 대신 phase2Step이 이미 있으면 이미 진입한 것이므로 스킵
 */
export function checkPhase2Enter(data, nextState, command) {
  // recharge 중에는 페이즈 진입 연출 하지 않음
  if (command === "recharge") return null
  // 이미 phase2Step이 세팅돼 있으면 진입 완료된 상태
  if (nextState.phase2Step != null) return null

  const hpRatio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
  const killCount = data.boss_state?.beedrillKillCount ?? 0

  // HP 60% 이하 OR killCount 3 이상일 때 진입
  if (hpRatio > 0.6 && killCount < 3) return null

  return {
    logs:           getPhase2EnterLogs(),
    nextState:      { ...nextState, phase2Step: "sting1" },
    clearBeedrills: true,
  }
}

export function shouldTriggerUlt(_data) { return false }
export function getUltTarget(_data, _entries) { return null }
export function nextUltCooldown() { return 0 }