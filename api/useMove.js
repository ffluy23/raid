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

function defaultRanks() { return { atk:0,atkTurns:0,def:0,defTurns:0,spd:0,spdTurns:0 } }

function calcHit(atk, moveInfo, def) {
  if(Math.random()*100 >= (moveInfo.accuracy ?? 100)) return { hit:false, hitType:"missed" }
  if(moveInfo.alwaysHit || moveInfo.skipEvasion)       return { hit:true,  hitType:"hit" }
  const as = Math.max(1, (atk.speed ?? 3) - getStatusSpdPenalty(atk))
  const ds = Math.max(1, (def.speed ?? 3) - getStatusSpdPenalty(def))
  const ev = Math.min(99, Math.max(0, 5*(ds-as)) + Math.max(0, getActiveRank(def,"spd")))
  return Math.random()*100 < ev ? { hit:false, hitType:"evaded" } : { hit:true, hitType:"hit" }
}

function calcDamage(atk, moveName, def, atkRank=0, defRank=0, powerOverride=null) {
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
  const base     = power + (atk.attack ?? 3)*4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const afterAtk = Math.max(0, raw + Math.max(-raw, atkRank))
  const afterDef = Math.max(0, afterAtk - (def.defense ?? 3)*5)
  const baseDmg  = Math.max(0, afterDef - Math.min(3, Math.max(0, defRank))*3)
  const critical = Math.random()*100 < Math.min(100, (atk.attack ?? 3)*2)
  return { damage: critical ? Math.floor(baseDmg*1.5) : baseDmg, multiplier:mult, stab, critical, dice }
}

function applyRankChanges(r, self, target) {
  if(!r) return []
  const msgs = []
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if(!roll) return []
  const sR = { ...defaultRanks(), ...(self.ranks ?? {}) }
  const tR = { ...defaultRanks(), ...(target.ranks ?? {}) }
  const label = { atk:"공격", def:"방어", spd:"스피드" }
  function applyOne(obj, key, delta, maxV, minV, name) {
    const stat = label[key]
    if(delta > 0) {
      const p = obj[key]; obj[key]=Math.min(maxV,obj[key]+delta); obj[`${key}Turns`]=r.turns??2
      msgs.push(`${name}의 ${stat}${josa(stat,"이가")} 올라갔다! (+${obj[key]-p})`)
    } else if(delta < 0) {
      if(obj[key]===0) msgs.push(`${name}의 ${stat}${josa(stat,"은는")} 더 이상 내려가지 않는다!`)
      else { const p=obj[key]; obj[key]=Math.max(minV,obj[key]+delta); obj[`${key}Turns`]=r.turns??2; msgs.push(`${name}의 ${stat}${josa(stat,"이가")} 내려갔다! (${obj[key]-p})`) }
    }
  }
  if(r.atk!==undefined)       applyOne(sR,"atk",r.atk,4,0,self.name)
  if(r.def!==undefined)       applyOne(sR,"def",r.def,3,0,self.name)
  if(r.spd!==undefined)       applyOne(sR,"spd",r.spd,5,0,self.name)
  if(r.targetAtk!==undefined) applyOne(tR,"atk",r.targetAtk,4,0,target.name)
  if(r.targetDef!==undefined) applyOne(tR,"def",r.targetDef,3,0,target.name)
  if(r.targetSpd!==undefined) applyOne(tR,"spd",r.targetSpd,5,0,target.name)
  self.ranks=sR; target.ranks=tR
  return msgs
}

function tickRanks(pkmn, logs) {
  if(!pkmn.ranks) return
  const r = pkmn.ranks
  if(r.atkTurns > 0) { r.atkTurns--; if(!r.atkTurns) { r.atk=0; logs.push(`${pkmn.name}의 공격 랭크가 원래대로 돌아왔다!`) } }
  if(r.defTurns > 0) { r.defTurns--; if(!r.defTurns) { r.def=0; logs.push(`${pkmn.name}의 방어 랭크가 원래대로 돌아왔다!`) } }
  if(r.spdTurns > 0) { r.spdTurns--; if(!r.spdTurns) { r.spd=0; logs.push(`${pkmn.name}의 스피드 랭크가 원래대로 돌아왔다!`) } }
}

function handleSpecialNonAttack(moveInfo, myPkmn, tSlots, entries, data, logs) {
  if(!moveInfo) return { handled:false }

  if(moveInfo.defend) {
    myPkmn.defending   = true
    myPkmn.defendTurns = 1
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 몸을 지켰다!`)
    return { handled:true }
  }

  if(moveInfo.endure) {
    myPkmn.enduring = true
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 버텼다!`)
    return { handled:true }
  }

  if(moveInfo.amulet) {
    myPkmn.amuletTurns = 3
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 신비의 부적으로 몸을 감쌌다! (3턴)`)
    return { handled:true }
  }

  if(moveInfo.wish) {
    myPkmn.wishTurns = 2
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 희망사항을 빌었다…`)
    return { handled:true }
  }

  if(moveInfo.effect && moveInfo.effect.removeFlying) {
    const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.5))
    myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 날개를 쉬며 회복했다! (+${heal})`)
    const types = Array.isArray(myPkmn.type) ? myPkmn.type : [myPkmn.type]
    if(types.includes("비행")) {
      myPkmn._origType  = myPkmn.type
      myPkmn.type       = types.filter(t => t !== "비행")
      myPkmn.roostTurns = 1
    }
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
    if(!hit) { logs.push("빗나갔다!"); return { handled:true } }
    if(tPkmn.seeded) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 이미 씨뿌리기 상태다!`)
    } else {
      tPkmn.seeded     = true
      tPkmn.seederSlot = mySlot
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게")} 씨가 심어졌다!`)
    }
    return { handled:true }
  }

  if(moveInfo.healPulse) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const heal = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.5))
    tPkmn.hp   = Math.min(tPkmn.maxHp ?? tPkmn.hp, tPkmn.hp + heal)
    logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 치유파동으로 회복됐다! (+${heal})`)
    return { handled:true }
  }

  if(moveInfo.roar) {
    if(tSlots.length === 0) return { handled:true }
    const tSlot  = tSlots[0]
    const tIdx   = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn  = entries[tSlot][tIdx]
    if(!tPkmn || tPkmn.hp <= 0) return { handled:true }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true } }
    const tEntry     = entries[tSlot]
    const benchAlive = tEntry.map((p,i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
    if(benchAlive.length === 0) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 더 이상 교체할 포켓몬이 없다!`)
    } else {
      const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 울부짖기에 쫓겨났다!`)
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
    if(!hit) { logs.push("빗나갔다!"); return { handled:true } }
    if(tPkmn.chainBound) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 이미 사슬에 묶여 있다!`)
    } else {
      const curMoveIdx = data[`${tSlot}_last_move_idx`] ?? 0
      const curMove    = tPkmn.moves?.[curMoveIdx]
      if(curMove) {
        tPkmn.chainBound = { moveName: curMove.name, turnsLeft: 3 }
        logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} ${curMove.name}${josa(curMove.name,"만")} 사용할 수 있게 됐다! (3턴)`)
      }
    }
    return { handled:true }
  }

  return { handled:false }
}

function handleSpecialAttack(moveInfo, moveName, myPkmn, tSlot, tPkmn, entries, data, logs) {
  if(!moveInfo) return { handled:false, damage:0 }

  if(moveInfo.jumpKick) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) {
      const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.5))
      myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
      logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 실패해서 자신이 다쳤다! (${selfDmg} 데미지)`)
      if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
      return { handled:true, damage:0 }
    }
    return { handled:false, damage:0 }
  }

  if(moveInfo.counter) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    if(lastDmg <= 0) { logs.push(`${myPkmn.name}${josa(myPkmn.name,"의")} 카운터는 실패했다!`); return { handled:true, damage:0 } }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const dmg = lastDmg * 2
    tPkmn.hp  = Math.max(0, tPkmn.hp - dmg)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 카운터로 ${dmg}의 피해를 입혔다!`)
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled:true, damage:dmg }
  }

  if(moveInfo.revenge || moveInfo.comeback) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    const bonus   = lastDmg > 0 ? Math.floor(lastDmg * 1.5) : 0
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = damage + bonus
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(bonus > 0)      logs.push(`원한이 쌓인 일격! (+${bonus})`)
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled:true, damage:finalDmg }
  }

  if(moveInfo.reversal) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const hpRatio = myPkmn.hp / (myPkmn.maxHp ?? myPkmn.hp)
    const power   = hpRatio > 0.5 ? 20 : hpRatio > 0.35 ? 40 : hpRatio > 0.2 ? 80 : hpRatio > 0.1 ? 100 : hpRatio > 0.04 ? 150 : 200
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"), power)
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage }
  }

  if(moveInfo.guts) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const atkBonus = myPkmn.status ? 2 : 0
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk") + atkBonus, getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(myPkmn.status) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 객기를 부렸다!`)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage }
  }

  if(moveInfo.rollout) {
    if(!myPkmn.rollState || !myPkmn.rollState.active) {
      myPkmn.rollState = { active:true, turn:1 }
    } else {
      myPkmn.rollState.turn++
      if(myPkmn.rollState.turn > 5) {
        myPkmn.rollState = { active:false, turn:0 }
        logs.push(`${myPkmn.name}${josa(myPkmn.name,"의")} 구르기가 끝났다!`)
        return { handled:true, damage:0 }
      }
    }
    const power = 30 * Math.pow(2, myPkmn.rollState.turn - 1)
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { myPkmn.rollState = { active:false, turn:0 }; logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"), power)
    if(multiplier === 0) { myPkmn.rollState = { active:false, turn:0 }; logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    logs.push(`구르기 ${myPkmn.rollState.turn}턴째! (위력 ${power})`)
    if(critical)      logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    if(myPkmn.rollState.turn >= 5) myPkmn.rollState = { active:false, turn:0 }
    return { handled:true, damage }
  }

  if(moveInfo.multiHit) {
    const { min, max, fixedDamage } = moveInfo.multiHit
    const hits = Math.floor(Math.random() * (max - min + 1)) + min
    let totalDmg = 0
    for(let h = 0; h < hits; h++) {
      if(tPkmn.hp <= 0) break
      const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
      if(!hit) break
      const dmg = fixedDamage ?? Math.max(1, calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def")).damage)
      tPkmn.hp = Math.max(0, tPkmn.hp - dmg)
      totalDmg += dmg
      if(tPkmn.hp <= 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`); break }
    }
    logs.push(`${hits}번 연속으로 공격했다! (합계 ${totalDmg} 데미지)`)
    return { handled:true, damage:totalDmg }
  }

  if(moveInfo.effect && moveInfo.effect.recoil) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if(critical)       logs.push("급소에 맞았다!")
    if(tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    const recoil = Math.max(1, Math.floor(damage * moveInfo.effect.recoil))
    myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 반동으로 ${recoil}의 피해를 입었다!`)
    if(myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage }
  }

  if(moveInfo.clearSmog) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    if(tPkmn.ranks) tPkmn.ranks = defaultRanks()
    logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 랭크가 원래대로 돌아왔다!`)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, 0, 0)
    if(multiplier > 0) {
      tPkmn.hp = Math.max(0, tPkmn.hp - damage)
      if(critical)      logs.push("급소에 맞았다!")
      if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    }
    return { handled:true, damage: multiplier > 0 ? damage : 0 }
  }

  if(moveInfo.dragonTail) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
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
        logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 드래곤테일에 날아갔다!`)
        logs.push(`${tEntry[randIdx].name}${josa(tEntry[randIdx].name,"이가")} 나왔다!`)
        data[`${tSlot}_active_idx`] = randIdx
      }
    }
    return { handled:true, damage }
  }

  if(moveInfo.trickster) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(critical)       logs.push("급소에 맞았다!")
    const tmpAtk = myPkmn.attack;  myPkmn.attack  = tPkmn.attack;  tPkmn.attack  = tmpAtk
    const tmpDef = myPkmn.defense; myPkmn.defense = tPkmn.defense; tPkmn.defense = tmpDef
    logs.push(`${myPkmn.name}${josa(myPkmn.name,"과와")} ${tPkmn.name}의 스탯이 교환됐다!`)
    if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)
    return { handled:true, damage }
  }

  if(moveInfo.sickPower) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if(!hit) { logs.push("빗나갔다!"); return { handled:true, damage:0 } }
    const mult = tPkmn.status ? 2 : 1
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn,"atk"), getActiveRank(tPkmn,"def"))
    if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); return { handled:true, damage:0 } }
    const finalDmg = Math.floor(damage * mult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if(multiplier > 1) logs.push("효과가 굉장했다!")
    if(critical)       logs.push("급소에 맞았다!")
    if(mult > 1)       logs.push(`${tPkmn.name}${josa(tPkmn.name,"의")} 상태이상이 약점이 됐다!`)
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
      if(!myPkmn.usedMoves) myPkmn.usedMoves = []
      if(!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      const moveInfo = moves[moveData.name]
      logs.push(`${myPkmn.name}의 ${moveData.name}!`)

      const tSlots = targetSlots ?? []

      if(!moveInfo?.power) {
        const specialResult = handleSpecialNonAttack(moveInfo, myPkmn, tSlots, entries, data, logs)

        if(!specialResult.handled) {
          const r            = moveInfo?.rank
          const targetsEnemy = r && (r.targetAtk!==undefined || r.targetDef!==undefined || r.targetSpd!==undefined)

          if(tSlots.length > 0) {
            for(const tSlot of tSlots) {
              const tIdx  = data[`${tSlot}_active_idx`] ?? 0
              const tPkmn = entries[tSlot][tIdx]
              if(!tPkmn || tPkmn.hp <= 0) continue
              if(targetsEnemy) {
                const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
                if(!hit) { logs.push(hitType==="evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!"); continue }
              }
              applyRankChanges(r ?? null, myPkmn, tPkmn).forEach(m => logs.push(m))
              applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, 0).forEach(m => logs.push(m))
            }
          } else {
            if(!moveInfo?.alwaysHit && Math.random()*100 >= (moveInfo?.accuracy ?? 100)) {
              logs.push(`그러나 ${myPkmn.name}의 기술은 실패했다!`)
            } else {
              applyRankChanges(r ?? null, myPkmn, myPkmn).forEach(m => logs.push(m))
              applyMoveEffect(moveInfo?.effect, myPkmn, myPkmn, 0).forEach(m => logs.push(m))
            }
          }
        }

      } else {
        const isAoe = tSlots.length >= 2

        for(const tSlot of tSlots) {
          const tIdx  = data[`${tSlot}_active_idx`] ?? 0
          const tPkmn = entries[tSlot][tIdx]
          if(!tPkmn || tPkmn.hp <= 0) continue

          if(tPkmn.defending) {
            logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 방어했다!`)
            continue
          }

          const specialAtk = handleSpecialAttack(moveInfo, moveData.name, myPkmn, tSlot, tPkmn, entries, data, logs)
          if(specialAtk.handled) {
            if(specialAtk.damage > 0) hitDefender = tSlot
            continue
          }

          const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
          if(!hit) {
            logs.push(hitType==="evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!")
            continue
          }

          hitDefender = tSlot
          const atkRank = getActiveRank(myPkmn,"atk")
          const defRank = getActiveRank(tPkmn,"def")
          let { damage, multiplier, critical, dice } = calcDamage(myPkmn, moveData.name, tPkmn, atkRank, defRank)
          attackDiceRoll = dice

          if(multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name,"에게는")} 효과가 없다…`); continue }

          if(isRequester) { damage = Math.floor(damage * 1.15); assistUsedThisTurn = true }

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
          applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, mainDmg).forEach(m => logs.push(m))
          if(moveInfo?.rank) applyRankChanges(moveInfo.rank, myPkmn, tPkmn).forEach(m => logs.push(m))
          if(tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name,"은는")} 쓰러졌다!`)

          if(spillDmg > 0 && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            syncAllyPkmn.hp = Math.max(0, syncAllyPkmn.hp - spillDmg)
            logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"도")} ${spillDmg}의 피해를 받았다!`)
            if(syncAllyPkmn.hp <= 0) logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name,"은는")} 쓰러졌다!`)
          }

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

          tPkmn.lastReceivedDamage = mainDmg
        }
      }
    }
    tickRanks(myPkmn, logs)
  }

  const newOrder     = (data.current_order ?? []).slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0

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