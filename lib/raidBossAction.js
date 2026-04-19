// lib/raidBossAction.js
// 보스 턴 처리 공통 로직

import { db } from "./firestore.js"
import { bossMoves } from "./bossMoves.js"
import { moves } from "./moves.js"
import { getTypeMultiplier } from "./typeChart.js"
import { josa } from "./effecthandler.js"
import { rollD10 } from "./gameUtils.js"
import { getBossAI } from "./bossRegistry.js"
import { activateUmbreon } from "./umbreon.js"

export const PLAYER_SLOTS = ["p1", "p2", "p3"]

export function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

export async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  logEntries.forEach((entry, i) => batch.set(logsRef.doc(), { ...entry, ts: base + i }))
  await batch.commit()
}

export function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

export function getActiveRankVal(ranks, key) {
  return (ranks?.[`${key}Turns`] ?? 0) > 0 ? (ranks?.[key] ?? 0) : 0
}

export function deepCopyEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

export function buildEntryUpdate(entries) {
  const update = {}
  PLAYER_SLOTS.forEach(s => { update[`${s}_entry`] = entries[s] })
  return update
}

export function getAlivePlayers(data, entries) {
  return PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0
  })
}

export function checkRaidWin(entries, bossHp) {
  if (bossHp <= 0) return "victory"
  const allDead = PLAYER_SLOTS.every(s => (entries[s] ?? []).every(p => p.hp <= 0))
  if (allDead) return "defeat"
  return null
}

function getBossAtk(data) {
  const base = data.boss_attack ?? 5
  const rank = getActiveRankVal(data.boss_rank, "atk")
  return base + rank
}

function calcBossDamage(data, moveName, targetPkmn, diceOverride = null) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  if (!moveInfo) return { damage: 0, multiplier: 1, critical: false, dice: 0 }

  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(targetPkmn.type) ? targetPkmn.type : [targetPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, critical: false, dice }

  const bossAtk  = getBossAtk(data)
  const defStat  = targetPkmn.defense ?? 3
  const defRank  = getActiveRankVal(targetPkmn.ranks, "def")
  const power    = moveInfo.power ?? 40
  const base     = power + bossAtk * 4 + dice
  const raw      = Math.floor(base * mult)
  const afterDef = Math.max(1, raw - defStat * 3 - defRank * 3)
  const critRate = Math.min(100, bossAtk * 2)
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(afterDef * 1.5) : afterDef, multiplier: mult, critical, dice }
}

function calcBeedrilDamage(data, beedrill, moveName, targetPkmn, diceOverride = null) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  if (!moveInfo) return { damage: 0, multiplier: 1, critical: false, dice: 0 }

  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(targetPkmn.type) ? targetPkmn.type : [targetPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, critical: false, dice }

  const beeAtk   = (beedrill.attack ?? 3) + getActiveRankVal(beedrill.ranks, "atk")
  const defStat  = targetPkmn.defense ?? 3
  const defRank  = getActiveRankVal(targetPkmn.ranks, "def")
  const power    = moveInfo.power ?? 40
  const base     = power + beeAtk * 4 + dice
  const raw      = Math.floor(base * mult)
  const afterDef = Math.max(1, raw - defStat * 3 - defRank * 3)
  const critRate = Math.min(100, beeAtk * 2)
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(afterDef * 1.5) : afterDef, multiplier: mult, critical, dice }
}

function applySyncDistribution(rawDamage, targetSlot, data, entries, logEntries, isAoe = false) {
  if (!data.sync_active) return { damages: { [targetSlot]: rawDamage }, clearSync: false }

  const alivePlayers = getAlivePlayers(data, entries)
  if (alivePlayers.length <= 1) return { damages: { [targetSlot]: rawDamage }, clearSync: true }

  const damages = {}
  if (isAoe) {
    const reduced = Math.max(1, Math.floor(rawDamage * 0.75))
    alivePlayers.forEach(s => { damages[s] = reduced })
    logEntries.push(makeLog("sync", ""))
    logEntries.push(makeLog("after_hit",
      `💠 싱크로나이즈! 광역 공격을 ${alivePlayers.length}명이 함께 버텼다! (×0.75)`
    ))
  } else {
    const share = Math.max(1, Math.floor(rawDamage / alivePlayers.length))
    alivePlayers.forEach(s => { damages[s] = share })
    logEntries.push(makeLog("sync", ""))
    logEntries.push(makeLog("after_hit",
      `💠 싱크로나이즈! ${alivePlayers.length}명이 데미지를 균등 분산! (각 ${share})`
    ))
  }
  data.sync_used = true
  return { damages, clearSync: true }
}

function applyDamagesToPlayers(damages, entries, data, logEntries) {
  for (const [slot, dmg] of Object.entries(damages)) {
    if (dmg <= 0) continue
    const idx  = data[`${slot}_active_idx`] ?? 0
    const pkmn = entries[slot]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue
    if (pkmn.enduring && dmg >= pkmn.hp) {
      pkmn.hp = 1; pkmn.enduring = false
      logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
    } else {
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
    }
    pkmn.defending = false; pkmn.defendTurns = 0
    logEntries.push(makeLog("hit", "", { defender: slot }))
    logEntries.push(makeLog("hp",  "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
    if (pkmn.bideState) {
      pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + dmg
      pkmn.bideState.lastAttackerSlot = "boss"
    }
  }
}

// ── 날따름: 단일기 타겟 redirect ─────────────────────────────────────
// 살아있는 플레이어 중 tauntSelfTurns > 0 인 슬롯 반환
// 복수면 랜덤 (엣지케이스)
function getTauntSelfTarget(data, entries) {
  const taunters = PLAYER_SLOTS.filter(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    return pkmn && pkmn.hp > 0 && (pkmn.tauntSelfTurns ?? 0) > 0
  })
  if (taunters.length === 0) return null
  return taunters[Math.floor(Math.random() * taunters.length)]
}

// redirect 발생 시 로그 출력 헬퍼
function logTauntRedirect(tauntTarget, originalTarget, data, entries, logEntries) {
  if (!tauntTarget || tauntTarget === originalTarget) return
  const pkmn = entries[tauntTarget]?.[data[`${tauntTarget}_active_idx`] ?? 0]
  const name = pkmn?.name ?? "포켓몬"
  logEntries.push(makeLog("normal", `${name}에게 시선이 집중되었다!`))
}

function processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  const dice     = rollD10()
  logEntries.push(makeLog("move_announce", `${bossName}${josa(bossName, "의")} ${moveName}!`))

  if (isAoe) {
    const alive = getAlivePlayers(data, entries)
    if (alive.length === 0) { logEntries.push(makeLog("normal", "공격할 대상이 없다!")); return }
    for (const slot of alive) {
      const idx  = data[`${slot}_active_idx`] ?? 0
      const pkmn = entries[slot]?.[idx]
      if (!pkmn || pkmn.hp <= 0) continue
      const { damage, multiplier, critical } = calcBossDamage(data, moveName, pkmn, dice)
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); continue }
      logEntries.push(makeLog("hit", "", { defender: slot }))
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      const aoeDamages = { [slot]: damage }
      activateUmbreon(aoeDamages, data, entries, logEntries)
      const finalDmg = aoeDamages[slot] ?? damage
      if (finalDmg > 0) {
        if (pkmn.enduring && finalDmg >= pkmn.hp) {
          pkmn.hp = 1; pkmn.enduring = false
          logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
        } else {
          pkmn.hp = Math.max(0, pkmn.hp - finalDmg)
        }
        pkmn.defending = false; pkmn.defendTurns = 0
        logEntries.push(makeLog("hp", "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
        if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
        if (pkmn.bideState) { pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + finalDmg; pkmn.bideState.lastAttackerSlot = "boss" }
      }
    }
  } else {
    // ── 단일기: 날따름 redirect ──────────────────────────────────
    const tauntTarget = getTauntSelfTarget(data, entries)
    const realTarget  = tauntTarget ?? targetSlot
    logTauntRedirect(tauntTarget, targetSlot, data, entries, logEntries)

    if (!realTarget) { logEntries.push(makeLog("normal", "공격할 대상이 없다!")); return }
    const idx  = data[`${realTarget}_active_idx`] ?? 0
    const pkmn = entries[realTarget]?.[idx]
    if (!pkmn || pkmn.hp <= 0) { logEntries.push(makeLog("normal", "공격할 대상이 이미 쓰러졌다!")); return }

    const { damage, multiplier, critical } = calcBossDamage(data, moveName, pkmn, dice)
    logEntries.push(makeLog("dice", "", { slot: "boss", roll: dice }))
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); return }

    if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))

  const { damages, clearSync } = applySyncDistribution(damage, realTarget, data, entries, logEntries)
    if (clearSync) data.sync_active = false

    activateUmbreon(damages, data, entries, logEntries)
    applyDamagesToPlayers(damages, entries, data, logEntries)

    if (moveInfo?.rank?.targetDef !== undefined) {
      const pkmn2 = entries[realTarget]?.[data[`${realTarget}_active_idx`] ?? 0]
      if (pkmn2 && pkmn2.hp > 0) {
        const chance = moveInfo.rank.chance ?? 1
        if (Math.random() < chance) {
          const r    = pkmn2.ranks ?? defaultRanks()
          const cur  = r.def ?? 0
          const next = Math.max(-3, cur + moveInfo.rank.targetDef)
          pkmn2.ranks = { ...r, def: next, defTurns: next !== cur ? (moveInfo.rank.turns ?? 2) : r.defTurns }
          if (next < cur) logEntries.push(makeLog("normal", `${pkmn2.name}${josa(pkmn2.name, "의")} 방어 랭크가 내려갔다!`))
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
//  비퀸 전용 — 독침붕 지령 처리
// ════════════════════════════════════════════════════════════════════

async function fetchBeedrilStats(roomId) {
  const snap = await db.collection("boss").doc("beequeen").get()
  const base = snap.data()?.Beedrill ?? {}
  return {
    attack:   base.attack   ?? 3,
    defense:  base.defense  ?? 3,
    speed:    base.speed    ?? 3,
    hp:       base.hp       ?? 60,
    maxHp:    base.hp       ?? 60,
    moves:    base.moves    ?? [],
    type:     base.type     ?? ["벌레", "독"],
    portrait: base.portrait ?? null,
    name:     base.name     ?? "독침붕",
    ranks:    defaultRanks(),
    wasHealed: false,
  }
}

async function processSummon(roomId, data, logEntries, beedrillLog) {
  const stats     = await fetchBeedrilStats(roomId)
  const beedrill1 = { ...JSON.parse(JSON.stringify(stats)), _idx: 0 }
  const beedrill2 = { ...JSON.parse(JSON.stringify(stats)), _idx: 1 }
  data.Beedrill   = [beedrill1, beedrill2]
  logEntries.push(makeLog("beedrill_summon", "", { beedrills: data.Beedrill }))
  if (beedrillLog) logEntries.push(makeLog("normal", beedrillLog))
}

const MAGU_NAME = "마구찌르기"

function processAttackCommand(data, entries, targetSlot, beedrillLog, logEntries) {
  const beedrills = data.Beedrill ?? []
  const aliveBees = beedrills.filter(b => b.hp > 0)
  if (aliveBees.length === 0) { logEntries.push(makeLog("normal", "독침붕이 없다!")); return }

  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) { logEntries.push(makeLog("normal", "공격할 대상이 없다!")); return }

  // 마구찌르기도 단일기 — 날따름 redirect 체크
  const tauntTarget = getTauntSelfTarget(data, entries)
  const realTarget  = tauntTarget && alive.includes(tauntTarget)
    ? tauntTarget
    : (targetSlot && alive.includes(targetSlot) ? targetSlot : alive[Math.floor(Math.random() * alive.length)])
  logTauntRedirect(tauntTarget, targetSlot, data, entries, logEntries)

  const maguInfo = bossMoves[MAGU_NAME]
  if (!maguInfo?.multiHit) { logEntries.push(makeLog("normal", "마구찌르기 정보가 없다!")); return }

  const { min, max, fixedDamage } = maguInfo.multiHit
  const accuracy = maguInfo.accuracy ?? 85

  for (const bee of aliveBees) {
    const idx  = data[`${realTarget}_active_idx`] ?? 0
    const pkmn = entries[realTarget]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue

    logEntries.push(makeLog("move_announce", `독침붕${josa("독침붕", "의")} ${MAGU_NAME}!`))
    if (beedrillLog) logEntries.push(makeLog("normal", beedrillLog))

    if (Math.random() * 100 >= accuracy) {
      logEntries.push(makeLog("normal", "독침붕의 공격은 빗나갔다!"))
      continue
    }

    const hitCount = Math.floor(Math.random() * (max - min + 1)) + min
    let totalDmg   = 0
    const defTypes = Array.isArray(pkmn.type) ? pkmn.type : [pkmn.type]
    let mult = 1
    for (const dt of defTypes) mult *= getTypeMultiplier(maguInfo.type, dt)

    if (mult === 0) {
      logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`))
    } else {
      const dmgPerHit = Math.max(1, Math.floor(fixedDamage * mult))
      for (let h = 0; h < hitCount; h++) {
        if (pkmn.hp <= 0) break
        if (pkmn.enduring && dmgPerHit >= pkmn.hp) {
          pkmn.hp = 1; pkmn.enduring = false
          logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
        } else {
          pkmn.hp = Math.max(0, pkmn.hp - dmgPerHit)
        }
        totalDmg += dmgPerHit
        logEntries.push(makeLog("hit", "", { defender: realTarget }))
        logEntries.push(makeLog("hp",  "", { slot: realTarget, hp: pkmn.hp, maxHp: pkmn.maxHp }))
        if (pkmn.hp <= 0) {
          logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: realTarget }))
          break
        }
      }
      if (pkmn.hp > 0 || totalDmg > 0)
        logEntries.push(makeLog("after_hit", `${hitCount}번 공격했다! (총 ${totalDmg} 데미지)`))
      if (mult > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (mult < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))

      if (pkmn.bideState) {
        pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + totalDmg
        pkmn.bideState.lastAttackerSlot = "boss"
      }
    }
  }
}

function processDefendCommand(data, logEntries, beedrillLog) {
  const beedrills = data.Beedrill ?? []
  const DEF_BOOST = 2
  const DEF_MAX   = 3
  const DEF_TURNS = 2
  let applied = false
  for (const bee of beedrills) {
    if (bee.hp <= 0) continue
    const r   = bee.ranks ?? defaultRanks()
    const cur = r.def ?? 0
    if (cur >= DEF_MAX) {
      logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "의")} 방어 랭크는 이미 최대다!`))
    } else {
      const next = Math.min(DEF_MAX, cur + DEF_BOOST)
      bee.ranks  = { ...r, def: next, defTurns: DEF_TURNS }
      logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "의")} 방어 랭크가 ${next - cur} 올라갔다! (+${next})`))
      applied = true
    }
  }
  if (applied && beedrillLog) logEntries.push(makeLog("normal", beedrillLog))
}

function processHealCommand(data, logEntries, beedrillLog) {
  const beedrills  = data.Beedrill ?? []
  const HEAL_RATIO = 0.22
  let anyAbove50   = false
  for (const bee of beedrills) {
    if (bee.hp <= 0) continue
    const heal = Math.max(1, Math.floor((bee.maxHp ?? bee.hp) * HEAL_RATIO))
    bee.hp        = Math.min(bee.maxHp ?? bee.hp, bee.hp + heal)
    bee.wasHealed = true
    logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "은는")} 체력을 회복했다! (+${heal})`))
    logEntries.push(makeLog("beedrill_hp", "", { beedrills: data.Beedrill }))
    if (bee.hp / (bee.maxHp ?? 1) >= 0.5) anyAbove50 = true
  }
  if (beedrillLog) logEntries.push(makeLog("normal", beedrillLog))
  return anyAbove50
}

function checkBeedrilDeath(data, nextState) {
  const beedrills = data.Beedrill ?? []
  const allDead   = beedrills.length > 0 && beedrills.every(b => b.hp <= 0)
  if (!allDead) return { allDead: false, nextState }

  const newKillCount = (data.boss_state?.beedrillKillCount ?? 0) + 1
  return {
    allDead: true,
    nextState: {
      ...nextState,
      step: "recharge",
      beedrillKillCount: newKillCount,
    },
  }
}

// ════════════════════════════════════════════════════════════════════
//  핵심 export: 보스 행동 실행 후 Firestore 업데이트
// ════════════════════════════════════════════════════════════════════
export async function executeBossAction(roomId, data, entries, currentOrder, extraUpdate = {}) {
  const bossName   = data.boss_name ?? "보스"
  const logEntries = []

  let bossAI
  try { bossAI = getBossAI(bossName) }
  catch (e) { throw new Error(`보스 AI 없음: ${bossName}`) }

  const {
    decideBossMove,
    shouldTriggerUlt, getUltTarget, nextUltCooldown,
    getBeedrillIdleLog, getDeathLogs,
    getBossIntroLogs,
    getUltWindupLog, getUltStrikeLog,
  } = bossAI

  // ── 보스 등장 로그 (첫 턴만) ────────────────────────────────────
  if ((data.turn_count ?? 1) === 1 && getBossIntroLogs) {
    for (const text of getBossIntroLogs()) {
      logEntries.push(makeLog("normal", text))
    }
  }

  // ── 기습 ult 체크 ───────────────────────────────────────────────
  let bossUltCooldownNext = data.boss_ult_cooldown ?? 0
  if (shouldTriggerUlt(data)) {
    const ultTarget = getUltTarget(data, entries, PLAYER_SLOTS)
    if (ultTarget) {
      if (getUltWindupLog) logEntries.push(makeLog("normal", getUltWindupLog()))
      if (getUltStrikeLog) logEntries.push(makeLog("normal", getUltStrikeLog()))
      processBossAttack("기습", ultTarget, false, data, entries, logEntries, bossName)
      bossUltCooldownNext = nextUltCooldown()
    }
  }

  // ── 독침붕 대기 로그 ────────────────────────────────────────────
  const hasBeedrills = (data.Beedrill ?? []).some(b => b.hp > 0)
  if (hasBeedrills && getBeedrillIdleLog) {
    logEntries.push(makeLog("normal", getBeedrillIdleLog(data)))
  }

  // ── 보스 행동 결정 ──────────────────────────────────────────────
  const decision = decideBossMove(data, entries, PLAYER_SLOTS)
  const {
    command,
    log:         commandLog,
    beedrillLog: beedrillActionLog,
    moveLog,
    nextState:   rawNextState,
  } = decision
  let { moveName, targetSlot } = decision
  let nextState = rawNextState ?? data.boss_state ?? {}

  // ── 마비/얼음 상태이상 체크 ─────────────────────────────────────
  const isStatusBlocked =
    (command === "direct") &&
    ((data.boss_status === "마비" && Math.random() < 0.25) ||
     (data.boss_status === "얼음" && Math.random() < 0.2))

  if (isStatusBlocked) {
    if (data.boss_status === "마비")
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 마비로 움직일 수 없다!`))
    if (data.boss_status === "얼음") {
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼어붙어 있다!`))
      if (Math.random() < 0.2) {
        logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼음이 녹았다!`))
        data.boss_status = null
      }
    }

  } else if (command === "summon") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    await processSummon(roomId, data, logEntries, beedrillActionLog)

  } else if (command === "recharge") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))

  } else if (command === "attack") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    processAttackCommand(data, entries, targetSlot, beedrillActionLog, logEntries)

  } else if (command === "defend") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    processDefendCommand(data, logEntries, beedrillActionLog)

  } else if (command === "heal") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    const anyAbove50 = processHealCommand(data, logEntries, beedrillActionLog)
    nextState = { ...nextState, step: anyAbove50 ? "defend" : "attack" }

  } else if (command === "direct") {
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    if (moveLog)    logEntries.push(makeLog("normal", moveLog))
    const moveInfo = bossMoves[moveName] ?? moves[moveName]
    const isAoe    = !!(moveInfo?.aoe)
    processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)

  } else if (moveName) {
    if (moveLog) logEntries.push(makeLog("normal", moveLog))
    const moveInfo = bossMoves[moveName] ?? moves[moveName]
    const isAoe    = !!(moveInfo?.aoe)
    processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)
  }

  // ── 독침붕 전멸 체크 ────────────────────────────────────────────
  if (command !== "direct" && command !== "recharge" && command !== "summon") {
    const deathCheck = checkBeedrilDeath(data, nextState)
    if (deathCheck.allDead) {
      nextState = deathCheck.nextState
      const killCount = nextState.beedrillKillCount ?? 0
      if (killCount < 3) {
        logEntries.push(makeLog("normal", "독침붕이 모두 쓰러졌다! 여왕은 힘을 비축하고 있다!"))
      } else {
        logEntries.push(makeLog("normal", "독침붕이 모두 쓰러졌다! 비퀸이 직접 나선다!"))
      }
      data.Beedrill = []
    }
  }

  // ── 2페이즈 진입 체크 (플러그인 훅) ───────────────────────────
  if (bossAI.checkPhase2Enter) {
    const p2 = bossAI.checkPhase2Enter(data, nextState, command)
    if (p2) {
      for (const text of (p2.logs ?? [])) logEntries.push(makeLog("normal", text))
      nextState  = p2.nextState
      if (p2.clearBeedrills) data.Beedrill = []
    }
  }

  // ── 보스 사망 처리 ───────────────────────────────────────────────
  const bossJustDied = (data.boss_current_hp ?? 0) <= 0
  if (bossJustDied && getDeathLogs) {
    for (const text of getDeathLogs()) {
      logEntries.push(makeLog("normal", text))
    }
  }

  // ── 보스 독/화상 EOT ────────────────────────────────────────────
  if (!bossJustDied && (data.boss_status === "독" || data.boss_status === "화상")) {
    const dmg = Math.max(1, Math.floor((data.boss_max_hp ?? 1) / 16))
    data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
    const label = data.boss_status === "독" ? "독" : "화상"
    logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} ${label} 데미지로 ${dmg} HP를 잃었다!`))
    logEntries.push(makeLog("hp", "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
  }

  // ── 승패 판정 ───────────────────────────────────────────────────
  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)

  // ── 로그 작성 ───────────────────────────────────────────────────
  await writeLogs(roomId, logEntries)

  const newOrder = currentOrder.slice(1)

  const update = {
    ...buildEntryUpdate(entries),
    boss_current_hp:   data.boss_current_hp ?? 0,
    boss_status:       data.boss_status     ?? null,
    boss_rank:         data.boss_rank       ?? defaultRanks(),
    boss_volatile:     data.boss_volatile   ?? {},
    boss_state:        nextState,
    boss_last_move:    moveName ?? null,
    boss_ult_cooldown: bossUltCooldownNext,
    Beedrill:          data.Beedrill        ?? [],
    sync_active:       data.sync_active     ?? false,
    sync_used:         data.sync_used       ?? false,
    umbreon_used:      data.umbreon_used    ?? false,
    current_order:     newOrder,
    turn_count:        (data.turn_count ?? 1) + 1,
    turn_started_at:   newOrder.length > 0 ? Date.now() : null,
    ...extraUpdate,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  PLAYER_SLOTS.forEach(s => {
    const idx        = data[`${s}_active_idx`] ?? 0
    const pkmn       = entries[s]?.[idx]
    const benchAlive = (entries[s] ?? []).some((p, i) => i !== idx && p.hp > 0)
    if (pkmn && pkmn.hp <= 0 && benchAlive && !result) {
      update[`force_switch_${s}`] = true
    }
  })

  if (result) {
    update.game_over       = true
    update.raid_result     = result
    update.current_order   = []
    update.turn_started_at = null
  }

  await db.collection("raid").doc(roomId).update(update)
  return result
}