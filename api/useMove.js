import { db } from "../lib/firestore.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, applyEndOfTurnDamage, getStatusSpdPenalty,
  applyStatus, applyVolatile, tickVolatiles
} from "../lib/effecthandler.js"
import {
  ALL_FS, deepCopyEntries, buildEntryUpdate, checkWin,
  teamOf, allySlot, roomName, rollD10, getActiveRank, corsHeaders,
  handleEot
} from "../lib/gameUtils.js"

function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("double").doc(roomId).collection("logs")
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

function resetRankStack(pokemon) {
  pokemon.lastRankMove = null
  pokemon.rankStack    = 0
}

function clearRankStack(pokemon) {
  pokemon.lastRankMove = null
  pokemon.rankStack    = 0
}

function tickRanks(pokemon, logEntries) {
  if (!pokemon.ranks) return
  const r = pokemon.ranks
  if (r.atkTurns > 0) { r.atkTurns--; if (!r.atkTurns) { r.atk = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 공격 랭크가 원래대로 돌아왔다!`)) } }
  if (r.defTurns > 0) { r.defTurns--; if (!r.defTurns) { r.def = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 방어 랭크가 원래대로 돌아왔다!`)) } }
  if (r.spdTurns > 0) { r.spdTurns--; if (!r.spdTurns) { r.spd = 0; logEntries.push(makeLog("normal", `${pokemon.name}의 스피드 랭크가 원래대로 돌아왔다!`)) } }
}

function applyRankChanges(r, self, target, moveName, logEntries) {
  if (!r) return
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if (!roll) return

  const selfR   = { ...(self.ranks   ?? defaultRanks()) }
  const targetR = { ...(target.ranks ?? defaultRanks()) }

  if (moveName) {
    const isSame = self.lastRankMove === moveName
    const stack  = self.rankStack ?? 0
    if (!isSame) { self.lastRankMove = moveName; self.rankStack = 1 }
    else         { self.rankStack = Math.min(2, stack + 1) }
  }

  const ATK_MAX = 4, DEF_MAX = 3, SPD_MAX = 5

  function applyOne(obj, key, delta, name, isTarget = false) {
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
      const minVal = isTarget ? -maxVal : 0
      if (cur <= minVal) { logEntries.push(makeLog("normal", `${name}의 ${label} 랭크는 더 이상 내려가지 않는다!`)); return }
      const next = Math.max(minVal, cur + delta)
      obj[key] = next
      if ((obj[`${key}Turns`] ?? 0) <= 0) obj[`${key}Turns`] = r.turns ?? 2
      logEntries.push(makeLog("normal", `${name}의 ${label} 랭크가 ${cur - next} 내려갔다! (${next > 0 ? "+" : ""}${next})`))
    }
  }

  if (r.atk       !== undefined) applyOne(selfR,   "atk", r.atk,       self.name,   false)
  if (r.def       !== undefined) applyOne(selfR,   "def", r.def,       self.name,   false)
  if (r.spd       !== undefined) applyOne(selfR,   "spd", r.spd,       self.name,   false)
  if (r.targetAtk !== undefined) applyOne(targetR, "atk", r.targetAtk, target.name, true)
  if (r.targetDef !== undefined) applyOne(targetR, "def", r.targetDef, target.name, true)
  if (r.targetSpd !== undefined) applyOne(targetR, "spd", r.targetSpd, target.name, true)

  self.ranks   = selfR
  target.ranks = targetR
}

function calcHit(atk, moveInfo, def) {
  if (Math.random() * 100 >= (moveInfo.accuracy ?? 100)) return { hit: false, hitType: "missed" }

  if (def.flyState?.flying && !moveInfo.twister && moveInfo._name !== "번개")
    return { hit: false, hitType: "evaded" }
  if (def.digState?.digging && moveInfo._name !== "지진")
    return { hit: false, hitType: "evaded" }
  if (def.ghostDiveState?.diving)
    return { hit: false, hitType: "evaded" }

  if (moveInfo.alwaysHit || moveInfo.skipEvasion) return { hit: true, hitType: "hit" }

  const as = Math.max(1, getBaseStat(atk, "spd") - getStatusSpdPenalty(atk))
  const ds = Math.max(1, getBaseStat(def, "spd") - getStatusSpdPenalty(def))
  const atkSpdRank = getActiveRankVal(atk, "spd")
  const defSpdRank = getActiveRankVal(def, "spd")
  const baseEv  = Math.max(0, 5 * (ds - as))
  const rankAdj = defSpdRank - atkSpdRank
  const ev = Math.min(99, Math.max(0, baseEv + rankAdj))
  return Math.random() * 100 < ev ? { hit: false, hitType: "evaded" } : { hit: true, hitType: "hit" }
}

function calcGyroBallPower(attacker, defender) {
  const atkSpd = Math.max(1, getBaseStat(attacker, "spd") + getActiveRankVal(attacker, "spd"))
  const defSpd = Math.max(1, getBaseStat(defender, "spd") + getActiveRankVal(defender, "spd"))
  const ratio  = defSpd / atkSpd
  if (ratio <= 1) return 30
  if (ratio <= 2) return 40
  if (ratio <= 3) return 50
  return 60
}

function calcAssistPower(pokemon) {
  const r = pokemon.ranks ?? {}
  const atkBonus = (r.atkTurns ?? 0) > 0 ? Math.max(0, r.atk ?? 0) : 0
  const defBonus = (r.defTurns ?? 0) > 0 ? Math.max(0, r.def ?? 0) : 0
  const spdBonus = (r.spdTurns ?? 0) > 0 ? Math.max(0, r.spd ?? 0) : 0
  const total = atkBonus + defBonus + spdBonus
  if (total <= 1) return 30
  if (total <= 3) return 40
  return 50
}

function calcDamage(atk, moveName, def, powerOverride = null, atkStatOverride = null, diceOverride = null) {
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
  const atkStat  = atkStatOverride ?? getBaseStat(atk, "atk")
  const base     = power + atkStat * 4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const atkRank  = getActiveRankVal(atk, "atk")
  const afterAtk = Math.max(0, raw + atkRank)
  const afterDef = Math.max(0, afterAtk - getBaseStat(def, "def") * 5)
  const defRank  = getActiveRankVal(def, "def")
  const baseDmg  = Math.max(0, afterDef - defRank * 3)

  const screenMult     = (def.lightScreenTurns ?? 0) > 0 && !move.breakBarrier ? 0.75 : 1.0
  const flyElecMult    = (def.flyState?.flying && move.type === "번개") ? 1.2 : 1.0
  const twisterFlyMult = (move.twister && def.flyState?.flying) ? 1.2 : 1.0
  const digEarthMult   = (def.digState?.digging && move.type === "지진") ? 1.2 : 1.0

  const critRate = Math.min(100, atkStat * 2 + (move.highCrit ? 3 : 0))
  const critical = Math.random() * 100 < critRate
  const finalDmg = Math.floor(baseDmg * screenMult * flyElecMult * twisterFlyMult * digEarthMult)
  return { damage: critical ? Math.floor(finalDmg * 1.5) : finalDmg, multiplier: mult, stab, critical, dice }
}

// ════════════════════════════════════════════════════════
//  특수 비공격 기술
// ════════════════════════════════════════════════════════
function handleSpecialNonAttack(moveInfo, moveName, myPkmn, mySlot, tSlots, entries, data, logEntries) {
  if (!moveInfo) return { handled: false }

  if (moveInfo.defend) {
    const prevSame = myPkmn.lastDefendMove === (moveInfo._name ?? "방어")
    const stack    = myPkmn.defendStack ?? 0
    const chance   = (prevSame && stack >= 1) ? (1 / 3) : 1.0
    if (Math.random() < chance) {
      myPkmn.defending      = true
      myPkmn.defendTurns    = 2
      myPkmn.lastDefendMove = moveInfo._name ?? "방어"
      myPkmn.defendStack    = prevSame ? stack + 1 : 1
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 방어 태세에 들어갔다!`))
    } else {
      myPkmn.lastDefendMove = null
      myPkmn.defendStack    = 0
      logEntries.push(makeLog("normal", `그러나 방어에 실패했다!`))
    }
    return { handled: true }
  }

  if (moveInfo.endure) {
    const prevEndure = myPkmn.lastEndureMove === "버티기"
    const stack      = myPkmn.endureStack ?? 0
    let chance = 1.0
    if (prevEndure && stack >= 1) chance = stack >= 2 ? 0.25 : 0.5
    if (Math.random() < chance) {
      myPkmn.enduring       = true
      myPkmn.lastEndureMove = "버티기"
      myPkmn.endureStack    = prevEndure ? Math.min(2, stack + 1) : 1
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 버티기 태세에 들어갔다!`))
    } else {
      myPkmn.lastEndureMove = null
      myPkmn.endureStack    = 0
      logEntries.push(makeLog("normal", `그러나 버티기에 실패했다!`))
    }
    return { handled: true }
  }

  if (moveInfo.amulet) {
    myPkmn.amuletTurns = 3
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 신비의 부적으로 몸을 감쌌다!`))
    return { handled: true }
  }

  if (moveInfo.wish) {
    myPkmn.wishTurns = 2
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 희망사항을 빌었다!`))
    return { handled: true }
  }

  if (moveInfo.lightScreen) {
    myPkmn.lightScreenTurns = 5
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 빛의 장막을 쳤다!`))
    return { handled: true }
  }

  if (moveInfo.haze) {
    const resetR = (p) => {
      if (p.ranks) {
        p.ranks.atk = 0; p.ranks.atkTurns = 0
        p.ranks.def = 0; p.ranks.defTurns = 0
        p.ranks.spd = 0; p.ranks.spdTurns = 0
      }
      p.lastRankMove = null; p.rankStack = 0
    }
    ALL_FS.forEach(s => {
      const idx = data[`${s}_active_idx`] ?? 0
      const p   = entries[s][idx]
      if (p) resetR(p)
    })
    logEntries.push(makeLog("normal", `흑안개가 배틀 전체를 뒤덮었다!`))
    logEntries.push(makeLog("normal", `모든 포켓몬의 능력 변화가 원래대로 돌아왔다!`))
    return { handled: true }
  }

  if (moveInfo.poisonPowder) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const eneTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    if (eneTypes.includes("풀")) {
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 독가루에 걸리지 않는다!`))
    } else if (tPkmn.status) {
      logEntries.push(makeLog("normal", `그러나 ${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 상태이상이다!`))
    } else {
      const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
      if (!hit) {
        logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
      } else {
        applyStatus(tPkmn, "독").forEach(m => logEntries.push(makeLog("normal", m)))
      }
    }
    return { handled: true }
  }

  if (moveInfo.curse) {
    const atkTypes = Array.isArray(myPkmn.type) ? myPkmn.type : [myPkmn.type]
    const isGhost  = atkTypes.includes("고스트")
    if (isGhost) {
      const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) / 3))
      myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
      logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 절반 깎았다! (-${selfDmg})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
      if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
      if (tSlots.length > 0) {
        const tSlot = tSlots[0]
        const tIdx  = data[`${tSlot}_active_idx`] ?? 0
        const tPkmn = entries[tSlot][tIdx]
        if (tPkmn && tPkmn.hp > 0) {
          if (tPkmn.cursed) {
            logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 저주 상태다!`))
          } else {
            tPkmn.cursed = true
            logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 저주를 걸었다!`))
            logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 저주에 걸렸다!`))
          }
        }
      }
    } else {
      applyRankChanges({ spd: -1, atk: 1, def: 1, turns: 2 }, myPkmn, myPkmn, moveName, logEntries)
    }
    return { handled: true }
  }

  if (moveInfo.aquaRing) {
    myPkmn.aquaRing = true
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 물의 베일로 몸을 감쌌다!`))
    return { handled: true }
  }

  if (moveInfo.healBlock) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    if ((tPkmn.healBlocked ?? 0) > 0) {
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 회복봉인 상태다!`))
    } else {
      tPkmn.healBlocked = 3
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "의")} HP 회복이 봉인됐다!`))
    }
    return { handled: true }
  }

  if (moveInfo.torment) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) {
      logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
      return { handled: true }
    }
    if (tPkmn.tormented) {
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 트집 상태다!`))
    } else {
      tPkmn.tormented = true
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 트집을 잡혔다!`))
    }
    return { handled: true }
  }

  if (moveInfo.memento) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) {
      logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
      return { handled: true }
    }
    myPkmn.hp = 0
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 모든 것을 바쳤다!`))
    logEntries.push(makeLog("hp", "", { slot: mySlot, hp: 0, maxHp: myPkmn.maxHp }))
    logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
    applyRankChanges({ targetAtk: -2, turns: 2 }, myPkmn, tPkmn, null, logEntries)
    return { handled: true }
  }

  if (moveInfo.futureSight) {
    if (myPkmn.futureSight) {
      logEntries.push(makeLog("normal", `이미 미래예지가 걸려있다!`))
    } else {
      myPkmn.futureSight = { turnsLeft: 2, attackerName: myPkmn.name, power: 70 }
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 미래를 예지했다!`))
    }
    return { handled: true }
  }

  if (moveInfo.effect?.moonlight) {
    const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.22))
    myPkmn.hp = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
    return { handled: true }
  }

  if (moveInfo.splash) {
    logEntries.push(makeLog("normal", `그러나 아무 일도 일어나지 않았다!`))
    return { handled: true }
  }

  if (moveInfo.effect && moveInfo.effect.removeFlying) {
    const healRate = moveInfo.effect.heal ?? 0.5
    const heal     = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * healRate))
    myPkmn.hp      = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
    const types = Array.isArray(myPkmn.type) ? [...myPkmn.type] : [myPkmn.type]
    myPkmn._origType  = myPkmn.type
    myPkmn.type       = types.includes("비행") ? types.filter(t => t !== "비행") : ["노말"]
    if (myPkmn.type.length === 0) myPkmn.type = ["노말"]
    myPkmn.roostTurns = 1
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅에 내려앉아 비행 타입이 사라졌다!`))
    return { handled: true }
  }

  if (moveInfo.effect && moveInfo.effect.heal && moveInfo.targetSelf !== false) {
    const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * moveInfo.effect.heal))
    myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
    if (moveInfo.waterHeal) {
      const allySlotKey = allySlot(mySlot)
      if (allySlotKey) {
        const allyIdx  = data[`${allySlotKey}_active_idx`] ?? 0
        const allyPkmn = entries[allySlotKey][allyIdx]
        if (allyPkmn && allyPkmn.hp > 0) {
          const allyHeal = Math.max(1, Math.floor((allyPkmn.maxHp ?? allyPkmn.hp) * moveInfo.effect.heal))
          allyPkmn.hp    = Math.min(allyPkmn.maxHp ?? allyPkmn.hp, allyPkmn.hp + allyHeal)
          logEntries.push(makeLog("hp", `${allyPkmn.name}${josa(allyPkmn.name, "도")} HP를 회복했다! (+${allyHeal})`, { slot: allySlotKey, hp: allyPkmn.hp, maxHp: allyPkmn.maxHp }))
        }
      }
    }
    return { handled: true }
  }

  if (moveInfo.leechSeed) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const tTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    if (tTypes.includes("풀")) { logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 씨뿌리기에 걸리지 않는다!`)); return { handled: true } }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logEntries.push(makeLog("normal", `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)); return { handled: true } }
    if (tPkmn.seeded) { logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 씨뿌리기 상태다!`)) }
    else { tPkmn.seeded = true; tPkmn.seederSlot = mySlot; logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "의")} 몸에 씨를 뿌렸다!`)) }
    return { handled: true }
  }

  if (moveInfo.healPulse) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const heal = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.22))
    tPkmn.hp   = Math.min(tPkmn.maxHp ?? tPkmn.hp, tPkmn.hp + heal)
    logEntries.push(makeLog("hp", `${tPkmn.name}${josa(tPkmn.name, "은는")} HP를 회복했다! (+${heal})`, { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
    return { handled: true }
  }

  if (moveInfo.roar) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logEntries.push(makeLog("normal", `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)); return { handled: true } }
    const tEntry     = entries[tSlot]
    const benchAlive = tEntry.map((p, i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
    if (benchAlive.length === 0) {
      logEntries.push(makeLog("normal", `그러나 ${tPkmn.name}에게는 맞지 않았다!`))
    } else {
      const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
      tPkmn.seeded = false
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 물러났다!`))
      logEntries.push(makeLog("normal", `${tEntry[randIdx].name}${josa(tEntry[randIdx].name, "이가")} 나왔다!`))
      data[`${tSlot}_active_idx`] = randIdx
    }
    return { handled: true }
  }

  if (moveInfo.bide) {
    myPkmn.bideState = { turnsLeft: 2, damage: 0 }
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참기 시작했다!`))
    return { handled: true }
  }

  if (moveInfo.fly && !myPkmn.flyState?.flying) {
    myPkmn.flyState       = { flying: true }
    myPkmn.flyMoveName    = moveInfo._name ?? "공중날기"
    myPkmn._flyTargetSlot = tSlots?.[0] ?? null
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 하늘 높이 날아올랐다!`))
    return { handled: true }
  }

  if (moveInfo.dig && !myPkmn.digState?.digging) {
    myPkmn.digState       = { digging: true }
    myPkmn.digMoveName    = moveInfo._name ?? "구멍파기"
    myPkmn._digTargetSlot = tSlots?.[0] ?? null
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속으로 파고들었다!`))
    return { handled: true }
  }

  if (moveInfo.chainBind) {
    if (tSlots.length === 0) return { handled: true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logEntries.push(makeLog("normal", `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)); return { handled: true } }
    const lastMove = tPkmn.lastUsedMove ?? null
    if (!lastMove) { logEntries.push(makeLog("normal", `그러나 ${tPkmn.name}에게는 효과가 없었다!`)) }
    else {
      tPkmn.chainBound = { moveName: lastMove, turnsLeft: 2 }
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} ${lastMove}${josa(lastMove, "을를")} 2턴간 사용할 수 없게 됐다!`))
    }
    return { handled: true }
  }

  if (moveInfo.field) {
    const enemyTeam = teamOf(mySlot) === "A" ? "B" : "A"
    const fieldKey  = `field_${enemyTeam}_${moveInfo.field}`
    const current   = data[fieldKey] ?? 0
    const max       = moveInfo.field === "toxic_spikes" ? 2 : 1
    if (current >= max) {
      logEntries.push(makeLog("normal", `이미 ${moveName}이(가) 깔려있다!`))
    } else {
      data[fieldKey] = current + 1
      logEntries.push(makeLog("normal", `${enemyTeam === "A" ? "A팀" : "B팀"}의 발밑에 ${moveName}을(를) 깔았다!`))
    }
    return { handled: true }
  }

  return { handled: false }
}

// ════════════════════════════════════════════════════════
//  특수 공격 기술
// ════════════════════════════════════════════════════════
function handleSpecialAttack(moveInfo, moveName, myPkmn, mySlot, tSlot, tPkmn, entries, data, logEntries) {
  if (!moveInfo) return { handled: false, damage: 0 }

  const missLog = (hitType) => logEntries.push(makeLog("normal",
    hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))

  function dealDamage(dmg, multiplier, critical, slot, pkmn) {
    pkmn.hp = Math.max(0, pkmn.hp - dmg)
    logEntries.push(makeLog("hit",  "", { defender: slot }))
    logEntries.push(makeLog("hp",   "", { slot, hp: pkmn.hp, maxHp: pkmn.maxHp }))
    if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
    if (pkmn.hp <= 0)   logEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot }))
  }

  // ── 고스트다이브 1턴째 (power 있으므로 여기서 처리) ──────────────
  if (moveInfo.ghostDive && !myPkmn.ghostDiveState?.diving) {
    myPkmn.ghostDiveState       = { diving: true }
    myPkmn.ghostDiveMoveName    = moveInfo._name ?? "고스트다이브"
    myPkmn._ghostDiveTargetSlot = tSlot
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 어둠 속으로 사라졌다!`))
    return { handled: true, damage: 0 }
  }

  if (moveInfo.fakeOut) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    if (Math.random() < 0.5) {
      const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
      dealDamage(damage, multiplier, critical, tSlot, tPkmn)
      if (tPkmn.hp > 0) {
        tPkmn.flinch = true
        logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 풀이 죽었다!`))
      }
      return { handled: true, damage }
    } else {
      logEntries.push(makeLog("normal", `속이기에 실패했다!`))
      applyRankChanges({ def: -2, turns: 2 }, myPkmn, myPkmn, null, logEntries)
      return { handled: true, damage: 0 }
    }
  }

  if (moveInfo.jumpKick) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) {
      missLog(hitType)
      const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
      myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
      logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${selfDmg} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
      if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
      return { handled: true, damage: 0 }
    }
    return { handled: false, damage: 0 }
  }

  if (moveInfo.counter) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    if (lastDmg <= 0) { logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "의")} 카운터는 실패했다!`)); return { handled: true, damage: 0 } }
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const dmg = Math.max(1, Math.floor(lastDmg * 1.2))
    dealDamage(dmg, 1, false, tSlot, tPkmn)
    myPkmn.lastReceivedDamage = 0
    return { handled: true, damage: dmg }
  }

  if (moveInfo.revenge || moveInfo.comeback) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const comebackMult = (moveInfo.comeback && lastDmg > 0) ? 1.2 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    if (comebackMult > 1) logEntries.push(makeLog("after_hit", "원한이 쌓인 일격!"))
    const finalDmg = Math.floor(rawDmg * comebackMult)
    dealDamage(finalDmg, multiplier, critical, tSlot, tPkmn)
    myPkmn.lastReceivedDamage = 0
    return { handled: true, damage: finalDmg }
  }

  if (moveInfo.reversal) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const hpRatio = myPkmn.hp / (myPkmn.maxHp ?? myPkmn.hp)
    const revMult = hpRatio <= 0.25 ? 2.0 : hpRatio <= 0.5 ? 1.5 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(Math.floor(rawDmg * revMult), multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: Math.floor(rawDmg * revMult) }
  }

  if (moveInfo.guts) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const gutsMult = myPkmn.status ? 1.2 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    if (myPkmn.status) logEntries.push(makeLog("after_hit", `${myPkmn.name}${josa(myPkmn.name, "은는")} 객기를 부렸다!`))
    dealDamage(Math.floor(rawDmg * gutsMult), multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: Math.floor(rawDmg * gutsMult) }
  }

  if (moveInfo.finisher) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const finMult = tPkmn.hp <= (tPkmn.maxHp ?? tPkmn.hp) * 0.5 ? 1.2 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(Math.floor(rawDmg * finMult), multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: Math.floor(rawDmg * finMult) }
  }

  if (moveInfo.rollout) {
    const rollState = myPkmn.rollState ?? { active: false, turn: 0 }
    const rollTurn  = rollState.active ? rollState.turn + 1 : 1
    const rollPower = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); myPkmn.rollState = { active: false, turn: 0 }; return { handled: true, damage: 0 } }
    const defTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    let mult = 1; for (const dt of defTypes) mult *= getTypeMultiplier(moves[moveName]?.type, dt)
    if (mult === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); myPkmn.rollState = { active: false, turn: 0 }; return { handled: true, damage: 0 } }
    const dmg = Math.floor(rollPower * mult)
    logEntries.push(makeLog("after_hit", `구르기 ${rollTurn}번째 (위력 ${rollPower})!`))
    dealDamage(dmg, mult, false, tSlot, tPkmn)
    if (tPkmn.hp <= 0 || rollTurn >= 3) { myPkmn.rollState = { active: false, turn: 0 } }
    else { myPkmn.rollState = { active: true, turn: rollTurn, targetSlot: tSlot } }
    return { handled: true, damage: dmg }
  }

  if (moveInfo.gyroBall) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const power = calcGyroBallPower(myPkmn, tPkmn)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, power)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage }
  }

  if (moveInfo.assistPower) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const power = calcAssistPower(myPkmn)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, power)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage }
  }

  if (moveInfo.multiHit) {
    const { min, max, fixedDamage } = moveInfo.multiHit
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const hits = Math.floor(Math.random() * (max - min + 1)) + min
    let totalDmg = 0, lastMult = 1
    for (let h = 0; h < hits; h++) {
      if (tPkmn.hp <= 0) break
      let dmg, critical = false, multiplier = 1
      if (fixedDamage !== undefined) {
        const defTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
        for (const dt of defTypes) multiplier *= getTypeMultiplier(moves[moveName]?.type, dt)
        dmg = multiplier === 0 ? 0 : Math.floor(fixedDamage * multiplier)
      } else {
        const r = calcDamage(myPkmn, moveName, tPkmn)
        dmg = r.damage; critical = r.critical; multiplier = r.multiplier
      }
      lastMult = multiplier
      if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); break }
      tPkmn.hp = Math.max(0, tPkmn.hp - dmg); totalDmg += dmg
      logEntries.push(makeLog("hit", "", { defender: tSlot }))
      logEntries.push(makeLog("hp",  "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
      if (critical) logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
      if (tPkmn.hp <= 0) { logEntries.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot })); break }
    }
    if (lastMult > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
    if (lastMult < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
    logEntries.push(makeLog("after_hit", `${hits}번 공격했다! (총 ${totalDmg} 데미지)`))
    return { handled: true, damage: totalDmg }
  }

  if (moveInfo.effect && moveInfo.effect.recoil) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    const recoil = Math.max(1, Math.floor(damage * moveInfo.effect.recoil))
    myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
    logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
    if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
    return { handled: true, damage }
  }

  if (moveInfo.bodyPress) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const baseDef    = myPkmn.defense ?? 3
    const defRankVal = getActiveRankVal(myPkmn, "def")
    const activeDef  = baseDef + defRankVal
    const move       = moves[moveName] ?? moves["바디프레스"]
    const dice       = rollD10()
    const defTypes   = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    let mult = 1
    for (const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
    if (mult === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    const atkTypes = Array.isArray(myPkmn.type) ? myPkmn.type : [myPkmn.type]
    const stab     = atkTypes.includes(move.type)
    const base     = (move.power ?? 40) + activeDef * 1.3 + dice
    const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
    const afterDef = Math.max(0, raw - (tPkmn.defense ?? 3) * 5)
    const defRankEne = getActiveRankVal(tPkmn, "def")
    const baseDmg  = Math.max(0, afterDef - defRankEne * 3)
    const screenMult = (tPkmn.lightScreenTurns ?? 0) > 0 && !move.breakBarrier ? 0.75 : 1.0
    const critRate = Math.min(100, (myPkmn.defense ?? 3) * 2)
    const critical = Math.random() * 100 < critRate
    const finalDmg = Math.floor(baseDmg * screenMult)
    const damage   = critical ? Math.floor(finalDmg * 1.5) : finalDmg
    dealDamage(damage, mult, critical, tSlot, tPkmn)
    return { handled: true, damage }
  }

  if (moveInfo.fixedDamage) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const defTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    let mult = 1
    for (const dt of defTypes) mult *= getTypeMultiplier(moves[moveName]?.type, dt)
    if (mult === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    const dmg = moveInfo.fixedDamage
    tPkmn.hp  = Math.max(0, tPkmn.hp - dmg)
    logEntries.push(makeLog("hit", "", { defender: tSlot }))
    logEntries.push(makeLog("hp",  "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
    logEntries.push(makeLog("after_hit", `${dmg} 데미지!`))
    if (tPkmn.hp <= 0) logEntries.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))
    return { handled: true, damage: dmg }
  }

  if (moveInfo.outrage) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const outrageInfo = moveInfo.outrage
    const state       = myPkmn.outrageState
    const isFirst     = !state?.active
    const maxTurn     = isFirst
      ? Math.floor(Math.random() * (outrageInfo.maxTurn - outrageInfo.minTurn + 1)) + outrageInfo.minTurn
      : state.maxTurn
    const currentTurn = isFirst ? 1 : state.turn
    const power       = outrageInfo.powers[Math.min(currentTurn - 1, outrageInfo.powers.length - 1)]
    const isLastTurn  = currentTurn >= maxTurn
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, power)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if (isLastTurn) {
      myPkmn.outrageState = null
      if (outrageInfo.confusion && (myPkmn.confusion ?? 0) <= 0) {
        myPkmn.confusion = Math.floor(Math.random() * 3) + 1
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 혼란에 빠졌다!`))
      }
    } else {
      myPkmn.outrageState = { active: true, turn: currentTurn + 1, maxTurn, moveName }
      if (!outrageInfo.confusion) {
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 소란을 피우고 있다!`))
      }
    }
    return { handled: true, damage }
  }

  if (moveInfo.clearSmog) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    tPkmn.ranks = defaultRanks()
    logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "의")} 능력 변화가 원래대로 돌아왔다!`))
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier > 0) dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: multiplier > 0 ? damage : 0 }
  }

  if (moveInfo.dragonTail) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if (tPkmn.hp > 0) {
      const tIdx   = data[`${tSlot}_active_idx`] ?? 0
      const tEntry = entries[tSlot]
      const benchAlive = tEntry.map((p, i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
      if (benchAlive.length > 0) {
        const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
        logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 튕겨나갔다!`))
        logEntries.push(makeLog("normal", `${tEntry[randIdx].name}${josa(tEntry[randIdx].name, "이가")} 나왔다!`))
        data[`${tSlot}_active_idx`] = randIdx
      }
    }
    return { handled: true, damage }
  }

  if (moveInfo.trickster) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, null, tPkmn.attack ?? 3)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    const finalDmg = Math.floor(damage * 0.7)
    dealDamage(finalDmg, multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: finalDmg }
  }

  if (moveInfo.sickPower) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const sickMult = tPkmn.status ? 1.2 : 1.0
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    if (sickMult > 1) logEntries.push(makeLog("after_hit", `${tPkmn.name}${josa(tPkmn.name, "의")} 상태이상이 약점이 됐다!`))
    dealDamage(Math.floor(damage * sickMult), multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: Math.floor(damage * sickMult) }
  }

  if (moveInfo.venomShock) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const vsMult = tPkmn.status === "독" ? 1.2 : 1.0
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    if (vsMult > 1) logEntries.push(makeLog("after_hit", `${tPkmn.name}${josa(tPkmn.name, "은는")} 독 상태라 피해가 커졌다!`))
    dealDamage(Math.floor(damage * vsMult), multiplier, critical, tSlot, tPkmn)
    return { handled: true, damage: Math.floor(damage * vsMult) }
  }

  if (moveInfo.throatChop) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if (tPkmn.hp > 0) {
      tPkmn.throatChopped = 2
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 목을 눌려 소리를 낼 수 없게 됐다!`))
    }
    return { handled: true, damage }
  }

  if (moveInfo.enchantedVoice) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if (tPkmn.hp > 0) {
      const eneRanks = tPkmn.ranks ?? {}
      const hasBuff  =
        ((eneRanks.atkTurns ?? 0) > 0 && (eneRanks.atk ?? 0) > 0) ||
        ((eneRanks.defTurns ?? 0) > 0 && (eneRanks.def ?? 0) > 0) ||
        ((eneRanks.spdTurns ?? 0) > 0 && (eneRanks.spd ?? 0) > 0)
      if (hasBuff && (tPkmn.confusion ?? 0) <= 0) {
        tPkmn.confusion = Math.floor(Math.random() * 3) + 1
        logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 혼란에 빠졌다!`))
      }
    }
    return { handled: true, damage }
  }

  if (moveInfo.pollenPuff) {
    const isFriendly = teamOf(mySlot) === teamOf(tSlot)
    if (isFriendly) {
      const heal = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.22))
      tPkmn.hp   = Math.min(tPkmn.maxHp ?? tPkmn.hp, tPkmn.hp + heal)
      logEntries.push(makeLog("hp",
        `${tPkmn.name}${josa(tPkmn.name, "은는")} 꽃가루를 받아 HP를 회복했다! (+${heal})`,
        { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }
      ))
      return { handled: true, damage: 0 }
    }
    return { handled: false, damage: 0 }
  }

  if (moveInfo.rapidSpin) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if (myPkmn.seeded) {
      myPkmn.seeded     = false
      myPkmn.seederSlot = null
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 씨뿌리기가 풀렸다!`))
    }
    if (moveInfo.rank) applyRankChanges(moveInfo.rank, myPkmn, tPkmn, null, logEntries)
    return { handled: true, damage }
  }

  if (moveInfo.breakBarrier) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { missLog(hitType); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); return { handled: true, damage: 0 } }
    dealDamage(damage, multiplier, critical, tSlot, tPkmn)
    if ((tPkmn.lightScreenTurns ?? 0) > 0) {
      tPkmn.lightScreenTurns = 0
      logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "의")} 빛의 장막이 깨졌다!`))
    }
    return { handled: true, damage }
  }

  if (moveInfo.lastResort) {
    const usedMoves  = myPkmn.usedMoves ?? []
    const otherMoves = (myPkmn.moves ?? []).filter(m => m.name !== moveName)
    const allUsed    = otherMoves.every(m => usedMoves.includes(m.name)) && usedMoves.length > 0
    if (!allUsed) { logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 아직 다른 기술을 쓰지 않았다!`)); return { handled: true, damage: 0 } }
    return { handled: false, damage: 0 }
  }

  return { handled: false, damage: 0 }
}

// ── 씨뿌리기 EOT ──────────────────────────────────────────────────
async function applyLeechSeedEot(entries, data, logEntries) {
  for (const tSlot of ALL_FS) {
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || !tPkmn.seeded || tPkmn.hp <= 0) continue
    const seederSlot = tPkmn.seederSlot
    if (!seederSlot) continue
    const sIdx  = data[`${seederSlot}_active_idx`] ?? 0
    const sPkmn = entries[seederSlot][sIdx]
    const dmg   = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.1))
    tPkmn.hp    = Math.max(0, tPkmn.hp - dmg)
    logEntries.push(makeLog("normal", `씨뿌리기가 ${tPkmn.name}${josa(tPkmn.name, "의")} 체력을 빼앗는다!`))
    logEntries.push(makeLog("hp", "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
    if (sPkmn && sPkmn.hp > 0) {
      sPkmn.hp = Math.min(sPkmn.maxHp ?? sPkmn.hp, sPkmn.hp + dmg)
      logEntries.push(makeLog("hp", `${sPkmn.name}${josa(sPkmn.name, "은는")} 체력을 흡수했다! (+${dmg})`, { slot: seederSlot, hp: sPkmn.hp, maxHp: sPkmn.maxHp }))
    }
    if (tPkmn.hp <= 0) logEntries.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))
  }
}

// ── 공중날기/구멍파기/고스트다이브 2턴째 공통 처리 ──────────────
function handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, opts = {}) {
  const { moveName, accuracy } = opts
  const tIdx  = data[`${targetSlot}_active_idx`] ?? 0
  const ePkmn = entries[targetSlot][tIdx]
  if (!ePkmn || ePkmn.hp <= 0) {
    logEntries.push(makeLog("normal", `상대가 이미 쓰러져서 공격할 수 없다!`))
    return
  }
  const wasDefending = ePkmn.defending ?? false
  ePkmn.defending = false; ePkmn.defendTurns = 0
  if (wasDefending) {
    logEntries.push(makeLog("normal", `${ePkmn.name}${josa(ePkmn.name, "은는")} 방어했다!`))
    return
  }
  const { hit, hitType } = calcHit(myPkmn, { accuracy: accuracy ?? 95, alwaysHit: false }, ePkmn)
  if (!hit) {
    logEntries.push(makeLog("normal", hitType === "evaded" ? `${ePkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
    return
  }
  const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, ePkmn)
  if (multiplier === 0) { logEntries.push(makeLog("normal", `${ePkmn.name}에게는 효과가 없다…`)); return }
  ePkmn.hp = Math.max(0, ePkmn.hp - damage)
  if (ePkmn.hp <= 0 && ePkmn.enduring) { ePkmn.hp = 1; ePkmn.enduring = false }
  logEntries.push(makeLog("hit", "", { defender: targetSlot }))
  logEntries.push(makeLog("hp",  "", { slot: targetSlot, hp: ePkmn.hp, maxHp: ePkmn.maxHp }))
  if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
  if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
  if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
  if (ePkmn.hp <= 0)  logEntries.push(makeLog("faint", `${ePkmn.name}${josa(ePkmn.name, "은는")} 쓰러졌다!`, { slot: targetSlot }))
}

// ── finishTurn ────────────────────────────────────────────────────
async function finishTurn(roomRef, roomId, data, entries, logEntries, update = {}) {
  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)
  const newOrder = (data.current_order ?? []).slice(1)
  const finalUpdate = {
    ...buildEntryUpdate(entries),
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...(assistEventTs !== null ? { assist_event: { ts: assistEventTs } } : {}),
    ...(syncEventTs   !== null ? { sync_event:   { ts: syncEventTs   } } : {}),
    ...update,
  }
  ALL_FS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) finalUpdate[`${s}_active_idx`] = data[`${s}_active_idx`]
  })
  ;["A","B"].forEach(team => {
    ;["stealth_rock","toxic_spikes"].forEach(f => {
      const k = `field_${team}_${f}`
      if (data[k] !== undefined) finalUpdate[k] = data[k]
    })
  })
  const winTeam = checkWin(entries)
  if (winTeam) {
    finalUpdate.game_over      = true
    finalUpdate.winner_team    = winTeam
    finalUpdate.current_order  = []
    finalUpdate.turn_started_at = null
  }
  await roomRef.update(finalUpdate)
  return winTeam
}

// ════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, moveIdx, targetSlots } = req.body
  if (!roomId || !mySlot || moveIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })
  if (!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const entries     = deepCopyEntries(data)
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = entries[mySlot][myActiveIdx]
  myPkmn._slot      = mySlot
  if (myPkmn.hp <= 0) return res.status(403).json({ error: "포켓몬 기절 상태" })

  const moveData = myPkmn.moves?.[moveIdx]
  if (!moveData || moveData.pp <= 0) return res.status(403).json({ error: "사용 불가 기술" })

  if (myPkmn.chainBound && moveData.name === myPkmn.chainBound.moveName)
    return res.status(403).json({ error: "사슬묶기로 사용 불가" })

  // ── 트집 서버 체크 ────────────────────────────────────────────
  if (myPkmn.tormented && moveData.name === myPkmn.lastUsedMove)
    return res.status(403).json({ error: "트집으로 사용 불가" })

  const myTeam    = teamOf(mySlot)
  const assistKey = `assist_team${myTeam}`
  const assist    = data[assistKey] ?? null
  const isRequester      = assist && assist.requester === mySlot
  const supporterSlot    = isRequester ? assist.supporter : null
  let assistUsedThisTurn = false
  const activatedSyncKeys = new Set()
  const logEntries   = []
  const assistUpdate = {}
  const syncUpdate   = {}

  // ── tickVolatiles ─────────────────────────────────────────────
  {
    const volatileMsgs = tickVolatiles(myPkmn)
    volatileMsgs.forEach(m => logEntries.push(makeLog("normal", m)))
  }

  // ── 공중날기 2턴째 ────────────────────────────────────────────
  if (myPkmn.flyState?.flying) {
    myPkmn.flyState = null
    const targetSlot = myPkmn._flyTargetSlot ?? (targetSlots?.[0] ?? null)
    myPkmn._flyTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 내려꽂는다!`))
    if (!targetSlot) {
      logEntries.push(makeLog("normal", `그러나 공격할 대상이 없다!`))
    } else {
      handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, {
        moveName: myPkmn.flyMoveName ?? "공중날기",
        accuracy: 95,
      })
    }
    myPkmn.flyMoveName = null
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 구멍파기 2턴째 ────────────────────────────────────────────
  if (myPkmn.digState?.digging) {
    myPkmn.digState = null
    const targetSlot = myPkmn._digTargetSlot ?? (targetSlots?.[0] ?? null)
    myPkmn._digTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 땅속에서 튀어나왔다!`))
    if (!targetSlot) {
      logEntries.push(makeLog("normal", `그러나 공격할 대상이 없다!`))
    } else {
      handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, {
        moveName: myPkmn.digMoveName ?? "구멍파기",
        accuracy: 100,
      })
    }
    myPkmn.digMoveName = null
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 고스트다이브 2턴째 ────────────────────────────────────────
  if (myPkmn.ghostDiveState?.diving) {
    myPkmn.ghostDiveState = null
    const targetSlot = myPkmn._ghostDiveTargetSlot ?? (targetSlots?.[0] ?? null)
    myPkmn._ghostDiveTargetSlot = null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}${josa(myPkmn.name, "은는")} 나타났다!`))
    if (!targetSlot) {
      logEntries.push(makeLog("normal", `그러나 공격할 대상이 없다!`))
    } else {
      handleTwoTurnAttack(myPkmn, mySlot, targetSlot, entries, data, logEntries, {
        moveName: myPkmn.ghostDiveMoveName ?? "고스트다이브",
        accuracy: 100,
      })
    }
    myPkmn.ghostDiveMoveName = null
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 하이퍼빔 다음 턴 강제 스킵 ──────────────────────────────
  if (myPkmn.hyperBeamState) {
    myPkmn.hyperBeamState = false
    logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 움직일 수 없다!`))
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 참기 자동처리 ─────────────────────────────────────────────
  if (myPkmn.bideState) {
    myPkmn.bideState.turnsLeft--
    if (myPkmn.bideState.turnsLeft > 0) {
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참고 있다...`))
    } else {
      logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참고 있다...`))
      const bide = myPkmn.bideState
      myPkmn.bideState = null
      if (!bide || bide.damage <= 0) {
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참기 발사에 실패했다!`))
      } else {
        const bideDmg      = bide.damage * 2
        const attackerSlot = bide.lastAttackerSlot ?? null
        logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 참았던 에너지를 방출했다!`))
        if (!attackerSlot) {
          logEntries.push(makeLog("normal", `그러나 공격할 대상이 없다!`))
        } else {
          const eIdx  = data[`${attackerSlot}_active_idx`] ?? 0
          const ePkmn = entries[attackerSlot][eIdx]
          if (!ePkmn || ePkmn.hp <= 0) {
            logEntries.push(makeLog("normal", `그러나 ${ePkmn?.name ?? "상대"}${josa(ePkmn?.name ?? "상대", "은는")} 이미 쓰러졌다!`))
          } else {
            ePkmn.hp = Math.max(0, ePkmn.hp - bideDmg)
            logEntries.push(makeLog("hit", "", { defender: attackerSlot }))
            logEntries.push(makeLog("hp",  "", { slot: attackerSlot, hp: ePkmn.hp, maxHp: ePkmn.maxHp }))
            logEntries.push(makeLog("after_hit", `${bideDmg} 데미지!`))
            if (ePkmn.hp <= 0) logEntries.push(makeLog("faint", `${ePkmn.name}${josa(ePkmn.name, "은는")} 쓰러졌다!`, { slot: attackerSlot }))
          }
        }
      }
    }
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 구르기 자동처리 ───────────────────────────────────────────
  if (myPkmn.rollState?.active) {
    const rollState  = myPkmn.rollState
    const rollTurn   = rollState.turn + 1
    const rollPower  = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
    const targetSlot = rollState.targetSlot ?? null
    logEntries.push(makeLog("move_announce", `${myPkmn.name}의 구르기! (${rollTurn}번째)`))
    if (!targetSlot) {
      logEntries.push(makeLog("normal", `구르기가 캔슬됐다!`))
      myPkmn.rollState = { active: false, turn: 0 }
    } else {
      const eIdx  = data[`${targetSlot}_active_idx`] ?? 0
      const ePkmn = entries[targetSlot][eIdx]
      if (!ePkmn || ePkmn.hp <= 0) {
        logEntries.push(makeLog("normal", `${ePkmn?.name ?? "상대"}${josa(ePkmn?.name ?? "상대", "은는")} 이미 쓰러져서 구르기가 캔슬됐다!`))
        myPkmn.rollState = { active: false, turn: 0 }
      } else {
        const { hit, hitType } = calcHit(myPkmn, { accuracy: 90, alwaysHit: false }, ePkmn)
        if (!hit) {
          logEntries.push(makeLog("normal", hitType === "evaded" ? `${ePkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
          myPkmn.rollState = { active: false, turn: 0 }
        } else {
          const defTypes = Array.isArray(ePkmn.type) ? ePkmn.type : [ePkmn.type]
          let mult = 1; for (const dt of defTypes) mult *= getTypeMultiplier("바위", dt)
          if (mult === 0) { logEntries.push(makeLog("normal", `${ePkmn.name}에게는 효과가 없다…`)); myPkmn.rollState = { active: false, turn: 0 } }
          else {
            const dmg = Math.floor(rollPower * mult)
            ePkmn.hp = Math.max(0, ePkmn.hp - dmg)
            logEntries.push(makeLog("hit", "", { defender: targetSlot }))
            logEntries.push(makeLog("hp",  "", { slot: targetSlot, hp: ePkmn.hp, maxHp: ePkmn.maxHp }))
            logEntries.push(makeLog("after_hit", `구르기 ${rollTurn}번째 (${rollPower} 데미지)!`))
            if (ePkmn.hp <= 0) { logEntries.push(makeLog("faint", `${ePkmn.name}${josa(ePkmn.name, "은는")} 쓰러졌다!`, { slot: targetSlot })); myPkmn.rollState = { active: false, turn: 0 } }
            else { myPkmn.rollState = rollTurn >= 3 ? { active: false, turn: 0 } : { active: true, turn: rollTurn, targetSlot } }
          }
        }
      }
    }
    const winTeam = await finishTurn(roomRef, roomId, data, entries, logEntries)
    return res.status(200).json({ ok: true, ...(winTeam ? { winTeam } : {}) })
  }

  // ── 일반 기술 처리 ────────────────────────────────────────────
  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

  if (!pre.blocked) {
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logEntries.push(makeLog("normal", m)))

    if (!conf.selfHit) {
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }
      myPkmn.lastUsedMove   = moveData.name
      if (!myPkmn.usedMoves) myPkmn.usedMoves = []
      if (!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      const moveInfo = moves[moveData.name]
      if (moveInfo) moveInfo._name = moveData.name
      logEntries.push(makeLog("move_announce", `${myPkmn.name}의 ${moveData.name}!`))

      const tSlots = targetSlots ?? []

      if (!moveInfo?.power) {
        // ── 비공격 기술
        const specialResult = handleSpecialNonAttack(moveInfo, moveData.name, myPkmn, mySlot, tSlots, entries, data, logEntries)

        if (!specialResult.handled) {
          const r            = moveInfo?.rank
          const targetsEnemy = (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))
            || moveInfo?.targetSelf === false

          if (tSlots.length > 0) {
            for (const tSlot of tSlots) {
              const tIdx  = data[`${tSlot}_active_idx`] ?? 0
              const tPkmn = entries[tSlot][tIdx]
              if (!tPkmn || tPkmn.hp <= 0) continue
              if (targetsEnemy) {
                const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
                if (!hit) { logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)); continue }
              }
              applyRankChanges(r ?? null, myPkmn, tPkmn, moveData.name, logEntries)
              applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, 0).forEach(m => logEntries.push(makeLog("normal", m)))
            }
          } else {
            if (moveInfo?.targetSelf === false) {
              logEntries.push(makeLog("normal", `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
            } else {
              if (!moveInfo?.alwaysHit && Math.random() * 100 >= (moveInfo?.accuracy ?? 100)) {
                logEntries.push(makeLog("normal", `그러나 ${myPkmn.name}의 기술은 실패했다!`))
              } else {
                applyRankChanges(r ?? null, myPkmn, myPkmn, moveData.name, logEntries)
                applyMoveEffect(moveInfo?.effect, myPkmn, myPkmn, 0).forEach(m => logEntries.push(makeLog("normal", m)))
              }
            }
          }
        }

      } else {
        // ── 공격 기술
        resetRankStack(myPkmn)
        myPkmn.lastDefendMove = null; myPkmn.defendStack = 0

        const isAoe   = tSlots.length >= 2
        const aoeDice = isAoe ? rollD10() : null
        if (isAoe) logEntries.push(makeLog("dice", "", { slot: mySlot, roll: aoeDice }))

        for (const tSlot of tSlots) {
          const tIdx  = data[`${tSlot}_active_idx`] ?? 0
          const tPkmn = entries[tSlot][tIdx]
          if (!tPkmn || tPkmn.hp <= 0) continue

          if (tPkmn.defending) {
            logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "은는")} 방어했다!`))
            if (moveInfo?.jumpKick) {
              const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
              myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
              logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${selfDmg} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
              if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
            }
            tPkmn.defending   = false
            tPkmn.defendTurns = 0
            continue
          }

          const specialAtk = handleSpecialAttack(moveInfo, moveData.name, myPkmn, mySlot, tSlot, tPkmn, entries, data, logEntries)
          if (specialAtk.handled) continue

          const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
          if (!hit) {
            logEntries.push(makeLog("normal", hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`))
            if (moveInfo?.jumpKick) {
              const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
              myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
              logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${selfDmg} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
              if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
            }
            continue
          }

          let powerOverride = null
          if (moveInfo?.gyroBall)    powerOverride = calcGyroBallPower(myPkmn, tPkmn)
          if (moveInfo?.assistPower) powerOverride = calcAssistPower(myPkmn)
          if (moveInfo?.waterspout) {
            const hpRatio = myPkmn.hp / (myPkmn.maxHp ?? myPkmn.hp)
            if      (hpRatio <= 0.2) powerOverride = 30
            else if (hpRatio <= 0.5) powerOverride = 40
            else if (hpRatio <= 0.7) powerOverride = 50
            else if (hpRatio <= 0.9) powerOverride = 60
            else                     powerOverride = 70
          }

          let { damage, multiplier, critical, dice } = calcDamage(myPkmn, moveData.name, tPkmn, powerOverride, null, aoeDice)
          if (!isAoe) logEntries.push(makeLog("dice", "", { slot: mySlot, roll: dice }))
          if (multiplier === 0) { logEntries.push(makeLog("normal", `${tPkmn.name}에게는 효과가 없다…`)); continue }

          if (isRequester) { damage = Math.floor(damage * 1.15); assistUsedThisTurn = true }

          const tTeam        = teamOf(tSlot)
          const syncKey      = `sync_team${tTeam}`
          const sync         = data[syncKey] ?? null
          const tIsInSync    = sync && (sync.requester === tSlot || sync.supporter === tSlot)
          const syncAllySlot = tIsInSync ? (sync.requester === tSlot ? sync.supporter : sync.requester) : null
          const syncAllyPkmn = syncAllySlot ? entries[syncAllySlot]?.[data[`${syncAllySlot}_active_idx`] ?? 0] : null

          let mainDmg = damage, spillDmg = 0
          if (tIsInSync && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            activatedSyncKeys.add(syncKey)
            logEntries.push(makeLog("sync", ""))
            if (isAoe) {
              mainDmg = Math.max(1, Math.floor(damage * 0.75))
              logEntries.push(makeLog("after_hit", `💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name, "은는")} 피해를 분산했다! (×0.75)`))
            } else {
              mainDmg  = Math.max(1, Math.floor(damage * 0.60))
              spillDmg = Math.max(1, Math.floor(damage * 0.40))
              logEntries.push(makeLog("after_hit", `💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name, "과와")} ${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "이가")} 피해를 분산했다!`))
            }
          }

          if (tPkmn.enduring && mainDmg >= tPkmn.hp) { mainDmg = tPkmn.hp - 1; logEntries.push(makeLog("after_hit", `${tPkmn.name}${josa(tPkmn.name, "은는")} 버텼다!`)) }
          tPkmn.enduring = false
          tPkmn.hp = Math.max(0, tPkmn.hp - mainDmg)

          logEntries.push(makeLog("hit", "", { defender: tSlot }))
          logEntries.push(makeLog("hp",  "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
          if (multiplier > 1) logEntries.push(makeLog("after_hit", "효과가 굉장했다!"))
          if (multiplier < 1) logEntries.push(makeLog("after_hit", "효과가 별로인 듯하다…"))
          if (critical)       logEntries.push(makeLog("after_hit", "급소에 맞았다!"))
          if (isRequester && assistUsedThisTurn) logEntries.push(makeLog("after_hit", "어시스트 효과로 위력이 올라갔다!"))

          if (moveInfo?.breakBarrier && (tPkmn.lightScreenTurns ?? 0) > 0) {
            tPkmn.lightScreenTurns = 0
            logEntries.push(makeLog("normal", `${tPkmn.name}${josa(tPkmn.name, "의")} 빛의 장막이 깨졌다!`))
          }

          if (moveInfo?.rapidSpin && myPkmn.seeded) {
            myPkmn.seeded     = false
            myPkmn.seederSlot = null
            logEntries.push(makeLog("normal", `${myPkmn.name}${josa(myPkmn.name, "은는")} 씨뿌리기가 풀렸다!`))
          }

          applyMoveEffect({ ...moveInfo?.effect, drain: 0 }, myPkmn, tPkmn, mainDmg).forEach(m => logEntries.push(makeLog("normal", m)))
          if (moveInfo?.rank) applyRankChanges(moveInfo.rank, myPkmn, tPkmn, null, logEntries)

          if (moveInfo?.effect?.drain && mainDmg > 0) {
            const heal = Math.max(1, Math.floor(mainDmg * moveInfo.effect.drain))
            myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
            logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 체력을 흡수했다! (+${heal})`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
          }
          if (moveInfo?.effect?.recoil && mainDmg > 0) {
            const recoil = Math.max(1, Math.floor(mainDmg * moveInfo.effect.recoil))
            myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
            logEntries.push(makeLog("hp", `${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil} 데미지를 입었다!`, { slot: mySlot, hp: myPkmn.hp, maxHp: myPkmn.maxHp }))
            if (myPkmn.hp <= 0) logEntries.push(makeLog("faint", `${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`, { slot: mySlot }))
          }

          if (tPkmn.hp <= 0) logEntries.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))

          if (spillDmg > 0 && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            if (syncAllyPkmn.enduring && spillDmg >= syncAllyPkmn.hp) { spillDmg = syncAllyPkmn.hp - 1; logEntries.push(makeLog("after_hit", `${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "은는")} 버텼다!`)) }
            syncAllyPkmn.enduring = false
            syncAllyPkmn.hp = Math.max(0, syncAllyPkmn.hp - spillDmg)
            logEntries.push(makeLog("hit", "", { defender: syncAllySlot }))
            logEntries.push(makeLog("hp",  "", { slot: syncAllySlot, hp: syncAllyPkmn.hp, maxHp: syncAllyPkmn.maxHp }))
            logEntries.push(makeLog("after_hit", `${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "도")} ${spillDmg}의 피해를 받았다!`))
            if (syncAllyPkmn.hp <= 0) logEntries.push(makeLog("faint", `${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "은는")} 쓰러졌다!`, { slot: syncAllySlot }))
          }

          if (isRequester && assistUsedThisTurn && supporterSlot && teamOf(tSlot) !== myTeam) {
            const supPkmn = entries[supporterSlot]?.[data[`${supporterSlot}_active_idx`] ?? 0]
            if (supPkmn && supPkmn.hp > 0 && tPkmn.hp > 0) {
              logEntries.push(makeLog("assist", ""))
              const bonusDmg = Math.max(1, Math.floor(damage * 0.3))
              tPkmn.hp = Math.max(0, tPkmn.hp - bonusDmg)
              logEntries.push(makeLog("hit",      "", { defender: tSlot }))
              logEntries.push(makeLog("hp",       "", { slot: tSlot, hp: tPkmn.hp, maxHp: tPkmn.maxHp }))
              logEntries.push(makeLog("after_hit", `${supPkmn.name}${josa(supPkmn.name, "이가")} 연속으로 추가 공격했다! (${bonusDmg} 데미지)`))
              if (tPkmn.hp <= 0) logEntries.push(makeLog("faint", `${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`, { slot: tSlot }))
            }
          }

          tPkmn.lastReceivedDamage = mainDmg
          if (tPkmn.bideState) { tPkmn.bideState.damage = (tPkmn.bideState.damage ?? 0) + mainDmg; tPkmn.bideState.lastAttackerSlot = mySlot }
        }
      }

      // ── 하이퍼빔 사용 후 다음 턴 재충전 플래그
      if (moveInfo?.hyperBeam) {
        myPkmn.hyperBeamState = true
      }

      // ── 유턴: 공격 후 강제 교체
      if (moveInfo?.uTurn) {
        const canSwitch   = (entries[mySlot] ?? []).some((p, i) => i !== myActiveIdx && p.hp > 0)
        const uTurnTarget = tSlots[0]
        const uTurnPkmn   = uTurnTarget ? entries[uTurnTarget]?.[data[`${uTurnTarget}_active_idx`] ?? 0] : null
        if (canSwitch) {
          const { assistEventTs: utAts, syncEventTs: utSts } = await writeLogs(roomId, logEntries)
          const fieldUpdate = {}
          ;["A","B"].forEach(team => {
            ;["stealth_rock","toxic_spikes"].forEach(f => {
              const k = `field_${team}_${f}`
              if (data[k] !== undefined) fieldUpdate[k] = data[k]
            })
          })
          await roomRef.update({
            ...buildEntryUpdate(entries),
            ...assistUpdate,
            ...syncUpdate,
            ...fieldUpdate,
            current_order:   (data.current_order ?? []).slice(1),
            turn_count:      (data.turn_count ?? 1) + 1,
            turn_started_at: Date.now(),
            [`force_switch_${mySlot}`]: true,
            ...(utAts !== null ? { assist_event: { ts: utAts } } : {}),
            ...(utSts !== null ? { sync_event:   { ts: utSts } } : {}),
          })
          return res.status(200).json({ ok: true })
        }
      }

    }  // if (!conf.selfHit) 끝

    clearRankStack(myPkmn)
    if ((myPkmn.defendTurns ?? 0) > 0) {
      myPkmn.defendTurns--
      if (myPkmn.defendTurns <= 0) { myPkmn.defending = false; myPkmn.defendTurns = 0 }
    }
  }  // if (!pre.blocked) 끝

  if (isRequester) {
    assistUpdate[assistKey]               = null
    assistUpdate[`assist_used_${myTeam}`] = true
    if (!assistUsedThisTurn) logEntries.push(makeLog("normal", "어시스트 효과가 사라졌다..."))
  }
  activatedSyncKeys.forEach(k => {
    const team = k.replace("sync_team", "")
    syncUpdate[k] = null; syncUpdate[`sync_used_${team}`] = true
  })

  const newOrder     = (data.current_order ?? []).slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0

  if (isEot) {
    ALL_FS.forEach(s => {
      const idx  = data[`${s}_active_idx`] ?? 0
      const pkmn = entries[s][idx]
      if (!pkmn) return
      tickRanks(pkmn, logEntries)
      if (pkmn.chainBound) {
        pkmn.chainBound.turnsLeft--
        if (pkmn.chainBound.turnsLeft <= 0) {
          pkmn.chainBound = null
          logEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 사슬묶기가 풀렸다!`))
        }
      }
    })
  }

  const { assistEventTs, syncEventTs } = await writeLogs(roomId, logEntries)

  const update = {
    ...buildEntryUpdate(entries),
    ...assistUpdate,
    ...syncUpdate,
    current_order:   newOrder,
    turn_count:      newTurnCount,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
    ...(assistEventTs !== null ? { assist_event: { ts: assistEventTs } } : {}),
    ...(syncEventTs   !== null ? { sync_event:   { ts: syncEventTs   } } : {}),
  }

  ALL_FS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  ;["A","B"].forEach(team => {
    ;["stealth_rock","toxic_spikes"].forEach(f => {
      const k = `field_${team}_${f}`
      if (data[k] !== undefined) update[k] = data[k]
    })
  })

  const winTeam = checkWin(entries)
  if (winTeam) {
    update.game_over       = true
    update.winner_team     = winTeam
    update.current_order   = []
    update.turn_started_at = null
    await roomRef.update(update)
    return res.status(200).json({ ok: true, winTeam })
  }

  if (isEot) {
    const eotLogEntries = []
    await applyLeechSeedEot(entries, data, eotLogEntries)

    // 아쿠아링/저주/회복봉인/목조르기 직접 처리
    ALL_FS.forEach(s => {
      const idx  = data[`${s}_active_idx`] ?? 0
      const pkmn = entries[s][idx]
      if (!pkmn || pkmn.hp <= 0) return

      if (pkmn.aquaRing) {
        const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.0625))
        pkmn.hp = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
        eotLogEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 아쿠아링으로 HP를 회복했다! (+${heal})`))
        eotLogEntries.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
      }

      if (pkmn.cursed && pkmn.hp > 0) {
        const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.25))
        pkmn.hp = Math.max(0, pkmn.hp - dmg)
        eotLogEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 저주 때문에 ${dmg} 데미지를 입었다!`))
        eotLogEntries.push(makeLog("hp", "", { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp }))
        if (pkmn.hp <= 0) eotLogEntries.push(makeLog("faint", `${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`, { slot: s }))
      }

      if ((pkmn.healBlocked ?? 0) > 0) {
        pkmn.healBlocked--
        if (!pkmn.healBlocked)
          eotLogEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "의")} 회복봉인이 풀렸다!`))
      }

      if ((pkmn.throatChopped ?? 0) > 0) {
        pkmn.throatChopped--
        if (!pkmn.throatChopped)
          eotLogEntries.push(makeLog("normal", `${pkmn.name}${josa(pkmn.name, "은는")} 다시 소리를 낼 수 있게 됐다!`))
      }
    })

    if (eotLogEntries.length > 0) {
      Object.assign(update, buildEntryUpdate(entries))
      const logsRef = db.collection("double").doc(roomId).collection("logs")
      const base    = Date.now()
      const batch   = db.batch()
      eotLogEntries.forEach((entry, i) => batch.set(logsRef.doc(), { ...entry, ts: base + i }))
      await batch.commit()
    }
    const win = await handleEot(db, roomId, entries, data, update)
    if (win) { await roomRef.update(update); return res.status(200).json({ ok: true, winTeam: win }) }
  }
}