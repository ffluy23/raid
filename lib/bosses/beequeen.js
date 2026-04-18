// lib/bosses/beequeen.js
// 비퀸 보스 AI — 1페이즈(독침붕 소환/지령), 2페이즈(직접 공격)

const PLAYER_SLOTS = ["p1", "p2", "p3"]

export function getPhase(data) {
  const hp    = data.boss_current_hp ?? 0
  const maxHp = data.hp              ?? 1
  if (hp / maxHp <= 0.6) return 2
  if ((data.boss_state?.beedrillKillCount ?? 0) >= 6) return 2
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

export function decideBossMove(data, entries, PLAYER_SLOTS) {
  const phase     = getPhase(data)
  const bossState = data.boss_state ?? { step: "summon", beedrillKillCount: 0 }
  if (phase === 2) return decideBossMove_Phase2(data, entries, bossState)
  return decideBossMove_Phase1(data, entries, bossState)
}

function decideBossMove_Phase1(data, entries, bossState) {
  const step      = bossState.step ?? "summon"
  const aliveBees = getAliveBeedrills(data)

  if (step === "recharge" || step === "recharge2") {
    const nextStep  = step === "recharge" ? "recharge2" : "summon"
    const nextState = { ...bossState, step: nextStep }
    return { moveName: null, targetSlot: null, command: "recharge", nextState, log: "여왕은 힘을 비축하고 있다!" }
  }

  if (step === "summon" || aliveBees.length === 0) {
    const nextState = { ...bossState, step: "attack" }
    return { moveName: null, targetSlot: null, command: "summon", nextState, log: "비퀸이 독침붕을 두 마리 소환했다!" }
  }

  if (anyBeedrill(data, 0.3)) {
    const nextState = { ...bossState, step: "attack" }
    return { moveName: null, targetSlot: null, command: "heal", nextState, log: "비퀸이 회복지령을 내렸다!" }
  }

  if (anyBeedrill(data, 0.5)) {
    const nextState = { ...bossState, step: "attack" }
    return { moveName: null, targetSlot: null, command: "defend", nextState, log: "비퀸이 방어지령을 내렸다!" }
  }

  const target    = selectAttackCommandTarget(data, entries)
  const nextState = { ...bossState, step: "attack" }
  return {
    moveName:   "마구찌르기",
    targetSlot: target?.slot ?? null,
    command:    "attack",
    priority:   target?.priority ?? "normal",
    nextState,
    log: target?.priority === "revenge" ? "독침붕은 여왕을 지킨다!" : null,
  }
}

function decideBossMove_Phase2(data, entries, bossState) {
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) return { moveName: null, targetSlot: null, command: null, nextState: bossState }

  const hp      = data.boss_current_hp ?? 0
  const maxHp   = data.hp              ?? 1
  const hpRatio = hp / maxHp

  if (hpRatio <= 0.2) {
    const moveName  = Math.random() < 0.5 ? "벌레의저항" : "시저크로스"
    const nextState = { ...bossState, phase2Step: "resist" }
    return { moveName, targetSlot: null, command: "direct", nextState }
  }

  if (hpRatio <= 0.4) {
    const step = bossState.phase2Step ?? "sting1"
    if (step === "sting1" || step === "enrage") {
      const target    = selectEnrageTarget(data, entries, alive)
      const nextState = { ...bossState, phase2Step: "sting1" }
      return { moveName: "달려들기", targetSlot: target, command: "direct", nextState, log: "비퀸이 달려들었다!" }
    }
  }

  const step = bossState.phase2Step ?? "sting1"
  let moveName, targetSlot, nextStep

  if (step === "sting1") {
    moveName = "독침"; targetSlot = selectStingTarget(data, entries, alive); nextStep = "sting2"
  } else if (step === "sting2") {
    moveName = "독침"; targetSlot = selectStingTarget(data, entries, alive); nextStep = "scissor"
  } else {
    moveName = "시저크로스"; targetSlot = null; nextStep = "sting1"
  }

  return { moveName, targetSlot, command: "direct", nextState: { ...bossState, phase2Step: nextStep } }
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

export function shouldTriggerUlt(_data) { return false }
export function getUltTarget(_data, _entries) { return null }
export function nextUltCooldown() { return 0 }