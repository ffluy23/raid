// api/raidUseMove.js
import { db } from "../lib/firestore.js"
import { executeBossAction, deepCopyEntries as deepCopyRaidEntries2, checkRaidWin as checkRaidWin2, PLAYER_SLOTS as PS } from "../lib/raidBossAction.js"
import { activateUmbreon } from "../lib/umbreon.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, getStatusSpdPenalty,
  applyStatus, applyVolatile, tickVolatiles
} from "../lib/effecthandler.js"
import {
  startWeather, tickWeather, endWeather,
  applyWeatherDamage, getWeatherDamageMult,
  patchMoveForWeather, getWeatherLog        
} from "../lib/weather.js"
import {
  deepCopyEntries, corsHeaders, rollD10
} from "../lib/gameUtils.js"

// ── 레이드 상수 ──────────────────────────────────────────────────────
const PLAYER_SLOTS = ["p1", "p2", "p3"]
const BEEDRILL_SLOTS = ["beedrill_0", "beedrill_1"]

function isBeedrillSlot(slot) {
  return BEEDRILL_SLOTS.includes(slot)
}

function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  let assistEventTs = null, syncEventTs = null
  logEntries.forEach((entry, i) => {
    const ts = base + i
    if (entry.type === "assist") assistEventTs = ts
    if (entry.type === "sync")   syncEventTs   = ts
    batch.set(logsRef.doc(), { ...entry, ts })
  })
  await batch.commit()
  return { assistEventTs, syncEventTs }
}

function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function getActiveRankVal(pokemon, key) {
  const r = pokemon.ranks ?? {}
  return (r[`${key}Turns`] ?? 0) > 0 ? (r[key] ?? 0) : 0
}

function getBaseStat(pokemon, key) {
  return pokemon[key === "atk" ? "attack" : key === "def" ? "defense" : "speed"] ?? 3
}

// ── 승패 판정 ────────────────────────────────────────────────────────
function checkRaidWin(entries, bossHp) {
  if (bossHp <= 0) return "victory"
  const allDead = PLAYER_SLOTS.every(s => (entries[s] ?? []).every(p => p.hp <= 0))
  if (allDead) return "defeat"
  return null
}

// ── 플레이어 엔트리 deep copy ────────────────────────────────────────
function deepCopyRaidEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

function buildRaidEntryUpdate(entries) {
  const update = {}
  PLAYER_SLOTS.forEach(s => { update[`${s}_entry`] = entries[s] })
  return update
}

// ── 랭크 틱 ─────────────────────────────────────────────────────────
function tickRanks(pokemon, logEntries) {
  if (!pokemon.ranks) return
  const r = pokemon.ranks
  if (r.atkTurns > 0) { r.atkTurns--; if (!r.atkTurns) { r.atk = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 공격 랭크가 원래대로 돌아왔다!`)) } }
  if (r.defTurns > 0) { r.defTurns--; if (!r.defTurns) { r.def = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 방어 랭크가 원래대로 돌아왔다!`)) } }
  if (r.spdTurns > 0) { r.spdTurns--; if (!r.spdTurns) { r.spd = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 스피드 랭크가 원래대로 돌아왔다!`)) } }
}

// ── 랭크 변화 적용 ───────────────────────────────────────────────────
function applyRankChanges(r, self, target, moveName, logEntries) {
  if (!r) return
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if (!roll) return
  const selfR   = { ...(self.ranks   ?? defaultRanks()) }
  const targetR = { ...(target.ranks ?? defaultRanks()) }

  const ATK_MAX = 4, DEF_MAX = 3, SPD_MAX = 5
  function applyOne(obj, key, delta, name) {
    const label  = key === "atk" ? "공격" : key === "def" ? "방어" : "스피드"
    const maxVal = key === "atk" ? ATK_MAX : key === "def" ? DEF_MAX : SPD_MAX
    const cur    = obj[key] ?? 0
    if (delta > 0) {
      if (cur >= maxVal) { logEntries.push(makeLog("normal", `${name}의 ${label} 랭크는 이미 최대다!`)); return }
      const next = Math.min(maxVal, cur + delta)
      obj[key] = next
      if ((obj[`${key}Turns`] ?? 0) <= 0) obj[`${key}Turns`] = r.turns ?? 2
      logEntries.push(makeLog("normal", `${name}의 ${label} 랭크가 ${next - cur} 올라갔다! (${next > 0 ? "+" : ""}${next})`))
    } else if (delta < 0) {
      const minVal = -maxVal
      if (cur <= minVal) { logEntries.push(makeLog("normal", `${name}의 ${label} 랭크는 더 이상 내려가지 않는다!`)); return }
      const next = Math.max(minVal, cur + delta)
      obj[key] = next
      if ((obj[`${key}Turns`] ?? 0) <= 0) obj[`${key}Turns`] = r.turns ?? 2
      logEntries.push(makeLog("normal", `${name}의 ${label} 랭크가 ${cur - next} 내려갔다! (${next > 0 ? "+" : ""}${next})`))
    }
  }
  if (r.atk       !== undefined) applyOne(selfR,   "atk", r.atk,       self.name)
  if (r.def       !== undefined) applyOne(selfR,   "def", r.def,       self.name)
  if (r.spd       !== undefined) applyOne(selfR,   "spd", r.spd,       self.name)
  if (r.targetAtk !== undefined) applyOne(targetR, "atk", r.targetAtk, target.name)
  if (r.targetDef !== undefined) applyOne(targetR, "def", r.targetDef, target.name)
  if (r.targetSpd !== undefined) applyOne(targetR, "spd", r.targetSpd, target.name)
  self.ranks   = selfR
  target.ranks = targetR
}

// ── 명중 계산 ────────────────────────────────────────────────────────
function calcHit(atk, moveInfo, def) {
  if (Math.random() * 100 >= (moveInfo.accuracy ?? 100)) return { hit: false, hitType: "missed" }
  if (def.flyState?.flying  && !moveInfo.twister) return { hit: false, hitType: "evaded" }
  if (def.digState?.digging && moveInfo._name !== "지진") return { hit: false, hitType: "evaded" }
  if (def.ghostDiveState?.diving) return { hit: false, hitType: "evaded" }
  if (moveInfo.alwaysHit || moveInfo.skipEvasion) return { hit: true, hitType: "hit" }
  const as = Math.max(1, getBaseStat(atk, "spd") - getStatusSpdPenalty(atk))
  const ds = Math.max(1, getBaseStat(def, "spd") - getStatusSpdPenalty(def))
  const atkSpdRank = getActiveRankVal(atk, "spd")
  const defSpdRank = getActiveRankVal(def, "spd")
  const ev = Math.min(10, Math.max(0, 2 * (ds - as) + (defSpdRank - atkSpdRank)))
  return Math.random() * 100 < ev ? { hit: false, hitType: "evaded" } : { hit: true, hitType: "hit" }
}

// ── 데미지 계산 (보스/플레이어 대상) ────────────────────────────────
function calcDamage(atk, moveName, def, powerOverride = null, diceOverride = null, weather = null) {
  const move = moves[moveName]
  if (!move) return { damage: 0, multiplier: 1, stab: false, critical: false, dice: 0 }
  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(def.type) ? def.type : [def.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, stab: false, critical: false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const power    = powerOverride ?? (move.power ?? 40)
  const atkStat  = getBaseStat(atk, "atk")
  const base     = power + atkStat * 4 + dice
  const weatherMult = getWeatherDamageMult(weather, move.type)
const raw         = Math.floor(base * mult * (stab ? 1.3 : 1) * weatherMult)
  const atkRank  = getActiveRankVal(atk, "atk")
  const afterAtk = Math.max(0, raw + atkRank)
  const afterDef = afterAtk - getBaseStat(def, "def") * 3
  const defRank  = (moves[moveName]?.ignoreDefRank) ? 0 : getActiveRankVal(def, "def")
const baseDmg  = afterDef - defRank * 3
  if (baseDmg <= 0) {
    const minDice   = Math.floor(Math.random() * 5) + 1
    const minDamage = minDice * 5
    return { damage: minDamage, multiplier: mult, stab, critical: false, dice, minRoll: true, minDice }
  }
  const critRate = Math.min(100, atkStat * 2 + (move.highCrit ? 3 : 0))
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(baseDmg * 1.5) : baseDmg, multiplier: mult, stab, critical, dice }
}

// ════════════════════════════════════════════════════════════════════
//  독침붕 타겟 관련 유틸 (원본 유지)
// ════════════════════════════════════════════════════════════════════

function getBeedrill(data, slot) {
  const idx = parseInt(slot.replace("beedrill_", ""), 10)
  return (data.Beedrill ?? [])[idx] ?? null
}

function applyDamageToBeedrill(data, slot, dmg, logEntries) {
  const idx      = parseInt(slot.replace("beedrill_", ""), 10)
  const beedrills = data.Beedrill ?? []
  const bee       = beedrills[idx]
  if (!bee || bee.hp <= 0) return

  if (bee.enduring && dmg >= bee.hp) {
    bee.hp = 1; bee.enduring = false
    logEntries.push(makeLog("after_hit", `${bee.name}${josa(bee.name, "은는")} 버텼다!`))
  } else {
    bee.hp = Math.max(0, bee.hp - dmg)
  }
  logEntries.push(makeLog("hit", "", { defender: slot }))
  logEntries.push(makeLog("beedrill_hp", "", { slot, hp: bee.hp, maxHp: bee.maxHp, beedrills }))
  if (bee.hp <= 0) {
    logEntries.push(makeLog("faint", `${bee.name}${josa(bee.name, "은는")} 쓰러졌다!`, { slot }))
  }
}

function anyBeedrillAlive(data) {
  return (data.Beedrill ?? []).some(b => b.hp > 0)
}

function validateBeedrillTarget(data, targetSlots, logEntries) {
  if (anyBeedrillAlive(data) && targetSlots.includes("boss")) {
    logEntries.push(makeLog("normal", "독침붕이 여왕을 지키고 있다! 먼저 독침붕을 쓰러뜨려야 한다!"))
    return false
  }
  return true
}

function calcDamageToBeedrill(atk, moveName, bee, diceOverride = null, weather = null) {
  const move = moves[moveName]
  if (!move) return { damage: 0, multiplier: 1, stab: false, critical: false, dice: 0 }
  const dice     = diceOverride ?? rollD10()
  const defTypes = Array.isArray(bee.type) ? bee.type : [bee.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, stab: false, critical: false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const power    = move.power ?? 40
  const atkStat  = getBaseStat(atk, "atk")
  const base     = power + atkStat * 4 + dice
  const weatherMult = getWeatherDamageMult(weather, move.type)
const raw         = Math.floor(base * mult * (stab ? 1.3 : 1) * weatherMult)
  const atkRank  = getActiveRankVal(atk, "atk")
  const afterAtk = Math.max(0, raw + atkRank)
  const defStat  = bee.defense ?? 3
  const defRank  = (moves[moveName]?.ignoreDefRank) ? 0 : getActiveRankVal(bee, "def")
  const baseDmg  = afterAtk - defStat * 3 - defRank * 3
  if (baseDmg <= 0) {
    const minDice   = Math.floor(Math.random() * 5) + 1
    const minDamage = minDice * 5
    return { damage: minDamage, multiplier: mult, stab, critical: false, dice, minRoll: true, minDice }
  }
  const critRate = Math.min(100, atkStat * 2 + (move.highCrit ? 3 : 0))
  const critical = Math.random() * 100 < critRate
  return { damage: critical ? Math.floor(baseDmg * 1.5) : baseDmg, multiplier: mult, stab, critical, dice }
}

function attackBeedrill(myPkmn, mySlot, beeSlot, moveName, moveInfo, data, logEntries, opts = {}) {
  const { isAssistCaster = false } = opts
  const bee = getBeedrill(data, beeSlot)
  if (!bee || bee.hp <= 0) {
    logEntries.push(makeLog("normal", "독침붕은 이미 쓰러졌다!"))
    return 0
  }

  const fakeDefender = { type: bee.type, speed: bee.speed ?? 3, ranks: bee.ranks ?? defaultRanks() }
  const { hit, hitType } = calcHit(myPkmn, moveInfo, fakeDefender)
  if (!hit) {
    logEntries.push(makeLog("normal", hitType === "evaded"
      ? `독침붕${josa("독침붕", "이가")} 피했다!`
      : `${myPkmn.name}${josa(myPkmn.name, "의")} 공격은 빗나갔다!`))
    return 0
  }

  const { damage, multiplier, critical, dice, minRoll, minDice } = calcDamageToBeedrill(myPkmn, moveName, bee)
  logEntries.push(makeLog("dice", "", { slot: mySlot, roll: dice }))

  if (multiplier === 0) {
    logEntries.push(makeLog("normal", `독침붕에게는 효과가 없다…`))
    return 0
  }

  let finalDmg = damage
  if (isAssistCaster) finalDmg = Math.floor(finalDmg * 1.15)

  const chargedMult = (myPkmn.charged && moveInfo?.type === "전기") ? 1.2 : 1.0
  myPkmn.charged = false
  if (chargedMult > 1) {
    finalDmg = Math.floor(finalDmg * chargedMult)
    logEntries.push(makeLog("after_hit", "충전된 전기로 위력이 올라갔다!"))
  }

    if (myPkmn.helperBoost) {
  finalDmg = Math.floor(finalDmg * 1.2)
  myPkmn.helperBoost = false
  logEntries.push(makeLog("after_hit", "도우미 효과로 위력이 올라갔다!"))
}

// ── [PATCH] 보복 ──
            if (moves[moveName]?.comeback && myPkmn.tookDamageLastTurn) {
  finalDmg = Math.floor(finalDmg * 1.6)
  logEntries.push(makeLog("after_hit", "원한이 쌓인 일격!"))
}

  finalDmg = Math.max(1, finalDmg)

  if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
  if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
  if (minRoll)        logEntries.push(makeLog("after_hit", `${minDice}! (최소 피해 보장)`))
  else if (critical)  logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
  if (isAssistCaster) logEntries.push(makeLog("after_hit", "어시스트 효과로 위력이 올라갔다!"))

  applyDamageToBeedrill(data, beeSlot, finalDmg, logEntries)

  if (moveInfo?.effect?.drain && finalDmg > 0) {
    const heal = Math.max(1, Math.floor(finalDmg * moveInfo.effect.drain))
    myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 체력을 흡수했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
  }
  if (moveInfo?.effect?.recoil && finalDmg > 0) {
    const recoil = Math.max(1, Math.floor(finalDmg * moveInfo.effect.recoil))
    myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
    if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
  }

  return finalDmg
}

function attackAllBeedrills(myPkmn, mySlot, moveName, moveInfo, data, logEntries, opts = {}) {
  const beedrills = data.Beedrill ?? []
  let totalDmg = 0
  beedrills.forEach((bee, i) => {
    if (bee.hp <= 0) return
    const dmg = attackBeedrill(myPkmn, mySlot, `beedrill_${i}`, moveName, moveInfo, data, logEntries, opts)
    totalDmg += dmg
  })
  return totalDmg
}

function applyAoeFriendlyFire(myPkmn, mySlot, moveName, entries, data, logEntries) {
  const move = moves[moveName]
  if (!move?.aoe) return
  const dice = rollD10()
  for (const s of PLAYER_SLOTS) {
    if (s === mySlot) continue
    const idx  = data[`${s}_active_idx`] ?? 0
    const ally = entries[s]?.[idx]
    if (!ally || ally.hp <= 0) continue
    const allyTypes = Array.isArray(ally.type) ? ally.type : [ally.type]
    let mult = 1
    for (const t of allyTypes) mult *= getTypeMultiplier(move.type, t)
    if (mult === 0) { logEntries.push(makeLog("normal", `${ally.name}에게는 효과가 없다…`)); continue }
    const atkStat = getBaseStat(myPkmn, "atk")
    const power   = move.power ?? 40
    const base    = power + atkStat * 4 + dice
    const raw     = Math.floor(base * mult * (Array.isArray(myPkmn.type) ? myPkmn.type : [myPkmn.type]).includes(move.type) ? 1.3 : 1)
    const atkRank = getActiveRankVal(myPkmn, "atk")
    const afterAtk = Math.max(0, raw + atkRank)
    const afterDef = afterAtk - getBaseStat(ally, "def") * 3
    const defRank  = getActiveRankVal(ally, "def")
    let baseDmg    = afterDef - defRank * 3
    let dmg = baseDmg <= 0 ? (Math.floor(Math.random() * 5) + 1) * 5 : baseDmg
    dmg = Math.max(1, Math.floor(dmg * 0.5))
    // ── [PATCH] 빛의장막 피해 감소 ──
if ((ally.lightScreen ?? 0) > 0) {
  dmg = Math.floor(dmg * 0.75)
}
    if (ally.enduring && dmg >= ally.hp) {
      ally.hp = 1; ally.enduring = false
      logEntries.push(makeLog("after_hit", `${ally.name}${josa(ally.name, "은는")} 버텼다!`))
    } else {
      ally.hp = Math.max(0, ally.hp - dmg)
    }
    logEntries.push(makeLog("hit", "", { defender: s }))
    logEntries.push(makeLog("hp",  "", { slot: s, hp: ally.hp, maxHp: ally.maxHp }))
    if (ally.hp <= 0) logEntries.push(makeLog("faint", `${ally.name}${josa(ally.name, "은는")} 쓰러졌다!`, { slot: s }))
  }
}

function handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, opts = {}) {
  const { moveName, accuracy, isBoss } = opts
  if (isBoss) {
    const tIdx  = data[`${targetSlot}_active_idx`] ?? 0
    const tPkmn = entries[targetSlot]?.[tIdx]
    if (!tPkmn || tPkmn.hp <= 0) { logEntries.push(makeLog("normal", "상대가 이미 쓰러졌다!")); return }
    const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95 }, tPkmn)
    if (!hit) { logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!")); return }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return }
    applyDamagesToPlayers({ [targetSlot]: damage }, entries, data, logEntries)
  } else {
    if (isBeedrillSlot(targetSlot)) {
      const bee = getBeedrill(data, targetSlot)
      if (!bee || bee.hp <= 0) { logEntries.push(makeLog("normal", "독침붕은 이미 쓰러졌다!")); return }
      const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95 }, { type: bee.type, speed: bee.speed ?? 3, ranks: bee.ranks ?? defaultRanks() })
      if (!hit) { logEntries.push(makeLog("normal", "빗나갔다!")); return }
      const { damage, multiplier, critical } = calcDamageToBeedrill(myPkmn, moveName, bee)
      if (multiplier === 0) { logEntries.push(makeLog("normal", `독침붕에게는 효과가 없다…`)); return }
      applyDamageToBeedrill(data, targetSlot, damage, logEntries)
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
    } else {
      const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95 }, { type: data.boss_type ?? "노말" })
      if (!hit) { logEntries.push(makeLog("normal", "빗나갔다!")); return }
      const fakeBoss = makeFakeBoss(data)
      const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, fakeBoss)
      const bossName = data.boss_name ?? "보스"
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`)); return }
      const finalDmg = Math.max(1, damage)
      data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - finalDmg)
      logEntries.push(makeLog("hit", "", { defender: "boss" }))
      logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
      if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
      if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
      if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
    }
  }
}

function makeFakeBoss(data) {
  return {
    type:    data.boss_type    ?? "노말",
    defense: data.boss_defense ?? 5,
    speed:   data.boss_speed   ?? 3,
    ranks:   data.boss_rank    ?? defaultRanks(),
    hp:      data.boss_current_hp ?? 1,
    maxHp:   data.boss_max_hp  ?? 1,
    name:    data.boss_name    ?? "보스",
    status:  data.boss_status  ?? null,
  }
}

function applyDamagesToPlayers(damages, entries, data, logEntries) {
  for (const [slot, dmg] of Object.entries(damages)) {
    if (dmg <= 0) continue
    const idx  = data[`${slot}_active_idx`] ?? 0
    const pkmn = entries[slot]?.[idx]
    if (!pkmn || pkmn.hp <= 0) continue
    if (pkmn.enduring && dmg >= pkmn.hp) {
      pkmn.hp      = 1
      pkmn.enduring = false
      logEntries.push(makeLog("after_hit", `${pkmn.name}${josa(pkmn.name, "은는")} 버텼다!`))
    } else {
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
    }
    logEntries.push(makeLog("hit", "", { defender: slot }))
    logEntries.push(makeLog("hp",  "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    if (pkmn.hp <= 0) logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
    if (pkmn.bideState) {
      pkmn.bideState.damage = (pkmn.bideState.damage ?? 0) + dmg
      pkmn.bideState.lastAttackerSlot = "boss"
    }
  }
}

// ── finishTurn ────────────────────────────────────────────────────────
async function finishTurn(roomRef, roomId, data, entries, logEntries, extraUpdate = {}) {
  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)
  const newOrder = (data.current_order ?? []).slice(1)
  const update   = {
    ...buildRaidEntryUpdate(entries),
    boss_current_hp: data.boss_current_hp ?? 0,
    boss_rank:       data.boss_rank       ?? defaultRanks(),
    boss_status:     data.boss_status     ?? null,
    boss_volatile:   data.boss_volatile   ?? {},
    Beedrill:  data.Beedrill  ?? [],
    sync_active:     data.sync_active     ?? false,
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...(assistEventTs !== null ? { assist_event: { ts: assistEventTs } } : {}),
    ...(syncEventTs   !== null ? { sync_event:   { ts: syncEventTs   } } : {}),
    ...extraUpdate,
    weather:      data.weather      ?? null,
    weatherTurns: data.weatherTurns ?? 0,
  }
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })
  // ── [PATCH] 대여르 타겟팅용 직전 기술 저장 ──────────────────────
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_last_move`] !== undefined) update[`${s}_last_move`] = data[`${s}_last_move`]
  })
  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)
  if (result) {
    update.game_over     = true
    update.raid_result   = result
    update.current_order = []
    update.turn_started_at = null
  }
  await roomRef.update(update)
  return result
}

// ── EOT 처리 ─────────────────────────────────────────────────────────
async function handleRaidEot(roomRef, roomId, data, entries, update, logEntries) {
  const eotLogs = []
  PLAYER_SLOTS.forEach(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s]?.[idx]
    if (!pkmn || pkmn.hp <= 0) return
    tickRanks(pkmn, eotLogs)
    if ((pkmn.tauntSelfTurns ?? 0) > 0) {
      pkmn.tauntSelfTurns--
      if (!pkmn.tauntSelfTurns)
        eotLogs.push(makeLog("normal", `${pkmn.name}에게 고정된 집중이 풀렸다!`))
    }
    if ((pkmn.taunted ?? 0) > 0) {
      pkmn.taunted--
      if (!pkmn.taunted) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 도발이 풀렸다!`))
    }
    if (pkmn.chainBound) {
      pkmn.chainBound.turnsLeft--
      if (pkmn.chainBound.turnsLeft <= 0) {
        pkmn.chainBound = null
        eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 사슬묶기가 풀렸다!`))
      }
    }
    if ((pkmn.healBlocked ?? 0) > 0) {
      pkmn.healBlocked--
      if (!pkmn.healBlocked) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 회복봉인이 풀렸다!`))
    }
    if ((pkmn.throatChopped ?? 0) > 0) {
      pkmn.throatChopped--
      if (!pkmn.throatChopped) eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 다시 소리를 낼 수 있게 됐다!`))
    }
    if (pkmn.aquaRing) {
      const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.0625))
      pkmn.hp = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
      eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 아쿠아링으로 HP를 회복했다! (+${heal})`))
      eotLogs.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    }
    // 빛의장막 틱
if ((pkmn.lightScreen ?? 0) > 0) {
  pkmn.lightScreen--
  if (!pkmn.lightScreen)
    eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 빛의장막이 사라졌다!`))
}
    if (pkmn.cursed && pkmn.hp > 0) {
      const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.25))
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
      eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 저주 때문에 ${dmg} 데미지를 입었다!`))
      eotLogs.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      if (pkmn.hp <= 0) eotLogs.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: s }))
    }
    pkmn.tookDamageLastTurn = false
    if (pkmn.status === "독" || pkmn.status === "화상") {
      const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) / 16))
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
      eotLogs.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} ${pkmn.status} 때문에 ${dmg} 데미지를 입었다!`))
      eotLogs.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      if (pkmn.hp <= 0) eotLogs.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: s }))
    }
  })
   if (data.weather) {
    const weatherLog = getWeatherLog(data.weather)
    if (weatherLog) eotLogs.push(makeLog("normal", weatherLog + "!"))

    const activePokemons = PLAYER_SLOTS
      .map(s => ({ pokemon: entries[s]?.[data[`${s}_active_idx`] ?? 0], slot: s }))
      .filter(e => e.pokemon && e.pokemon.hp > 0)

    const { msgs } = applyWeatherDamage(data.weather, activePokemons)
    msgs.forEach(m => eotLogs.push(makeLog(m.type, m.text, m.meta ?? null)))

    const { expired, weatherTurns: newTurns } = tickWeather(data.weatherTurns ?? 0)
    if (expired) {
      const allActive = PLAYER_SLOTS
        .map(s => entries[s]?.[data[`${s}_active_idx`] ?? 0])
        .filter(Boolean)
      const { msgs: endMsgs } = endWeather(data.weather, allActive)
      endMsgs.forEach(m => eotLogs.push(makeLog(m.type, m.text, m.meta ?? null)))
      data.weather      = null
      data.weatherTurns = 0
    } else {
      data.weatherTurns = newTurns
    }
  }
  for (const tSlot of PLAYER_SLOTS) {
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot]?.[tIdx]
    if (!tPkmn || !tPkmn.seeded || tPkmn.hp <= 0) continue
    const seederSlot = tPkmn.seederSlot
    if (!seederSlot || !PLAYER_SLOTS.includes(seederSlot)) continue
    const sIdx  = data[`${seederSlot}_active_idx`] ?? 0
    const sPkmn = entries[seederSlot]?.[sIdx]
    const dmg   = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.1))
    tPkmn.hp    = Math.max(0, tPkmn.hp - dmg)
    eotLogs.push(makeLog("normal", `씨뿌리기가 ${tPkmn.name}${josa(tPkmn.name, "의")} 체력을 빼앗는다!`))
    eotLogs.push(makeLog("hp", "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
    if (sPkmn && sPkmn.hp > 0) {
      sPkmn.hp = Math.min(sPkmn.maxHp ?? sPkmn.hp, sPkmn.hp + dmg)
      eotLogs.push(makeLog("hp", `${sPkmn.name}${josa(sPkmn.name, "은는")} 체력을 흡수했다! (+${dmg})`, { slot: seederSlot, hp: sPkmn.hp, maxHp: sPkmn.maxHp }))
    }
    if (tPkmn.hp <= 0) eotLogs.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))
  }
 if (eotLogs.length > 0) {
    const logsRef = db.collection("raid").doc(roomId).collection("logs")
    const base    = Date.now()
    const batch   = db.batch()
    eotLogs.forEach((entry, i) => batch.set(logsRef.doc(), { ...entry, ts: base + i }))
    await batch.commit()
    Object.assign(update, buildRaidEntryUpdate(entries))
  }
  // ── [PATCH] EOT에서 변경된 날씨 update에 반영 ──
  update.weather      = data.weather      ?? null
  update.weatherTurns = data.weatherTurns ?? 0
  return checkRaidWin(entries, data.boss_current_hp ?? 0)
}

async function runBossIfNext(roomId, data, entries) {
  const snap      = await db.collection("raid").doc(roomId).get()
  const freshData = snap.data()
  if (!freshData || freshData.game_over) return null
  const order = freshData.current_order ?? []
  if (order[0] !== "boss") return null
  const freshEntries = deepCopyRaidEntries2(freshData)
  return executeBossAction(roomId, freshData, freshEntries, order)
}

// ════════════════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, moveIdx, targetSlots } = req.body
  if (!roomId || !mySlot || moveIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })
  if (!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const bossName    = data.boss_name ?? "보스"
  const entries     = deepCopyRaidEntries(data)
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = entries[mySlot]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0) return res.status(403).json({ error: "포켓몬 기절 상태" })

  const moveData = myPkmn.moves?.[moveIdx]
  if (!moveData || moveData.pp <= 0) return res.status(403).json({ error: "사용 불가 기술" })

  if (myPkmn.chainBound?.moveName === moveData.name)
    return res.status(403).json({ error: "사슬묶기로 사용 불가" })
  if (myPkmn.tormented && moveData.name === myPkmn.lastUsedMove)
    return res.status(403).json({ error: "트집으로 사용 불가" })
  // ── [PATCH] noRepeat 기술 연속 사용 불가 ──
if (moves[moveData.name]?.noRepeat && moveData.name === myPkmn.lastUsedMove)
  return res.status(403).json({ error: "연속으로 사용할 수 없다" })
  const soundMoves = ["금속음","돌림노래","바크아웃","소란피기","싫은소리","울부짖기","울음소리","차밍보이스","비밀이야기","하이퍼보이스","매혹의보이스"]
  if ((myPkmn.throatChopped ?? 0) > 0 && soundMoves.includes(moveData.name))
    return res.status(403).json({ error: "지옥찌르기로 사용 불가" })
  if ((myPkmn.taunted ?? 0) > 0 && !(moves[moveData.name]?.power > 0))
    return res.status(403).json({ error: "도발로 사용 불가" })

  const tSlots = targetSlots ?? []
  const moveInfo = moves[moveData.name] ?? null
  const isAttackMove = !!(moveInfo?.power)
  if (isAttackMove && anyBeedrillAlive(data) && tSlots.includes("boss")) {
    return res.status(403).json({ error: "독침붕이 살아있는 동안 비퀸을 직접 공격할 수 없다" })
  }

  const targetBeedrillSlots = tSlots.filter(s => isBeedrillSlot(s))
  const targetBossOrPlayer  = tSlots.filter(s => !isBeedrillSlot(s))
  const isBeedrillTarget    = targetBeedrillSlots.length > 0
  const isAoeToBeedrills = isAttackMove && (moveInfo?.aoe || moveInfo?.aoeEnemy) && anyBeedrillAlive(data)

  const assistActive   = data.assist_active ?? false
  const assistFrom     = data.assist_request_from ?? null
  const isAssistCaster = assistActive && assistFrom === mySlot

  const logEntries = []

  tickVolatiles(myPkmn).forEach(m => logEntries.push(makeLog("normal", m)))

  // ── 2턴 기술 자동처리 ──────────────────────────────────────────

  if (myPkmn.flyState?.flying) {
    myPkmn.flyState = null
    const savedTarget = myPkmn._flyTargetSlot ?? "boss"
    myPkmn._flyTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 내려꽂는다!`))
    handleTwoTurnAttack(myPkmn, mySlot, savedTarget, entries, data, logEntries, { moveName: myPkmn.flyMoveName ?? "공중날기", accuracy: 95 })
    myPkmn.flyMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.digState?.digging) {
    myPkmn.digState = null
    const savedTarget = myPkmn._digTargetSlot ?? "boss"
    myPkmn._digTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속에서 튀어나왔다!`))
    handleTwoTurnAttack(myPkmn, mySlot, savedTarget, entries, data, logEntries, { moveName: myPkmn.digMoveName ?? "구멍파기", accuracy: 100 })
    myPkmn.digMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.ghostDiveState?.diving) {
    myPkmn.ghostDiveState = null
    const savedTarget = myPkmn._ghostDiveTargetSlot ?? "boss"
    myPkmn._ghostDiveTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 나타났다!`))
    handleTwoTurnAttack(myPkmn, mySlot, savedTarget, entries, data, logEntries, { moveName: myPkmn.ghostDiveMoveName ?? "고스트다이브", accuracy: 100 })
    myPkmn.ghostDiveMoveName = null
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries, { [`force_switch_${mySlot}`]: false })
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.hyperBeamState) {
    myPkmn.hyperBeamState = false
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 움직일 수 없다!`))
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.bideState) {
    myPkmn.bideState.turnsLeft--
    if (myPkmn.bideState.turnsLeft > 0) {
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참고 있다...`))
    } else {
      const bide = myPkmn.bideState
      myPkmn.bideState = null
      const bideDmg = (bide.damage ?? 0) * 2
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참았던 에너지를 방출했다!`))
      if (bideDmg <= 0) {
        logEntries.push(makeLog("normal", "그러나 데미지가 없어서 실패했다!"))
      } else {
        if (anyBeedrillAlive(data)) {
          ;(data.Beedrill ?? []).forEach((bee, i) => {
            if (bee.hp <= 0) return
            applyDamageToBeedrill(data, `beedrill_${i}`, bideDmg, logEntries)
          })
        } else {
          data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - bideDmg)
          logEntries.push(makeLog("hit", "", { defender: "boss" }))
          logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
          logEntries.push(makeLog("after_hit", `${bideDmg} 데미지!`))
          if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
        }
      }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.rollState?.active) {
    const rollTurn  = myPkmn.rollState.turn + 1
    const rollPower = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
    logEntries.push(makeLog("move_announce", `${myPkmn.name}의 구르기! (${rollTurn}번째)`))
    if (anyBeedrillAlive(data)) {
      ;(data.Beedrill ?? []).forEach((bee, i) => {
        if (bee.hp <= 0) return
        const defTypes = Array.isArray(bee.type) ? bee.type : [bee.type]
        let mult = 1; for (const dt of defTypes) mult *= getTypeMultiplier("바위", dt)
        if (mult === 0) { logEntries.push(makeLog("normal", `독침붕에게는 효과가 없다…`)); return }
        const dmg = Math.floor(rollPower * mult)
        applyDamageToBeedrill(data, `beedrill_${i}`, dmg, logEntries)
      })
      myPkmn.rollState = rollTurn >= 3 ? { active: false, turn: 0 } : { active: true, turn: rollTurn, targetSlot: "boss" }
    } else {
      const fakeBoss = makeFakeBoss(data)
      const defTypes = Array.isArray(fakeBoss.type) ? fakeBoss.type : [fakeBoss.type]
      let mult = 1; for (const dt of defTypes) mult *= getTypeMultiplier("바위", dt)
      if (mult === 0) {
        logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
        myPkmn.rollState = { active: false, turn: 0 }
      } else {
        const dmg = Math.floor(rollPower * mult)
        data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - dmg)
        logEntries.push(makeLog("hit", "", { defender: "boss" }))
        logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
        logEntries.push(makeLog("after_hit", `구르기 ${rollTurn}번째 (${dmg} 데미지)!`))
        if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
        myPkmn.rollState = rollTurn >= 3 || data.boss_current_hp <= 0
          ? { active: false, turn: 0 }
          : { active: true, turn: rollTurn, targetSlot: "boss" }
      }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  if (myPkmn.outrageState?.active) {
    const state      = myPkmn.outrageState
    const outMoveInfo = moves[state.moveName] ?? {}
    const outInfo    = outMoveInfo.outrage ?? {}
    const power      = outInfo.powers?.[Math.min(state.turn - 1, (outInfo.powers?.length ?? 1) - 1)] ?? 80
    const isLastTurn = state.turn >= state.maxTurn
    logEntries.push(makeLog("move_announce", `${myPkmn.name}의 ${state.moveName}!`))
    if (anyBeedrillAlive(data)) {
      ;(data.Beedrill ?? []).forEach((bee, i) => {
        if (bee.hp <= 0) return
        const { damage, multiplier, critical } = calcDamageToBeedrill(myPkmn, state.moveName, bee, null)
        if (multiplier === 0) { logEntries.push(makeLog("normal", `독침붕에게는 효과가 없다…`)); return }
        applyDamageToBeedrill(data, `beedrill_${i}`, damage, logEntries)
        if (critical) logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      })
    } else {
      const fakeBoss = makeFakeBoss(data)
      const { damage, multiplier, critical } = calcDamage(myPkmn, state.moveName, fakeBoss, power)
      if (multiplier === 0) {
        logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
      } else {
        data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - damage)
        logEntries.push(makeLog("hit", "", { defender: "boss" }))
        logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
        if (critical) logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
        if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
      }
    }
    if (isLastTurn) {
      myPkmn.outrageState = null
      if (outInfo.confusion && (myPkmn.confusion ?? 0) <= 0) {
        myPkmn.confusion = Math.floor(Math.random() * 3) + 1
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 혼란에 빠졌다!`))
      }
    } else {
      myPkmn.outrageState = { ...state, turn: state.turn + 1 }
    }
    const result = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
  }

  // ── 일반 기술 처리 ──────────────────────────────────────────────
  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

  if (!pre.blocked) {
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

    if (!conf.selfHit) {
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }
      myPkmn.lastUsedMove   = moveData.name
      // ── [PATCH A] 대여르 타겟팅용 직전 기술 저장 ──────────────
      data[`${mySlot}_last_move`] = {
        name:  moveData.name,
        power: moves[moveData.name]?.power ?? 0,
      }
      if (!myPkmn.usedMoves) myPkmn.usedMoves = []
      if (!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      if (moveInfo) moveInfo._name = moveData.name

      logEntries.push(makeLog("move_announce", `${myPkmn.name}의 ${moveData.name}!`))

      const fakeBoss = makeFakeBoss(data)

      // ── 비공격 기술 ────────────────────────────────────────────
      if (!moveInfo?.power) {
        let specialHandled = false

        if (moveInfo?.tauntSelf) {
          myPkmn.tauntSelfTurns = moveInfo.tauntSelf.turns ?? 2
          logEntries.push(makeLog("normal",
            `${myPkmn.name}${josa(myPkmn.name, "은는")} 적의 공격을 끌어당긴다! (${myPkmn.tauntSelfTurns}턴)`
          ))
          specialHandled = true
        } else if (moveInfo?.defend) {
          myPkmn.defending = true; myPkmn.defendTurns = 2
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 방어 태세에 들어갔다!`))
          specialHandled = true
        } else if (moveInfo?.endure) {
          myPkmn.enduring = true
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 버티기 태세에 들어갔다!`))
          specialHandled = true
        } else if (moveInfo?.amulet) {
          myPkmn.amuletTurns = 3
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 신비의 부적으로 몸을 감쌌다!`))
          specialHandled = true
        } else if (moveInfo?.wish) {
          myPkmn.wishTurns = 2
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 희망사항을 빌었다!`))
          specialHandled = true
        } else if (moveInfo?.aquaRing) {
          myPkmn.aquaRing = true
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 물의 베일로 몸을 감쌌다!`))
          specialHandled = true
          } else if (moveInfo?.effect?.weather) {
  const allActive = PLAYER_SLOTS
    .map(s => entries[s]?.[data[`${s}_active_idx`] ?? 0])
    .filter(Boolean)
  const { msgs, weather: newW, weatherTurns: newT } =
    startWeather(
      moveInfo.effect.weather,
      moveInfo.effect.weatherTurns ?? 5,
      data.weather ?? null,
      allActive
    )
  data.weather      = newW
  data.weatherTurns = newT
  msgs.forEach(m => logEntries.push(makeLog("normal", m)))
  specialHandled = true

  } else if (moveInfo?.lightScreen) {
  myPkmn.lightScreen = 3
  logEntries.push(makeLog("normal",
    `${myPkmn.name}${josa(myPkmn.name, "이가")} ${moveData.name}을 쳤다!`
  ))
  specialHandled = true  
  } else if (moveInfo?.helper) {
  // targetSlots에서 아군 슬롯 찾기
  const helperTarget = tSlots.find(s => PLAYER_SLOTS.includes(s) && s !== mySlot)
  if (!helperTarget) {
    logEntries.push(makeLog("normal", "대상이 없다!"))
  } else {
    const tIdx  = data[`${helperTarget}_active_idx`] ?? 0
    const tPkmn = entries[helperTarget]?.[tIdx]
    if (!tPkmn || tPkmn.hp <= 0) {
      logEntries.push(makeLog("normal", "대상이 쓰러져 있다!"))
    } else {
      tPkmn.helperBoost = true
      logEntries.push(makeLog("normal",
        `${myPkmn.name}${josa(myPkmn.name, "이가")} ${tPkmn.name}${josa(tPkmn.name, "을를")} 도와준다!`
      ))
    }
  }
  specialHandled = true

        } else if (moveInfo?.splash) {
          logEntries.push(makeLog("normal", "그러나 아무 일도 일어나지 않았다!"))
          specialHandled = true
        } else if (moveInfo?.effect?.heal && moveInfo.targetSelf !== false) {
          if ((myPkmn.healBlocked ?? 0) > 0) {
            logEntries.push(makeLog("normal", "회복이 봉인돼 있어서 실패했다!"))
          } else if (moveInfo?.waterHeal) {
            for (const s of PLAYER_SLOTS) {
              const idx  = data[`${s}_active_idx`] ?? 0
              const pkmn = entries[s]?.[idx]
              if (!pkmn || pkmn.hp <= 0) continue
              if ((pkmn.healBlocked ?? 0) > 0) {
                logEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 회복이 봉인돼 있다!`))
                continue
              }
              const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * moveInfo.effect.heal))
              pkmn.hp    = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
              logEntries.push(makeLog("hp", `${pkmn.name}${josa(pkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
            }
          } else {
            const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * moveInfo.effect.heal))
            myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
            logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
          }
          specialHandled = true
        }

        if (!specialHandled) {
          const effectTarget = moveInfo?.targetSelf === false ? fakeBoss : myPkmn
          applyRankChanges(moveInfo?.rank ?? null, myPkmn, effectTarget, moveData.name, logEntries)
          applyMoveEffect(moveInfo?.effect, myPkmn, effectTarget, 0).forEach(m => {
            if (m.includes("상태")) data.boss_status = moveInfo.effect?.status ?? null
            logEntries.push(makeLog("normal", m))
          })
          if (moveInfo?.targetSelf === false && fakeBoss.status !== (data.boss_status ?? null)) {
            data.boss_status = fakeBoss.status
          }
        }

      } else {
        // ── 공격 기술 ──────────────────────────────────────────
        if (moveInfo?.fly && !myPkmn.flyState?.flying) {
          const savedTarget = isBeedrillTarget ? targetBeedrillSlots[0] : "boss"
          myPkmn.flyState       = { flying: true }
          myPkmn.flyMoveName    = moveData.name
          myPkmn._flyTargetSlot = savedTarget
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 하늘 높이 날아올랐다!`))
        } else if (moveInfo?.dig && !myPkmn.digState?.digging) {
          const savedTarget = isBeedrillTarget ? targetBeedrillSlots[0] : "boss"
          myPkmn.digState       = { digging: true }
          myPkmn.digMoveName    = moveData.name
          myPkmn._digTargetSlot = savedTarget
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속으로 파고들었다!`))
        } else if (moveInfo?.ghostDive && !myPkmn.ghostDiveState?.diving) {
          const savedTarget = isBeedrillTarget ? targetBeedrillSlots[0] : "boss"
          myPkmn.ghostDiveState       = { diving: true }
          myPkmn.ghostDiveMoveName    = moveData.name
          myPkmn._ghostDiveTargetSlot = savedTarget
          logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 어둠 속으로 사라졌다!`))
        } else {

          // ── 독침붕 대상 분기 ────────────────────────────────
          if (isBeedrillTarget || isAoeToBeedrills) {
            if (isAoeToBeedrills) {
              attackAllBeedrills(myPkmn, mySlot, moveData.name, moveInfo, data, logEntries, { isAssistCaster })
            } else {
              for (const bSlot of targetBeedrillSlots) {
                const dmgDealt = attackBeedrill(myPkmn, mySlot, bSlot, moveData.name, moveInfo, data, logEntries, { isAssistCaster })
                if (isAssistCaster && dmgDealt > 0) {
                  const bee = getBeedrill(data, bSlot)
                  if (bee && bee.hp > 0) {
                    const supporters = PLAYER_SLOTS.filter(s => s !== mySlot)
                    for (const supSlot of supporters) {
                      const supIdx  = data[`${supSlot}_active_idx`] ?? 0
                      const supPkmn = entries[supSlot]?.[supIdx]
                      if (!supPkmn || supPkmn.hp <= 0) continue
                      const bonusDmg = Math.max(1, Math.floor(dmgDealt * 0.3))
                      logEntries.push(makeLog("assist", ""))
                      applyDamageToBeedrill(data, bSlot, bonusDmg, logEntries)
                      logEntries.push(makeLog("after_hit", `${supPkmn.name}${josa(supPkmn.name, "이가")} 추가 공격했다! (${bonusDmg} 데미지)`))
                      if (bee.hp <= 0) break
                    }
                  }
                }
              }
            }
            if (moveInfo?.hyperBeam) myPkmn.hyperBeamState = true
            if (moveInfo?.uTurn) {
              const canSwitch = (entries[mySlot] ?? []).some((p, i) => i !== myActiveIdx && p.hp > 0)
              if (canSwitch) {
                await writeLogs(roomId, logEntries)
                await roomRef.update({
                  ...buildRaidEntryUpdate(entries),
                  boss_current_hp:  data.boss_current_hp,
                  Beedrill:   data.Beedrill ?? [],
                  current_order:    [mySlot, ...(data.current_order ?? []).slice(1)],
                  turn_count:       data.turn_count ?? 1,
                  turn_started_at:  data.turn_started_at,
                  [`force_switch_${mySlot}`]: true,
                })
                return res.status(200).json({ ok: true })
              }
            }

          } else {
            // ── 보스 대상 ───────────────────────────────────────
            const effectiveMoveInfo = patchMoveForWeather(data.weather ?? null, moveData.name, moveInfo)
const { hit, hitType }  = calcHit(myPkmn, effectiveMoveInfo, fakeBoss)
            if (!hit) {
              logEntries.push(makeLog("normal", hitType === "evaded"
                ? `${bossName}${josa(bossName, "이가")} 피했다!`
                : `${myPkmn.name}의 공격은 빗나갔다!`))
              if (moveInfo?.jumpKick) {
                const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
                myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
                logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${selfDmg} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
                if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
              }
            } else {
              const { damage, multiplier, critical, dice, minRoll, minDice } =
                calcDamage(myPkmn, moveData.name, fakeBoss, null, null, data.weather ?? null)
              logEntries.push(makeLog("dice", "", { slot: mySlot, roll: dice }))

              if (multiplier === 0) {
                logEntries.push(makeLog("normal", `${bossName}에게는 효과가 없다…`))
              } else {
                let finalDmg = damage
                if (isAssistCaster) finalDmg = Math.floor(finalDmg * 1.15)
                const chargedMult = (myPkmn.charged && moveInfo?.type === "전기") ? 1.2 : 1.0
                myPkmn.charged = false
                if (chargedMult > 1) { finalDmg = Math.floor(finalDmg * chargedMult); logEntries.push(makeLog("after_hit", "충전된 전기로 위력이 올라갔다!")) }

                if (myPkmn.helperBoost) {
  finalDmg = Math.floor(finalDmg * 1.2)
  myPkmn.helperBoost = false
  logEntries.push(makeLog("after_hit", "도우미 효과로 위력이 올라갔다!"))
}

// ── [PATCH] 보복 ──
               if (moves[moveName]?.comeback && myPkmn.tookDamageLastTurn) {
  finalDmg = Math.floor(finalDmg * 1.6)
  logEntries.push(makeLog("after_hit", "원한이 쌓인 일격!"))
}
                
                finalDmg = Math.max(1, finalDmg)
                data.boss_current_hp = Math.max(0, (data.boss_current_hp ?? 0) - finalDmg)
                logEntries.push(makeLog("hit", "", { defender: "boss" }))
                logEntries.push(makeLog("hp",  "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
                if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
                if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
                if (minRoll)        logEntries.push(makeLog("after_hit", `${minDice}! (최소 피해 보장)`))
                else if (critical)  logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
                if (isAssistCaster) logEntries.push(makeLog("after_hit", "어시스트 효과로 위력이 올라갔다!"))
                if (data.boss_current_hp <= 0) logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))

                // 어시스트 추가 공격
                if (isAssistCaster && finalDmg > 0 && data.boss_current_hp > 0) {
                  const supporters = PLAYER_SLOTS.filter(s => s !== mySlot)
                  for (const supSlot of supporters) {
                    const supIdx  = data[`${supSlot}_active_idx`] ?? 0
                    const supPkmn = entries[supSlot]?.[supIdx]
                    if (!supPkmn || supPkmn.hp <= 0) continue
                    const bonusDmg = Math.max(1, Math.floor(finalDmg * 0.3))
                    data.boss_current_hp = Math.max(0, data.boss_current_hp - bonusDmg)
                    logEntries.push(makeLog("assist", ""))
                    logEntries.push(makeLog("hit",       "", { defender: "boss" }))
                    logEntries.push(makeLog("hp",        "", { slot: "boss", hp: data.boss_current_hp, maxHp: data.boss_max_hp }))
                    logEntries.push(makeLog("after_hit", `${supPkmn.name}${josa(supPkmn.name, "이가")} 추가 공격했다! (${bonusDmg} 데미지)`))
                    if (data.boss_current_hp <= 0) {
                      logEntries.push(makeLog("faint", `${bossName}${josa(bossName, "은는")} 쓰러졌다!`, { slot: "boss" }))
                      break
                    }
                  }
                }

                if (moveInfo?.effect?.drain && finalDmg > 0) {
                  const heal = Math.max(1, Math.floor(finalDmg * moveInfo.effect.drain))
                  myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
                  logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 체력을 흡수했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
                }
                if (moveInfo?.effect?.recoil && finalDmg > 0) {
                  const recoil = Math.max(1, Math.floor(finalDmg * moveInfo.effect.recoil))
                  myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
                  logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
                  if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
                }
                applyMoveEffect({ ...moveInfo?.effect, drain: 0, recoil: 0 }, myPkmn, fakeBoss, finalDmg).forEach(m => {
                  if (m.includes("상태")) data.boss_status = moveInfo.effect?.status ?? null
                  logEntries.push(makeLog("normal", m))
                })
                if (moveInfo?.hyperBeam) myPkmn.hyperBeamState = true
                if (moveInfo?.uTurn) {
                  const canSwitch = (entries[mySlot] ?? []).some((p, i) => i !== myActiveIdx && p.hp > 0)
                  if (canSwitch) {
                    await writeLogs(roomId, logEntries)
                    await roomRef.update({
                      ...buildRaidEntryUpdate(entries),
                      boss_current_hp: data.boss_current_hp,
                      Beedrill:  data.Beedrill ?? [],
                      current_order:   [mySlot, ...(data.current_order ?? []).slice(1)],
                      turn_count:      data.turn_count ?? 1,
                      turn_started_at: data.turn_started_at,
                      [`force_switch_${mySlot}`]: true,
                    })
                    return res.status(200).json({ ok: true })
                  }
                }
                if (data.boss_current_hp > 0) {
                  applyAoeFriendlyFire(myPkmn, mySlot, moveData.name, entries, data, logEntries)
                }
              }
            }
          }
        }
      }
    }
  }

  // ── 어시스트 소비 ─────────────────────────────────────────────
  const assistUpdate = {}
  if (isAssistCaster) {
    assistUpdate.assist_active       = false
    assistUpdate.assist_request_from = null
    assistUpdate.assist_used         = true
  }

  const newOrder = (data.current_order ?? []).slice(1)
  const isEot    = newOrder.length === 0

  const update = {
    ...buildRaidEntryUpdate(entries),
    boss_current_hp: data.boss_current_hp ?? 0,
    boss_rank:       data.boss_rank       ?? defaultRanks(),
    boss_status:     data.boss_status     ?? null,
    boss_volatile:   data.boss_volatile   ?? {},
    boss_last_move:  data.boss_last_move  ?? null,
    Beedrill:  data.Beedrill  ?? [],
    sync_active:     data.sync_active     ?? false,
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...assistUpdate,
    weather:      data.weather      ?? null,
    weatherTurns: data.weatherTurns ?? 0,
  }
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })
  // ── [PATCH B+C] 대여르 타겟팅용 직전 기술 Firestore 저장 ────────
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_last_move`] !== undefined) update[`${s}_last_move`] = data[`${s}_last_move`]
  })

  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)
  if (assistEventTs !== null) update.assist_event = { ts: assistEventTs }
  if (syncEventTs   !== null) update.sync_event   = { ts: syncEventTs }

  const earlyResult = checkRaidWin(entries, data.boss_current_hp ?? 0)
  if (earlyResult) {
    update.game_over     = true
    update.raid_result   = earlyResult
    update.current_order = []
    update.turn_started_at = null
    await roomRef.update(update)
    return res.status(200).json({ ok: true, result: earlyResult })
  }

  if (isEot) {
    const eotResult = await handleRaidEot(roomRef, roomId, data, entries, update, logEntries)
    if (eotResult) {
      update.game_over     = true
      update.raid_result   = eotResult
      update.current_order = []
      update.turn_started_at = null
    }
  }

  await roomRef.update(update)

  // 독침붕 전멸 체크
  const allBeedrilDead = (data.Beedrill ?? []).length > 0 && (data.Beedrill ?? []).every(b => b.hp <= 0)
  if (allBeedrilDead) {
    const newKillCount = (data.boss_state?.beedrillKillCount ?? 0) + 1
    data.boss_state = {
      ...(data.boss_state ?? {}),
      step: "recharge",
      beedrillKillCount: newKillCount,
    }
    data.Beedrill = []
    await roomRef.update({
      boss_state: data.boss_state,
      Beedrill: [],
    })
  }

  await runBossIfNext(roomId, data, entries).catch(e => console.warn("보스 연속 처리 오류:", e.message))

  return res.status(200).json({ ok: true })
}