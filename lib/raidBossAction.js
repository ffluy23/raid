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

// ── 독침붕 데미지 계산 (보스 공격력 기준) ───────────────────────────
// 독침붕은 별도 스탯을 갖지만 다이스는 보스 기준으로 계산
function calcBeedrilDamage(data, beedrill, moveName, targetPkmn, diceOverride = null) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  if (!moveInfo) return { damage: 0, multiplier: 1, critical: false, dice: 0 }

  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(targetPkmn.type) ? targetPkmn.type : [targetPkmn.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(moveInfo.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, critical: false, dice }

  // 독침붕 공격력 + 랭크 반영, 다이스는 보스 기준
  const beeAtk  = (beedrill.attack ?? 3) + getActiveRankVal(beedrill.ranks, "atk")
  const defStat = targetPkmn.defense ?? 3
  const defRank = getActiveRankVal(targetPkmn.ranks, "def")
  const power   = moveInfo.power ?? 40
  const base    = power + beeAtk * 4 + dice
  const raw     = Math.floor(base * mult)
  const afterDef = Math.max(1, raw - defStat * 3 - defRank * 3)
  const critRate = Math.min(100, beeAtk * 2)
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(afterDef * 1.5) : afterDef, multiplier: mult, critical, dice }
}

function applySyncDistribution(rawDamage, targetSlot, data, entries, logEntries) {
  if (!data.sync_active) return { damages: { [targetSlot]: rawDamage }, clearSync: false }

  const alivePlayers = getAlivePlayers(data, entries)
  if (alivePlayers.length <= 1) return { damages: { [targetSlot]: rawDamage }, clearSync: true }

  const share   = Math.max(1, Math.floor(rawDamage / alivePlayers.length))
  const damages = {}
  alivePlayers.forEach(s => { damages[s] = share })

  logEntries.push(makeLog("sync", ""))
  logEntries.push(makeLog("after_hit",
    `💠 싱크로나이즈! ${alivePlayers.length}명이 데미지를 균등 분산! (각 ${share})`
  ))
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

function processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName) {
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  const dice     = rollD10()
  logEntries.push(makeLog("move_announce", `${bossName}의 ${moveName}!`))

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
      if (finalDmg <= 0) {
        // 블래키가 막음
      } else if (pkmn.enduring && finalDmg >= pkmn.hp) {
        pkmn.hp = 1; pkmn.enduring = false
        logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
      } else {
        pkmn.hp = Math.max(0, pkmn.hp - finalDmg)
      }
      if (finalDmg > 0) {
        pkmn.defending = false; pkmn.defendTurns = 0
        logEntries.push(makeLog("hp", "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
        if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
        if (pkmn.bideState) { pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + finalDmg; pkmn.bideState.lastAttackerSlot = "boss" }
      }
    }
  } else {
    if (!targetSlot) { logEntries.push(makeLog("normal", "공격할 대상이 없다!")); return }
    const idx  = data[`${targetSlot}_active_idx`] ?? 0
    const pkmn = entries[targetSlot]?.[idx]
    if (!pkmn || pkmn.hp <= 0) { logEntries.push(makeLog("normal", "공격할 대상이 이미 쓰러졌다!")); return }

    const { damage, multiplier, critical } = calcBossDamage(data, moveName, pkmn, dice)
    logEntries.push(makeLog("dice", "", { slot: "boss", roll: dice }))
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`)); return }

    if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))

    const { damages, clearSync } = applySyncDistribution(damage, targetSlot, data, entries, logEntries)
    if (clearSync) data.sync_active = false

    activateUmbreon(damages, data, entries, logEntries)
    applyDamagesToPlayers(damages, entries, data, logEntries)

    if (moveInfo?.rank?.targetDef !== undefined) {
      const pkmn2 = entries[targetSlot]?.[data[`${targetSlot}_active_idx`] ?? 0]
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

// Firestore에서 독침붕 스탯 읽어오기
async function fetchBeedrilStats(roomId) {
  const snap = await db.collection("raid").doc("beequeen").get()
  const base = snap.data()?.Beedrill ?? {}
  return {
    attack:  base.attack  ?? 3,
    defense: base.defense ?? 3,
    speed:   base.speed   ?? 3,
    hp:      base.hp      ?? 60,
    maxHp:   base.hp      ?? 60,
    moves:   base.moves   ?? [],
    type:    base.type    ?? ["벌레", "독"],
    portrait: base.portrait ?? null,
    name:    "독침붕",
    ranks:   defaultRanks(),
  }
}

// 소환 처리
async function processSummon(roomId, data, logEntries) {
  const stats = await fetchBeedrilStats(roomId)
  const beedrill1 = { ...JSON.parse(JSON.stringify(stats)), _idx: 0 }
  const beedrill2 = { ...JSON.parse(JSON.stringify(stats)), _idx: 1 }
  data.Beedrill = [beedrill1, beedrill2]
  logEntries.push(makeLog("normal", "비퀸이 독침붕을 두 마리 소환했다!"))
  logEntries.push(makeLog("beedrill_summon", "", { beedrills: data.Beedrill }))
}

// 공격지령 처리 — 독침붕 마구찌르기
// 마구찌르기: multiHit { min:2, max:5, fixedDamage:20 }
const MAGU_MOVE = {
  power: 1, type: "노말", accuracy: 85, alwaysHit: false, effect: null,
  multiHit: { min: 2, max: 5, fixedDamage: 20 },
}
const MAGU_NAME = "마구찌르기"

function processAttackCommand(data, entries, targetSlot, priorityLog, logEntries) {
  const beedrills = data.Beedrill ?? []
  const aliveBees = beedrills.filter(b => b.hp > 0)
  if (aliveBees.length === 0) { logEntries.push(makeLog("normal", "독침붕이 없다!")); return }

  // 타겟 유효성 확인 — 기절했으면 살아있는 랜덤 대상으로 교체
  const alive = getAlivePlayers(data, entries)
  if (alive.length === 0) { logEntries.push(makeLog("normal", "공격할 대상이 없다!")); return }
  let realTarget = targetSlot && alive.includes(targetSlot) ? targetSlot : alive[Math.floor(Math.random() * alive.length)]

  for (const bee of aliveBees) {
    const idx  = data[`${realTarget}_active_idx`] ?? 0
    const pkmn = entries[realTarget]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue

    // 명중 판정 (accuracy: 85)
    if (Math.random() * 100 >= 85) {
      logEntries.push(makeLog("move_announce", `독침붕의 ${MAGU_NAME}!`))
      logEntries.push(makeLog("normal", "독침붕의 공격은 빗나갔다!"))
      continue
    }

    // multiHit 처리
    const { min, max, fixedDamage } = MAGU_MOVE.multiHit
    const hitCount = Math.floor(Math.random() * (max - min + 1)) + min
    logEntries.push(makeLog("move_announce", `독침붕의 ${MAGU_NAME}!`))
    if (priorityLog) logEntries.push(makeLog("normal", priorityLog))

    let totalDmg = 0
    const defTypes = Array.isArray(pkmn.type) ? pkmn.type : [pkmn.type]
    let mult = 1
    for (const dt of defTypes) mult *= getTypeMultiplier("노말", dt)

    if (mult === 0) {
      logEntries.push(makeLog("normal", `${pkmn.name}에게는 효과가 없다…`))
    } else {
      const dmgPerHit = Math.max(1, Math.floor(fixedDamage * mult))
      for (let h = 0; h < hitCount; h++) {
        if (pkmn.hp <= 0) break
        const actualDmg = dmgPerHit
        if (pkmn.enduring && actualDmg >= pkmn.hp) {
          pkmn.hp = 1; pkmn.enduring = false
          logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
        } else {
          pkmn.hp = Math.max(0, pkmn.hp - actualDmg)
        }
        totalDmg += actualDmg
        logEntries.push(makeLog("hit", "", { defender: realTarget }))
        logEntries.push(makeLog("hp",  "", { slot: realTarget, hp: pkmn.hp, maxHp: pkmn.maxHp }))
        if (pkmn.hp <= 0) { logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: realTarget })); break }
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

// 방어지령 처리 — 독침붕 방어 랭크 +2
function processDefendCommand(data, logEntries) {
  const beedrills = data.Beedrill ?? []
  let applied = false
  for (const bee of beedrills) {
    if (bee.hp <= 0) continue
    const r   = bee.ranks ?? defaultRanks()
    const cur = r.def ?? 0
    const DEF_MAX = 3
    if (cur >= DEF_MAX) {
      logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "의")} 방어 랭크는 이미 최대다!`))
    } else {
      const next = Math.min(DEF_MAX, cur + 2)
      bee.ranks  = { ...r, def: next, defTurns: 2 }
      logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "의")} 방어 랭크가 ${next - cur} 올라갔다! (+${next})`))
      applied = true
    }
  }
  if (applied) logEntries.push(makeLog("normal", "독침붕은 방어 태세에 들어갔다!"))
}

// 회복지령 처리 — 독침붕 HP 22% 회복, 반환값으로 회복 후 상태 알림
function processHealCommand(data, logEntries) {
  const beedrills = data.Beedrill ?? []
  let anyAbove50 = false
  for (const bee of beedrills) {
    if (bee.hp <= 0) continue
    const heal = Math.max(1, Math.floor((bee.maxHp ?? bee.hp) * 0.22))
    bee.hp = Math.min(bee.maxHp ?? bee.hp, bee.hp + heal)
    logEntries.push(makeLog("normal", `독침붕${josa("독침붕", "은는")} 체력을 회복했다! (+${heal})`))
    logEntries.push(makeLog("beedrill_hp", "", { beedrills: data.Beedrill }))
    if (bee.hp / (bee.maxHp ?? 1) >= 0.5) anyAbove50 = true
  }
  return anyAbove50
}

// 독침붕 전멸 여부 확인 및 step 전환
// 반환: { allDead, nextStep, killIncrement }
function checkBeedrilDeath(data, nextState) {
  const beedrills  = data.Beedrill ?? []
  const allDead    = beedrills.length > 0 && beedrills.every(b => b.hp <= 0)
  if (!allDead) return { allDead: false, nextState }

  const newKillCount = (nextState.beedrillKillCount ?? 0) + beedrills.filter(b => b.hp <= 0).length
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

  const { decideBossMove, shouldTriggerUlt, getUltTarget, nextUltCooldown } = bossAI

  // ── 기습 ult 체크 ───────────────────────────────────────────────
  let bossUltCooldownNext = data.boss_ult_cooldown ?? 0
  if (shouldTriggerUlt(data)) {
    const ultTarget = getUltTarget(data, entries, PLAYER_SLOTS)
    if (ultTarget) {
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "이가")} 기습을 노린다!`))
      processBossAttack("기습", ultTarget, false, data, entries, logEntries, bossName)
      bossUltCooldownNext = nextUltCooldown()
    }
  }

  // ── 보스 행동 결정 ──────────────────────────────────────────────
  const decision = decideBossMove(data, entries, PLAYER_SLOTS)
  const { command, log: commandLog, nextState: rawNextState } = decision
  let { moveName, targetSlot } = decision
  let nextState = rawNextState ?? data.boss_state ?? {}

  // ── 마비/얼음 상태이상 체크 (direct 공격에만 적용) ──────────────
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

  // ── 비퀸 지령 처리 ─────────────────────────────────────────────
  } else if (command === "summon") {
    await processSummon(roomId, data, logEntries)

  } else if (command === "recharge") {
    // 재충전 대기 — 로그만 출력
    logEntries.push(makeLog("normal", decision.log ?? "여왕은 힘을 비축하고 있다!"))
    // recharge2에서 summon으로 넘어가면 즉시 소환
    if (nextState.step === "summon") {
      await processSummon(roomId, data, logEntries)
    }

  } else if (command === "attack") {
    // 공격지령 — 독침붕이 마구찌르기 즉시 실행
    logEntries.push(makeLog("normal", "비퀸이 공격지령을 내렸다!"))
    processAttackCommand(data, entries, targetSlot, decision.priority === "revenge" ? commandLog : null, logEntries)

  } else if (command === "defend") {
    // 방어지령
    logEntries.push(makeLog("normal", "비퀸이 방어지령을 내렸다!"))
    processDefendCommand(data, logEntries)

  } else if (command === "heal") {
    // 회복지령
    logEntries.push(makeLog("normal", "비퀸이 회복지령을 내렸다!"))
    const anyAbove50 = processHealCommand(data, logEntries)
    // 회복 후 50% 이상이면 defend, 아니면 attack으로 분기
    nextState = { ...nextState, step: anyAbove50 ? "defend" : "attack" }

  } else if (command === "direct") {
    // 2페이즈 — 비퀸 직접 공격
    if (commandLog) logEntries.push(makeLog("normal", commandLog))
    const moveInfo = bossMoves[moveName] ?? moves[moveName]
    const isAoe    = !!(moveInfo?.aoe)
    processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)

  } else if (moveName) {
    // 기타 일반 보스 공격 (앱솔 등)
    const moveInfo = bossMoves[moveName] ?? moves[moveName]
    const isAoe    = !!(moveInfo?.aoe)
    if (isStatusBlocked) {
      // 이미 위에서 처리됨
    } else {
      processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)
    }
  }

  // ── 독침붕 전멸 체크 (1페이즈) ─────────────────────────────────
  if (command !== "direct" && command !== "recharge" && command !== "summon") {
    const deathCheck = checkBeedrilDeath(data, nextState)
    if (deathCheck.allDead) {
      nextState = deathCheck.nextState
      // 6마리 누적 달성 or HP 60% 이하 → 2페이즈 (비퀸.js getPhase가 자동 판정)
      if (nextState.beedrillKillCount < 6) {
        logEntries.push(makeLog("normal", "독침붕이 모두 쓰러졌다! 여왕은 힘을 비축하고 있다!"))
        // 독침붕 철회
        data.Beedrill = []
      } else {
        logEntries.push(makeLog("normal", "독침붕이 모두 쓰러졌다! 비퀸이 직접 나선다!"))
        data.Beedrill = []
      }
    }
  }

  // ── HP 60% 이하 2페이즈 진입 체크 ─────────────────────────────
  const hpRatio = (data.boss_current_hp ?? 0) / (data.boss_max_hp ?? 1)
  if (hpRatio <= 0.6 && command !== "direct" && (data.boss_state?.step !== "recharge") && (data.boss_state?.step !== "recharge2")) {
    const wasPhase1 = !nextState.phase2Step
    if (wasPhase1) {
      logEntries.push(makeLog("normal", "비퀸이 직접 나섰다!"))
      data.Beedrill = []
      nextState = { ...nextState, phase2Step: "sting1" }
    }
  }

  // ── 보스 독/화상 EOT ────────────────────────────────────────────
  if (data.boss_status === "독" || data.boss_status === "화상") {
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
    Beedrill:    data.Beedrill  ?? [],
    sync_active:       data.sync_active     ?? false,
    umbreon_used:      data.umbreon_used    ?? false,
    current_order:     newOrder,
    turn_count:        (data.turn_count ?? 1) + 1,
    turn_started_at:   newOrder.length > 0 ? Date.now() : null,
    ...extraUpdate,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  // 보스 공격으로 기절한 플레이어 → force_switch
  PLAYER_SLOTS.forEach(s => {
    const idx       = data[`${s}_active_idx`] ?? 0
    const pkmn      = entries[s]?.[idx]
    const benchAlive = (entries[s] ?? []).some((p, i) => i !== idx && p.hp > 0)
    if (pkmn && pkmn.hp <= 0 && benchAlive && !result) {
      update[`force_switch_${s}`] = true
    }
  })

  if (result) {
    update.game_over     = true
    update.raid_result   = result
    update.current_order = []
    update.turn_started_at = null
  }

  await db.collection("raid").doc(roomId).update(update)
  return result
}