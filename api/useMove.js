import { db } from "../lib/firestore.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, applyEndOfTurnDamage, getStatusSpdPenalty
} from "../lib/effecthandler.js"
import {
  ALL_FS, deepCopyEntries, buildEntryUpdate, checkWin, collectFaintedSlots,
  teamOf, allySlot, roomName, rollD10, getActiveRank, writeLogs, corsHeaders,
  handleEot
} from "../lib/gameUtils.js"

function defaultRanks(pokemon) {
  if(!pokemon) return { atk:0, atkTurns:0, def:0, defTurns:0, spd:0, spdTurns:0 }
  return {
    atk: pokemon.attack  ?? 3, atkTurns: 0,
    def: pokemon.defense ?? 3, defTurns: 0,
    spd: pokemon.speed   ?? 3, spdTurns: 0,
  }
}

// 현재 유효한 스탯값 반환 (턴 남아있으면 랭크값, 아니면 기본 스탯)
function getActiveStat(pokemon, key) {
  const r   = pokemon.ranks ?? {}
  const raw = pokemon[key === "atk" ? "attack" : key === "def" ? "defense" : "speed"] ?? 3
  return (r[`${key}Turns`] ?? 0) > 0 ? (r[key] ?? raw) : raw
}

function resetRankStack(pokemon) {
  pokemon.lastRankMove = null
  pokemon.rankStack    = 0
  if(pokemon.ranks) {
    pokemon.ranks.atk = pokemon.attack  ?? 3; pokemon.ranks.atkTurns = 0
    pokemon.ranks.def = pokemon.defense ?? 3; pokemon.ranks.defTurns = 0
    pokemon.ranks.spd = pokemon.speed   ?? 3; pokemon.ranks.spdTurns = 0
  }
}

function clearRankStack(pokemon) {
  pokemon.lastRankMove = null
  pokemon.rankStack    = 0
}

function tickRanks(pokemon, logs) {
  if(!pokemon.ranks) return
  const r = pokemon.ranks
  if(r.atkTurns > 0) { r.atkTurns--; if(!r.atkTurns) { r.atk = pokemon.attack  ?? 3; logs.push(`${pokemon.name}의 공격이 원래대로 돌아왔다!`) } }
  if(r.defTurns > 0) { r.defTurns--; if(!r.defTurns) { r.def = pokemon.defense ?? 3; logs.push(`${pokemon.name}의 방어가 원래대로 돌아왔다!`) } }
  if(r.spdTurns > 0) { r.spdTurns--; if(!r.spdTurns) { r.spd = pokemon.speed   ?? 3; logs.push(`${pokemon.name}의 스피드가 원래대로 돌아왔다!`) } }
}

function applyRankChanges(r, self, target, moveName) {
  if(!r) return []
  const msgs = []
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if(!roll) return []

  const getStat = (p, key) => p[key === "atk" ? "attack" : key === "def" ? "defense" : "speed"] ?? 3
  const getR    = (p, key) => {
    const rr = p.ranks ?? {}
    return (rr[`${key}Turns`] ?? 0) > 0 ? (rr[key] ?? getStat(p, key)) : getStat(p, key)
  }

  const selfR   = {
    atk: getR(self, "atk"),    atkTurns: (self.ranks ?? {}).atkTurns ?? 0,
    def: getR(self, "def"),    defTurns: (self.ranks ?? {}).defTurns ?? 0,
    spd: getR(self, "spd"),    spdTurns: (self.ranks ?? {}).spdTurns ?? 0,
  }
  const targetR = {
    atk: getR(target, "atk"), atkTurns: (target.ranks ?? {}).atkTurns ?? 0,
    def: getR(target, "def"), defTurns: (target.ranks ?? {}).defTurns ?? 0,
    spd: getR(target, "spd"), spdTurns: (target.ranks ?? {}).spdTurns ?? 0,
  }

  // 랭크 스택 (같은 기술 3회 연속 시 리셋)
  if(moveName) {
    const isSame = self.lastRankMove === moveName
    const stack  = self.rankStack ?? 0
    if(!isSame) { self.lastRankMove = moveName; self.rankStack = 1 }
    else if(stack >= 2) {
      selfR.atk = getStat(self, "atk"); selfR.atkTurns = 0
      selfR.def = getStat(self, "def"); selfR.defTurns = 0
      selfR.spd = getStat(self, "spd"); selfR.spdTurns = 0
      self.rankStack = 1
    } else { self.rankStack = stack + 1 }
  }

  const MIN = 1, MAX_MULT = 3

  function applyOne(obj, key, delta, baseStat, name) {
    const label = key === "atk" ? "공격" : key === "def" ? "방어" : "스피드"
    const max   = baseStat * MAX_MULT
    if(delta > 0) {
      const p = obj[key]; obj[key] = Math.min(max, obj[key] + delta); obj[`${key}Turns`] = r.turns ?? 2
      msgs.push(`${name}의 ${label}이 ${obj[key] - p} 상승했다!`)
    } else if(delta < 0) {
      if(obj[key] <= MIN) msgs.push(`${name}의 ${label}은 더 이상 내려가지 않는다!`)
      else { const p = obj[key]; obj[key] = Math.max(MIN, obj[key] + delta); obj[`${key}Turns`] = r.turns ?? 2; msgs.push(`${name}의 ${label}이 ${p - obj[key]} 하락했다!`) }
    }
  }

  if(r.atk       !== undefined) applyOne(selfR,   "atk", r.atk,       getStat(self,   "atk"), self.name)
  if(r.def       !== undefined) applyOne(selfR,   "def", r.def,       getStat(self,   "def"), self.name)
  if(r.spd       !== undefined) applyOne(selfR,   "spd", r.spd,       getStat(self,   "spd"), self.name)
  if(r.targetAtk !== undefined) applyOne(targetR, "atk", r.targetAtk, getStat(target, "atk"), target.name)
  if(r.targetDef !== undefined) applyOne(targetR, "def", r.targetDef, getStat(target, "def"), target.name)
  if(r.targetSpd !== undefined) applyOne(targetR, "spd", r.targetSpd, getStat(target, "spd"), target.name)

  self.ranks   = selfR
  target.ranks = targetR
  return msgs
}

function calcHit(atk, moveInfo, def) {
  if(Math.random()*100 >= (moveInfo.accuracy ?? 100)) return { hit:false, hitType:"missed" }
  if(moveInfo.alwaysHit || moveInfo.skipEvasion)       return { hit:true,  hitType:"hit" }
  const as = Math.max(1, getActiveStat(atk, "spd") - getStatusSpdPenalty(atk))
  const ds = Math.max(1, getActiveStat(def, "spd") - getStatusSpdPenalty(def))
  const ev = Math.min(99, Math.max(0, 5*(ds-as)))
  return Math.random()*100 < ev ? { hit:false, hitType:"evaded" } : { hit:true, hitType:"hit" }
}

// atkRank, defRank는 getActiveStat으로 뽑은 실제 스탯값
function calcDamage(atk, moveName, def, powerOverride=null, atkStatOverride=null) {
  const move = moves[moveName]
  if(!move) return { damage:0, multiplier:1, stab:false, critical:false, dice:0 }
  const dice     = rollD10()
  const defTypes = Array.isArray(def.type) ? def.type : [def.type]
  let mult = 1
  for(const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if(mult === 0) return { damage:0, multiplier:0, stab:false, critical:false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const power    = powerOverride ?? (move.power ?? 40)
  const atkStat  = atkStatOverride ?? getActiveStat(atk, "atk")
  const defStat  = getActiveStat(def, "def")
  const base     = power + atkStat*4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const afterDef = Math.max(0, raw - defStat*5)
  const critical = Math.random()*100 < Math.min(100, atkStat*2)
  return { damage: critical ? Math.floor(afterDef*1.5) : afterDef, multiplier:mult, stab, critical, dice }
}

// ── 특수 비공격 기술 ───────────────────────────────────────────────────
function handleSpecialNonAttack(moveInfo, myPkmn, tSlots, entries, data, logs) {
  if(!moveInfo) return { handled:false }

  if(moveInfo.defend) {
    myPkmn.defending   = true
    myPkmn.defendTurns = 2
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 방어 태세에 들어갔다!`)
    return { handled:true }
  }

  if(moveInfo.endure) {
    myPkmn.enduring = true
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 버티기 태세에 들어갔다!`)
    return { handled:true }
  }

  if(moveInfo.amulet) {
    myPkmn.amuletTurns = 3
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 신비의 부적으로 몸을 감쌌다!`)
    return { handled:true }
  }

  if(moveInfo.wish) {
    myPkmn.wishTurns = 2
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 희망사항을 빌었다!`)
    return { handled:true }
  }

  if(moveInfo.effect && moveInfo.effect.removeFlying) {
    const healRate = moveInfo.effect.heal ?? 0.5
    const heal     = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * healRate))
    myPkmn.hp      = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} HP를 회복했다! (+${heal})`)
    const types = Array.isArray(myPkmn.type) ? [...myPkmn.type] : [myPkmn.type]
    myPkmn._origType  = myPkmn.type
    myPkmn.type       = types.includes("비행") ? types.filter(t => t !== "비행") : ["노말"]
    if(myPkmn.type.length === 0) myPkmn.type = ["노말"]
    myPkmn.roostTurns = 1
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 땅에 내려앉아 비행 타입이 사라졌다!`)
    return { handled:true }
  }

  if(moveInfo.effect && moveInfo.effect.heal && moveInfo.targetSelf !== false) {
    const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * moveInfo.effect.heal))
    myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} HP를 회복했다! (+${heal})`)
    return { handled:true }
  }

  if(moveInfo.leechSeed) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const tTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    if(tTypes.includes("풀")) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 씨뿌리기에 걸리지 않는다!`); return { handled:true } }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(`그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true } }
    if(tPkmn.seeded) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 이미 씨뿌리기 상태다!`) }
    else {
      tPkmn.seeded     = true
      tPkmn.seederSlot = tSlot
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 몸에 씨를 뿌렸다!`)
    }
    return { handled:true }
  }

  if(moveInfo.healPulse) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const heal = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.12))
    tPkmn.hp   = Math.min(tPkmn.maxHp ?? tPkmn.hp, tPkmn.hp + heal)
    logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} HP를 회복했다! (+${heal})`)
    return { handled:true }
  }

  if(moveInfo.roar) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(`그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true } }
    const tEntry     = entries[tSlot]
    const benchAlive = tEntry.map((p,i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
    if(benchAlive.length === 0) {
      logs.push(`그러나 ${tPkmn.name}에게는 맞지 않았다!`)
    } else {
      const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 물러났다!`)
      logs.push(`${tEntry[randIdx].name}${josa(tEntry[randIdx].name,"이가")} 나왔다!`)
      data[`${tSlot}_active_idx`] = randIdx
    }
    return { handled:true }
  }

  if(moveInfo.chainBind) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(`그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true } }
    const lastMove = tPkmn.lastUsedMove ?? null
    if(!lastMove) {
      logs.push(`그러나 ${tPkmn.name}에게는 효과가 없었다!`)
    } else {
      tPkmn.chainBound = { moveName: lastMove, turnsLeft: 2 }
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} ${lastMove}${josa(lastMove,"을를")} 2턴간 사용할 수 없게 됐다!`)
    }
    return { handled:true }
  }

  return { handled:false }
}

// ── 특수 공격 기술 ────────────────────────────────────────────────────
function handleSpecialAttack(moveInfo, moveName, myPkmn, tSlot, tPkmn, entries, data, logs) {
  if(!moveInfo) return { handled:false, damage:0 }

  if(moveInfo.jumpKick) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) {
      logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)
      const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
      myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
      logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${selfDmg} 데미지를 입었다!`)
      if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
      return { handled:true, damage:0 }
    }
    return { handled:false, damage:0 }
  }

  if(moveInfo.counter) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    if(lastDmg <= 0) { logs.push(`${myPkmn.name}${josa(myPkmn.name,"의")} 카운터는 실패했다!`); return { handled:true, damage:0 } }
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const dmg = Math.max(1, Math.floor(lastDmg * 1.2))
    tPkmn.hp  = Math.max(0, tPkmn.hp - dmg)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 카운터로 ${dmg}의 피해를 입혔다!`)
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled:true, damage:dmg }
  }

  if(moveInfo.revenge || moveInfo.comeback) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const comebackMult = (moveInfo.comeback && lastDmg > 0) ? 1.2 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(rawDmg * comebackMult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(comebackMult > 1) logs.push(`원한이 쌓인 일격!`)
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.reversal) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const hpRatio  = myPkmn.hp / (myPkmn.maxHp ?? myPkmn.hp)
    const revMult  = hpRatio <= 0.25 ? 2.0 : hpRatio <= 0.5 ? 1.5 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(rawDmg * revMult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.guts) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const gutsMult = myPkmn.status ? 1.2 : 1.0
    const { damage: rawDmg, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(rawDmg * gutsMult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(myPkmn.status) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 객기를 부렸다!`)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.rollout) {
    const rollState = myPkmn.rollState ?? { active:false, turn:0 }
    const rollTurn  = rollState.active ? rollState.turn + 1 : 1
    const rollPower = rollTurn === 1 ? 30 : rollTurn === 2 ? 60 : 120
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) {
      logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)
      myPkmn.rollState = { active:false, turn:0 }
      return { handled:true, damage:0 }
    }
    const defTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    let mult = 1; for(const dt of defTypes) mult *= getTypeMultiplier(moves[moveName]?.type, dt)
    const dmg = mult === 0 ? 0 : Math.floor(rollPower * mult)
    if(mult === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); myPkmn.rollState = { active:false, turn:0 }; return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - dmg)
    logs.push(`구르기 ${rollTurn}번째 (${rollPower} 데미지)!`)
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    myPkmn.rollState = rollTurn >= 3 ? { active:false, turn:0 } : { active:true, turn:rollTurn }
    return { handled:true, damage:dmg }
  }

  if(moveInfo.multiHit) {
    const { min, max, fixedDamage } = moveInfo.multiHit
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const hits = Math.floor(Math.random() * (max - min + 1)) + min
    let totalDmg = 0, lastMult = 1
    for(let h = 0; h < hits; h++) {
      if(tPkmn.hp <= 0) break
      let dmg, critical = false, multiplier = 1
      if(fixedDamage !== undefined) {
        const defTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
        for(const dt of defTypes) multiplier *= getTypeMultiplier(moves[moveName]?.type, dt)
        dmg = multiplier === 0 ? 0 : Math.floor(fixedDamage * multiplier)
      } else {
        const r = calcDamage(myPkmn, moveName, tPkmn)
        dmg = r.damage; critical = r.critical; multiplier = r.multiplier
      }
      lastMult = multiplier
      if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); break }
      tPkmn.hp = Math.max(0, tPkmn.hp - dmg)
      totalDmg += dmg
      if(critical) logs.push("급소에 맞았다!")
      if(tPkmn.hp <= 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`); break }
    }
    if(lastMult > 1) logs.push("효과가 굉장했다!")
    if(lastMult < 1) logs.push("효과가 별로인 듯하다…")
    logs.push(`${hits}번 공격했다! (총 ${totalDmg} 데미지)`)
    return { handled:true, damage:totalDmg }
  }

  if(moveInfo.effect && moveInfo.effect.recoil) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    const recoil = Math.max(1, Math.floor(damage * moveInfo.effect.recoil))
    myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${recoil} 데미지를 입었다!`)
    if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage }
  }

  if(moveInfo.clearSmog) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    tPkmn.ranks = defaultRanks(tPkmn)
    logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 능력 변화가 원래대로 돌아왔다!`)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier > 0) {
      tPkmn.hp = Math.max(0, tPkmn.hp - damage)
      if(critical)      logs.push("급소에 맞았다!")
      if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    }
    return { handled:true, damage: multiplier > 0 ? damage : 0 }
  }

  if(moveInfo.dragonTail) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    } else {
      const tIdx       = data[`${tSlot}_active_idx`] ?? 0
      const tEntry     = entries[tSlot]
      const benchAlive = tEntry.map((p,i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
      if(benchAlive.length > 0) {
        const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
        logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 튕겨나갔다!`)
        logs.push(`${tEntry[randIdx].name}${josa(tEntry[randIdx].name,"이가")} 나왔다!`)
        data[`${tSlot}_active_idx`] = randIdx
      }
    }
    return { handled:true, damage }
  }

  if(moveInfo.trickster) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, null, tPkmn.attack ?? 3)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(damage * 0.7)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.sickPower) {
    const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); return { handled:true, damage:0 } }
    const sickMult = tPkmn.status ? 1.2 : 1.0
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn)
    if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(damage * sickMult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(critical)       logs.push("급소에 맞았다!")
    if(sickMult > 1)   logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 상태이상이 약점이 됐다!`)
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.lastResort) {
    const usedMoves  = myPkmn.usedMoves ?? []
    const otherMoves = (myPkmn.moves ?? []).filter(m => m.name !== moveName)
    const allUsed    = otherMoves.every(m => usedMoves.includes(m.name)) && usedMoves.length > 0
    if(!allUsed) {
      logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 아직 다른 기술을 쓰지 않았다!`)
      return { handled:true, damage:0 }
    }
    return { handled:false, damage:0 }
  }

  return { handled:false, damage:0 }
}

// ── EOT 씨뿌리기 ──────────────────────────────────────────────────────
async function applyLeechSeedEot(entries, data, logs) {
  for(const tSlot of ALL_FS) {
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if(!tPkmn || !tPkmn.seeded || tPkmn.hp <= 0) continue
    const seederSlot = tPkmn.seederSlot
    if(!seederSlot) continue
    const sIdx  = data[`${seederSlot}_active_idx`] ?? 0
    const sPkmn = entries[seederSlot][sIdx]
    const dmg   = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.1))
    tPkmn.hp    = Math.max(0, tPkmn.hp - dmg)
    logs.push(`씨뿌리기가 ${tPkmn.name}${josa(tPkmn.name,"의")} 체력을 빼앗는다!`)
    if(sPkmn && sPkmn.hp > 0) {
      sPkmn.hp = Math.min(sPkmn.maxHp ?? sPkmn.hp, sPkmn.hp + dmg)
      logs.push(`${sPkmn.name}${josa(sPkmn.name,"은는")} 체력을 흡수했다! (+${dmg})`)
    }
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, moveIdx, targetSlots } = req.body
  if(!roomId || !mySlot || moveIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if(!data) return res.status(404).json({ error: "방 없음" })
  if(!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const entries     = deepCopyEntries(data)
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = entries[mySlot][myActiveIdx]
  if(myPkmn.hp <= 0) return res.status(403).json({ error: "포켓몬 기절 상태" })

  const moveData = myPkmn.moves?.[moveIdx]
  if(!moveData || moveData.pp <= 0) return res.status(403).json({ error: "사용 불가 기술" })

  const myTeam    = teamOf(mySlot)
  const assistKey = `assist_team${myTeam}`
  const assist    = data[assistKey] ?? null
  const isRequester      = assist && assist.requester === mySlot
  const supporterSlot    = isRequester ? assist.supporter : null
  let assistUsedThisTurn = false
  const activatedSyncKeys = new Set()

  const logs = []
  let hitDefender    = null
  let attackDiceRoll = null

  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logs.push(m))

  if(!pre.blocked) {
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logs.push(m))

    if(!conf.selfHit) {
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }
      myPkmn.lastUsedMove   = moveData.name
      if(!myPkmn.usedMoves) myPkmn.usedMoves = []
      if(!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      const moveInfo = moves[moveData.name]
      logs.push(`${myPkmn.name}의 ${moveData.name}!`)

      const tSlots = targetSlots ?? []

      // ── 비공격 기술 ──────────────────────────────────────────
      if(!moveInfo?.power) {
        const specialResult = handleSpecialNonAttack(moveInfo, myPkmn, tSlots, entries, data, logs)

        if(!specialResult.handled) {
          const r            = moveInfo?.rank
          const targetsEnemy = r && (r.targetAtk!==undefined || r.targetDef!==undefined || r.targetSpd!==undefined)
            || moveInfo?.targetSelf === false

          if(tSlots.length > 0) {
            for(const tSlot of tSlots) {
              const tIdx  = data[`${tSlot}_active_idx`] ?? 0
              const tPkmn = entries[tSlot][tIdx]
              if(!tPkmn || tPkmn.hp <= 0) continue
              if(targetsEnemy) {
                const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
                if(!hit) { logs.push(hitType==="evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`); continue }
              }
              applyRankChanges(r ?? null, myPkmn, tPkmn, moveData.name).forEach(m => logs.push(m))
              applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, 0).forEach(m => logs.push(m))
            }
          } else {
            if(!moveInfo?.alwaysHit && Math.random()*100 >= (moveInfo?.accuracy ?? 100)) {
              logs.push(`그러나 ${myPkmn.name}의 기술은 실패했다!`)
            } else {
              applyRankChanges(r ?? null, myPkmn, myPkmn, moveData.name).forEach(m => logs.push(m))
              applyMoveEffect(moveInfo?.effect, myPkmn, myPkmn, 0).forEach(m => logs.push(m))
            }
          }
        }

      } else {
        // ── 공격 기술 ────────────────────────────────────────
        resetRankStack(myPkmn)
        const isAoe = tSlots.length >= 2

        for(const tSlot of tSlots) {
          const tIdx  = data[`${tSlot}_active_idx`] ?? 0
          const tPkmn = entries[tSlot][tIdx]
          if(!tPkmn || tPkmn.hp <= 0) continue

          // 방어 체크
          if(tPkmn.defending) {
            logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 방어했다!`)
            if(moveInfo?.jumpKick) {
              const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
              myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
              logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${selfDmg} 데미지를 입었다!`)
              if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
            }
            continue
          }

          // 특수 공격 기술
          const specialAtk = handleSpecialAttack(moveInfo, moveData.name, myPkmn, tSlot, tPkmn, entries, data, logs)
          if(specialAtk.handled) {
            if(specialAtk.damage > 0) hitDefender = tSlot
            continue
          }

          // ── 일반 공격 ──────────────────────────────────────
          const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
          if(!hit) {
            logs.push(hitType==="evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : `그러나 ${myPkmn.name}의 공격은 빗나갔다!`)
            if(moveInfo?.jumpKick) {
              const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.25))
              myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
              logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${selfDmg} 데미지를 입었다!`)
              if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
            }
            continue
          }

          hitDefender = tSlot
          let { damage, multiplier, critical, dice } = calcDamage(myPkmn, moveData.name, tPkmn)
          attackDiceRoll = dice

          if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); continue }

          if(isRequester) { damage = Math.floor(damage * 1.15); assistUsedThisTurn = true }

          // 싱크로나이즈
          const tTeam        = teamOf(tSlot)
          const syncKey      = `sync_team${tTeam}`
          const sync         = data[syncKey] ?? null
          const tIsInSync    = sync && (sync.requester === tSlot || sync.supporter === tSlot)
          const syncAllySlot = tIsInSync ? (sync.requester === tSlot ? sync.supporter : sync.requester) : null
          const syncAllyPkmn = syncAllySlot ? entries[syncAllySlot]?.[data[`${syncAllySlot}_active_idx`] ?? 0] : null

          let mainDmg = damage, spillDmg = 0
          if(tIsInSync && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            activatedSyncKeys.add(syncKey)
            if(isAoe) {
              mainDmg = Math.max(1, Math.floor(damage * 0.75))
              logs.push("__SYNC_EVENT__")
              logs.push(`💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name,"은는")} 피해를 분산했다! (×0.75)`)
            } else {
              mainDmg  = Math.max(1, Math.floor(damage * 0.60))
              spillDmg = Math.max(1, Math.floor(damage * 0.40))
              logs.push("__SYNC_EVENT__")
              logs.push(`💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name,"과와")} ${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"이가")} 피해를 분산했다!`)
            }
          }

          // 버티기
          if(tPkmn.enduring && mainDmg >= tPkmn.hp) {
            mainDmg = tPkmn.hp - 1
            logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 버텼다!`)
          }
          tPkmn.enduring = false

          tPkmn.hp = Math.max(0, tPkmn.hp - mainDmg)
          if(multiplier > 1) logs.push("효과가 굉장했다!")
          if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
          if(critical)       logs.push("급소에 맞았다!")
          if(isRequester && assistUsedThisTurn) logs.push("어시스트 효과로 위력이 올라갔다!")

          // 부가효과
          applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, mainDmg).forEach(m => logs.push(m))
          if(moveInfo?.rank) applyRankChanges(moveInfo.rank, myPkmn, tPkmn, null).forEach(m => logs.push(m))

          // 클리어스모그 (공격+랭크리셋)
          if(moveInfo?.clearSmog) {
            tPkmn.ranks = defaultRanks(tPkmn)
            logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 능력 변화가 원래대로 돌아왔다!`)
          }

          // 반동
          if(moveInfo?.effect?.recoil && mainDmg > 0) {
            const recoil = Math.max(1, Math.floor(mainDmg * moveInfo.effect.recoil))
            myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
            logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${recoil} 데미지를 입었다!`)
            if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
          }

          if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)

          // 싱크 스필
          if(spillDmg > 0 && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            if(syncAllyPkmn.enduring && spillDmg >= syncAllyPkmn.hp) {
              spillDmg = syncAllyPkmn.hp - 1
              logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"은는")} 버텼다!`)
            }
            syncAllyPkmn.enduring = false
            syncAllyPkmn.hp = Math.max(0, syncAllyPkmn.hp - spillDmg)
            logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"도")} ${spillDmg}의 피해를 받았다!`)
            if(syncAllyPkmn.hp <= 0) logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"은는")} 쓰러졌다!`)
          }

          // 어시스트 추가 공격
          if(isRequester && assistUsedThisTurn && supporterSlot) {
            const supPkmn = entries[supporterSlot]?.[data[`${supporterSlot}_active_idx`] ?? 0]
            if(supPkmn && supPkmn.hp > 0 && tPkmn.hp > 0) {
              logs.push("__ASSIST_EVENT__")
              const bonusDmg = Math.max(1, Math.floor(damage * 0.3))
              tPkmn.hp = Math.max(0, tPkmn.hp - bonusDmg)
              logs.push(`${supPkmn.name}${josa(supPkmn.name,"이가")} 연속으로 추가 공격했다! (${bonusDmg} 데미지)`)
              if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
            }
          }

          // 받은 데미지 기록 (카운터/원수갚기용)
          tPkmn.lastReceivedDamage = mainDmg
          if(tPkmn.bideState) tPkmn.bideState.damage = (tPkmn.bideState.damage ?? 0) + mainDmg
        }
      }
    }
    tickRanks(myPkmn, logs)
    clearRankStack(myPkmn)
  }

  const assistUpdate = {}
  if(isRequester) {
    assistUpdate[assistKey]               = null
    assistUpdate[`assist_used_${myTeam}`] = true
    if(!assistUsedThisTurn) logs.push("어시스트 효과가 사라졌다...")
  }
  const syncUpdate = {}
  activatedSyncKeys.forEach(k => {
    const team = k.replace("sync_team","")
    syncUpdate[k]                   = null
    syncUpdate[`sync_used_${team}`] = true
  })

  const { assistEventTs, syncEventTs } = await writeLogs(db, roomId, logs)

  const newOrder     = (data.current_order ?? []).slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0

  const update = {
    ...buildEntryUpdate(entries),
    ...assistUpdate,
    ...syncUpdate,
    current_order:     newOrder,
    turn_count:        newTurnCount,
    hit_event:         hitDefender ? { defender: hitDefender, ts: Date.now() } : null,
    dice_event:        null,
    attack_dice_event: attackDiceRoll !== null ? { slot: mySlot, roll: attackDiceRoll, ts: Date.now() } : null,
    ...(assistEventTs !== null ? { assist_event: { ts: assistEventTs } } : {}),
    ...(syncEventTs   !== null ? { sync_event:   { ts: syncEventTs   } } : {}),
  }

  ALL_FS.forEach(s => {
    if(data[`${s}_active_idx`] !== undefined) {
      update[`${s}_active_idx`] = data[`${s}_active_idx`]
    }
  })

  const winTeam = checkWin(entries)
  if(winTeam) {
    update.game_over = true; update.winner_team = winTeam; update.current_order = []
    await roomRef.update(update)
    return res.status(200).json({ ok:true, winTeam })
  }

  if(isEot) {
    const eotLogs = []
    await applyLeechSeedEot(entries, data, eotLogs)
    if(eotLogs.length > 0) {
      Object.assign(update, buildEntryUpdate(entries))
      const logsRef = db.collection("double").doc(roomId).collection("logs")
      const base    = Date.now()
      const batch   = db.batch()
      eotLogs.forEach((text, i) => batch.set(logsRef.doc(), { text, ts: base + i }))
      await batch.commit()
    }
    const win = await handleEot(db, roomId, entries, data, update)
    if(win) { await roomRef.update(update); return res.status(200).json({ ok:true, winTeam: win }) }
  }

  await roomRef.update(update)
  return res.status(200).json({ ok:true })
}