// lib/raidBossAction.js
// 보스 턴 처리 공통 로직
// raidStartRound, raidUseMove, raidSwitchPokemon, raidSkipTurn 에서 호출

import { db } from "./firestore.js"
import { bossMoves } from "./bossMoves.js"
import { moves } from "./moves.js"
import { getTypeMultiplier } from "./typeChart.js"
import { josa } from "./effecthandler.js"
import { rollD10 } from "./gameUtils.js"
import { getBossAI } from "./bossRegistry.js"

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
      if (pkmn.enduring && damage >= pkmn.hp) {
        pkmn.hp = 1; pkmn.enduring = false
        logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
      } else { pkmn.hp = Math.max(0, pkmn.hp - damage) }
      pkmn.defending = false; pkmn.defendTurns = 0
      logEntries.push(makeLog("hp", "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
      if (pkmn.bideState) { pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + damage; pkmn.bideState.lastAttackerSlot = "boss" }
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
    applyDamagesToPlayers(damages, entries, data, logEntries)
    if (clearSync) data.sync_active = false

    if (moveInfo?.rank?.targetDef !== undefined) {
      const pkmn2 = entries[targetSlot]?.[data[`${targetSlot}_active_idx`] ?? 0]
      if (pkmn2 && pkmn2.hp > 0) {
        const chance = moveInfo.rank.chance ?? 1
        if (Math.random() < chance) {
          const r = pkmn2.ranks ?? defaultRanks()
          const cur = r.def ?? 0
          const next = Math.max(-3, cur + moveInfo.rank.targetDef)
          pkmn2.ranks = { ...r, def: next, defTurns: next !== cur ? (moveInfo.rank.turns ?? 2) : r.defTurns }
          if (next < cur) logEntries.push(makeLog("normal", `${pkmn2.name}${josa(pkmn2.name, "의")} 방어 랭크가 내려갔다!`))
        }
      }
    }
  }
}

// ── 핵심 export: 보스 행동 실행 후 Firestore 업데이트 ────────────────
// data와 entries는 이미 복사된 상태로 넘어와야 함
// currentOrder: 현재 order (보스 턴 제거 전)
// extraUpdate: 호출하는 API에서 추가로 넣을 업데이트 필드
export async function executeBossAction(roomId, data, entries, currentOrder, extraUpdate = {}) {
  const bossName = data.boss_name ?? "보스"
  const logEntries = []

  let bossAI
  try { bossAI = getBossAI(bossName) }
  catch (e) { throw new Error(`보스 AI 없음: ${bossName}`) }

  const { decideBossMove, shouldTriggerUlt, getUltTarget, nextUltCooldown } = bossAI

  // 기습 ult 체크
  let bossUltCooldownNext = data.boss_ult_cooldown ?? 0
  if (shouldTriggerUlt(data)) {
    const ultTarget = getUltTarget(data, entries, PLAYER_SLOTS)
    if (ultTarget) {
      logEntries.push(makeLog("normal", `${bossName}이(가) 기습을 노린다!`))
      processBossAttack("기습", ultTarget, false, data, entries, logEntries, bossName)
      bossUltCooldownNext = nextUltCooldown()
    }
  }

  // 일반 행동
  const { moveName, targetSlot, nextState } = decideBossMove(data, entries, PLAYER_SLOTS)
  const moveInfo = bossMoves[moveName] ?? moves[moveName]
  const isAoe    = !!(moveInfo?.aoe)

  if (data.boss_status === "마비" && Math.random() < 0.25) {
    logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 마비로 움직일 수 없다!`))
  } else if (data.boss_status === "얼음" && Math.random() < 0.2) {
    logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼어붙어 있다!`))
    if (Math.random() < 0.2) {
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} 얼음이 녹았다!`))
      data.boss_status = null
    }
  } else {
    processBossAttack(moveName, targetSlot, isAoe, data, entries, logEntries, bossName)
    if (data.boss_status === "독" || data.boss_status === "화상") {
      const dmg = Math.max(1, Math.floor((data.boss_max_hp ?? 1) / 16))
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
      const statusLabel = data.boss_status === "독" ? "독" : "화상"
      logEntries.push(makeLog("normal", `${bossName}${josa(bossName, "은는")} ${statusLabel} 데미지로 ${dmg} HP를 잃었다!`))
      logEntries.push(makeLog("hp", "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
    }
  }

  // 승패 판정
  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)

  // 로그 작성
  await writeLogs(roomId, logEntries)

  // 보스 턴 제거한 order
  const newOrder = currentOrder.slice(1)

  const update = {
    ...buildEntryUpdate(entries),
    boss_current_hp:   data.boss_current_hp ?? 0,
    boss_status:       data.boss_status     ?? null,
    boss_rank:         data.boss_rank       ?? defaultRanks(),
    boss_volatile:     data.boss_volatile   ?? {},
    boss_state:        nextState,
    boss_last_move:    moveName,
    boss_ult_cooldown: bossUltCooldownNext,
    sync_active:       data.sync_active ?? false,
    current_order:     newOrder,
    turn_count:        (data.turn_count ?? 1) + 1,
    turn_started_at:   newOrder.length > 0 ? Date.now() : null,
    ...extraUpdate,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  // 보스 공격으로 기절한 플레이어 → 벤치에 살아있는 포켓몬 있으면 force_switch 설정
  PLAYER_SLOTS.forEach(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
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