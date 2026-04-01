import { db } from "../lib/firestore.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, applyEndOfTurnDamage, getStatusSpdPenalty,
  applyStatus, applyVolatile, tickVolatiles, applyLeechSeed
} from "../lib/effecthandler.js"
import {
  ALL_FS, deepCopyEntries, buildEntryUpdate, checkWin, collectFaintedSlots,
  teamOf, allySlot, roomName, rollD10, getActiveRank, writeLogs, corsHeaders,
  handleEot
} from "../lib/gameUtils.js"

// ── 유틸 ──────────────────────────────────────────────────────────────
function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function calcHit(atk, moveInfo, def) {
  if (Math.random() * 100 >= (moveInfo.accuracy ?? 100)) return { hit: false, hitType: "missed" }
  if (moveInfo.alwaysHit || moveInfo.skipEvasion)         return { hit: true,  hitType: "hit"    }
  const as = Math.max(1, (atk.speed ?? 3) - getStatusSpdPenalty(atk))
  const ds = Math.max(1, (def.speed ?? 3) - getStatusSpdPenalty(def))
  const ev = Math.min(99, Math.max(0, 5 * (ds - as)) + Math.max(0, getActiveRank(def, "spd")))
  return Math.random() * 100 < ev ? { hit: false, hitType: "evaded" } : { hit: true, hitType: "hit" }
}

function calcDamage(atk, moveName, def, atkRank = 0, defRank = 0, powerOverride = null) {
  const move = moves[moveName]
  if (!move) return { damage: 0, multiplier: 1, stab: false, critical: false, dice: 0 }
  const dice     = rollD10()
  const defTypes = Array.isArray(def.type) ? def.type : [def.type]
  let mult = 1
  for (const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if (mult === 0) return { damage: 0, multiplier: 0, stab: false, critical: false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const power    = powerOverride ?? (move.power ?? 40)
  const base     = power + (atk.attack ?? 3) * 4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const afterAtk = Math.max(0, raw + Math.max(-raw, atkRank))
  const afterDef = Math.max(0, afterAtk - (def.defense ?? 3) * 5)
  const baseDmg  = Math.max(0, afterDef - Math.min(3, Math.max(0, defRank)) * 3)
  const critical = Math.random() * 100 < Math.min(100, (atk.attack ?? 3) * 2)
  return {
    damage: critical ? Math.floor(baseDmg * 1.5) : baseDmg,
    multiplier: mult, stab, critical, dice
  }
}

function applyRankChanges(r, self, target) {
  if (!r) return []
  const msgs = []
  const roll = r.chance !== undefined ? Math.random() < r.chance : true
  if (!roll) return []
  const sR = { ...defaultRanks(), ...(self.ranks   ?? {}) }
  const tR = { ...defaultRanks(), ...(target.ranks ?? {}) }
  const label = { atk: "공격", def: "방어", spd: "스피드" }
  function applyOne(obj, key, delta, maxV, minV, name) {
    const stat = label[key]
    if (delta > 0) {
      const p = obj[key]; obj[key] = Math.min(maxV, obj[key] + delta); obj[`${key}Turns`] = r.turns ?? 2
      msgs.push(`${name}의 ${stat}${josa(stat, "이가")} 올라갔다! (+${obj[key] - p})`)
    } else if (delta < 0) {
      if (obj[key] === 0) msgs.push(`${name}의 ${stat}${josa(stat, "은는")} 더 이상 내려가지 않는다!`)
      else {
        const p = obj[key]; obj[key] = Math.max(minV, obj[key] + delta); obj[`${key}Turns`] = r.turns ?? 2
        msgs.push(`${name}의 ${stat}${josa(stat, "이가")} 내려갔다! (${obj[key] - p})`)
      }
    }
  }
  if (r.atk       !== undefined) applyOne(sR, "atk", r.atk,       4, 0, self.name)
  if (r.def       !== undefined) applyOne(sR, "def", r.def,       3, 0, self.name)
  if (r.spd       !== undefined) applyOne(sR, "spd", r.spd,       5, 0, self.name)
  if (r.targetAtk !== undefined) applyOne(tR, "atk", r.targetAtk, 4, 0, target.name)
  if (r.targetDef !== undefined) applyOne(tR, "def", r.targetDef, 3, 0, target.name)
  if (r.targetSpd !== undefined) applyOne(tR, "spd", r.targetSpd, 5, 0, target.name)
  self.ranks   = sR
  target.ranks = tR
  return msgs
}

function tickRanks(pkmn, logs) {
  if (!pkmn.ranks) return
  const r = pkmn.ranks
  if (r.atkTurns > 0) { r.atkTurns--; if (!r.atkTurns) { r.atk = 0; logs.push(`${pkmn.name}의 공격 랭크가 원래대로 돌아왔다!`) } }
  if (r.defTurns > 0) { r.defTurns--; if (!r.defTurns) { r.def = 0; logs.push(`${pkmn.name}의 방어 랭크가 원래대로 돌아왔다!`) } }
  if (r.spdTurns > 0) { r.spdTurns--; if (!r.spdTurns) { r.spd = 0; logs.push(`${pkmn.name}의 스피드 랭크가 원래대로 돌아왔다!`) } }
}

// 랭크 스택 (칼춤 연속사용 → 중첩 → 3회째 리셋) — 더블도 동일하게 적용
function applyRankStack(pkmn, moveName, r, target, logs) {
  if (!r) return
  const isSelf = !r.targetAtk && !r.targetDef && !r.targetSpd  // 자신 대상 랭크기술
  if (!isSelf) {
    applyRankChanges(r, pkmn, target).forEach(m => logs.push(m))
    return
  }
  const isSameMove = pkmn.lastRankMove === moveName
  const stack      = pkmn.rankStack ?? 0
  if (!isSameMove) {
    pkmn.lastRankMove = moveName; pkmn.rankStack = 1
  } else if (stack >= 2) {
    // 3회 연속 사용 시 랭크 리셋
    if (pkmn.ranks) pkmn.ranks = defaultRanks()
    pkmn.rankStack = 1
    logs.push(`${pkmn.name}의 랭크가 원래대로 돌아왔다!`)
  } else {
    pkmn.rankStack = stack + 1
  }
  applyRankChanges(r, pkmn, target).forEach(m => logs.push(m))
}

// ── 특수 기술 처리 ─────────────────────────────────────────────────────

/**
 * 공격 기술이 아닌 특수 기술을 처리.
 * @returns {{ handled: boolean, blocked: boolean }}
 *   handled: true → 이 함수에서 처리 완료 (일반 랭크/공격 루틴 스킵)
 *   blocked: true → 기술 발동 자체가 막힘 (PP는 이미 소모됨)
 */
function handleSpecialNonAttack(moveInfo, moveName, myPkmn, tSlots, entries, data, logs) {
  // ── 방어 ──────────────────────────────────────────────────────
  if (moveInfo.defend) {
    myPkmn.defending   = true
    myPkmn.defendTurns = 1
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 몸을 지켰다!`)
    return { handled: true, blocked: false }
  }

  // ── 버티기 ────────────────────────────────────────────────────
  if (moveInfo.endure) {
    myPkmn.enduring = true
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 버텼다!`)
    return { handled: true, blocked: false }
  }

  // ── 참기 ──────────────────────────────────────────────────────
  if (moveInfo.bide) {
    if (!myPkmn.bideState) {
      myPkmn.bideState = { turnsLeft: 2, damage: 0 }
      logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 힘을 모으고 있다!`)
    } else {
      myPkmn.bideState.turnsLeft--
      if (myPkmn.bideState.turnsLeft <= 0) {
        // 폭발
        const target = tSlots.length > 0 ? entries[tSlots[0]]?.[data[`${tSlots[0]}_active_idx`] ?? 0] : null
        if (target && target.hp > 0) {
          const dmg = myPkmn.bideState.damage * 2
          target.hp = Math.max(0, target.hp - dmg)
          logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 에너지를 방출했다! (${dmg} 데미지)`)
          if (target.hp <= 0) logs.push(`${target.name}${josa(target.name, "은는")} 쓰러졌다!`)
        } else {
          logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 에너지를 방출했지만 효과가 없었다!`)
        }
        myPkmn.bideState = null
      } else {
        logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 힘을 모으고 있다!`)
      }
    }
    return { handled: true, blocked: false }
  }

  // ── 신비의부적 ────────────────────────────────────────────────
  if (moveInfo.amulet) {
    myPkmn.amuletTurns = 3
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 신비의 부적으로 몸을 감쌌다! (3턴)`)
    return { handled: true, blocked: false }
  }

  // ── 희망사항 ──────────────────────────────────────────────────
  if (moveInfo.wish) {
    myPkmn.wishTurns = 2
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 희망사항을 빌었다…`)
    return { handled: true, blocked: false }
  }

  // ── 날개쉬기 ──────────────────────────────────────────────────
  if (moveInfo.effect?.removeFlying) {
    const types = Array.isArray(myPkmn.type) ? myPkmn.type : [myPkmn.type]
    const heal  = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.5))
    myPkmn.hp   = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 날개를 쉬며 회복했다! (+${heal})`)
    if (types.includes("비행")) {
      myPkmn._origType   = myPkmn.type
      myPkmn.type        = types.filter(t => t !== "비행")
      myPkmn.roostTurns  = 1
    }
    return { handled: true, blocked: false }
  }

  // ── HP 회복 (태만함 / HP회복) ─────────────────────────────────
  if (moveInfo.effect?.heal && moveInfo.targetSelf !== false) {
    const heal = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * moveInfo.effect.heal))
    myPkmn.hp  = Math.min(myPkmn.maxHp ?? myPkmn.hp, myPkmn.hp + heal)
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} HP를 회복했다! (+${heal})`)
    return { handled: true, blocked: false }
  }

  // ── 씨뿌리기 ──────────────────────────────────────────────────
  if (moveInfo.leechSeed) {
    if (tSlots.length === 0) return { handled: true, blocked: false }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true, blocked: false }
    // 풀 타입 면역
    const tTypes = Array.isArray(tPkmn.type) ? tPkmn.type : [tPkmn.type]
    if (tTypes.includes("풀")) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 씨뿌리기에 걸리지 않는다!`)
      return { handled: true, blocked: false }
    }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, blocked: false } }
    if (tPkmn.seeded) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 씨뿌리기 상태다!`)
    } else {
      tPkmn.seeded    = true
      tPkmn.seederSlot = mySlot  // 씨 심은 슬롯 기억
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게")} 씨가 심어졌다!`)
    }
    return { handled: true, blocked: false }
  }

  // ── 치유파동 (아군/적 단일 타겟 HP 회복) ─────────────────────
  if (moveInfo.healPulse) {
    if (tSlots.length === 0) return { handled: true, blocked: false }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true, blocked: false }
    const heal = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.5))
    tPkmn.hp   = Math.min(tPkmn.maxHp ?? tPkmn.hp, tPkmn.hp + heal)
    logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 치유파동으로 회복됐다! (+${heal})`)
    return { handled: true, blocked: false }
  }

  // ── 울부짖기 (강제 교체) ──────────────────────────────────────
  if (moveInfo.roar) {
    if (tSlots.length === 0) return { handled: true, blocked: false }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true, blocked: false }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, blocked: false } }
    // 더블: 상대 팀에서 살아있는 벤치 포켓몬으로 강제 교체
    const tEntry     = entries[tSlot]
    const benchAlive = tEntry.map((p, i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
    if (benchAlive.length === 0) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 더 이상 교체할 포켓몬이 없다!`)
    } else {
      const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 울부짖기에 쫓겨났다!`)
      logs.push(`${entries[tSlot][randIdx].name}${josa(entries[tSlot][randIdx].name, "이가")} 나왔다!`)
      // 교체
      data[`${tSlot}_active_idx`] = randIdx  // update에서 덮어쓸 것
    }
    return { handled: true, blocked: false }
  }

  // ── 사슬묶기 ──────────────────────────────────────────────────
  if (moveInfo.chainBind) {
    if (tSlots.length === 0) return { handled: true, blocked: false }
    const tSlot = tSlots[0]
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || tPkmn.hp <= 0) return { handled: true, blocked: false }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, blocked: false } }
    if (tPkmn.chainBound) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 이미 사슬에 묶여 있다!`)
    } else {
      // 현재 쓰고 있는 기술로 묶기
      const curMoveIdx = data[`${tSlot}_last_move_idx`] ?? 0
      const curMove    = tPkmn.moves?.[curMoveIdx]
      if (curMove) {
        tPkmn.chainBound = { moveName: curMove.name, turnsLeft: 3 }
        logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} ${curMove.name}${josa(curMove.name, "만")} 사용할 수 있게 됐다! (3턴)`)
      }
    }
    return { handled: true, blocked: false }
  }

  // ── 뽐내기 (상대 공격 올림 + 혼란) ───────────────────────────
  // moves.js에 rank + effect 복합으로 정의돼 있어서 일반 루틴으로도 가능하지만
  // 명시적으로 처리해두면 안전함
  // (일반 루틴이 처리하도록 handled:false 반환)

  return { handled: false, blocked: false }
}

/**
 * 공격 기술 중 특수 처리가 필요한 것들.
 * @returns {{ handled: boolean, damage: number }}
 *   handled: true → 이 함수에서 데미지까지 처리 완료
 */
function handleSpecialAttack(moveInfo, moveName, myPkmn, tSlot, tPkmn, entries, data, logs) {
  // ── 무릎차기 (실패 시 자기 데미지) ───────────────────────────
  if (moveInfo.jumpKick) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) {
      const selfDmg = Math.max(1, Math.floor((myPkmn.maxHp ?? myPkmn.hp) * 0.5))
      myPkmn.hp = Math.max(0, myPkmn.hp - selfDmg)
      logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 실패해서 자신이 다쳤다! (${selfDmg} 데미지)`)
      if (myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`)
      return { handled: true, damage: 0 }
    }
    return { handled: false, damage: 0 }  // 명중 시 일반 데미지 계산
  }

  // ── 카운터 ────────────────────────────────────────────────────
  if (moveInfo.counter) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    if (lastDmg <= 0) {
      logs.push(`${myPkmn.name}${josa(myPkmn.name, "의")} 카운터는 실패했다!`)
      return { handled: true, damage: 0 }
    }
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const dmg = lastDmg * 2
    tPkmn.hp  = Math.max(0, tPkmn.hp - dmg)
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 카운터로 ${dmg}의 피해를 입혔다!`)
    if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled: true, damage: dmg }
  }

  // ── 원수갚기 / 보복 ───────────────────────────────────────────
  if (moveInfo.revenge || moveInfo.comeback) {
    const lastDmg = myPkmn.lastReceivedDamage ?? 0
    const bonus   = lastDmg > 0 ? Math.floor(lastDmg * 1.5) : 0
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"))
    const finalDmg = damage + bonus
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if (critical)       logs.push("급소에 맞았다!")
    if (bonus > 0)      logs.push(`원한이 쌓인 일격! (+${bonus})`)
    if (tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    myPkmn.lastReceivedDamage = 0
    return { handled: true, damage: finalDmg }
  }

  // ── 기사회생 / 바둥바둥 (HP가 낮을수록 강함) ──────────────────
  if (moveInfo.reversal) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const hpRatio  = myPkmn.hp / (myPkmn.maxHp ?? myPkmn.hp)
    let power
    if      (hpRatio > 0.5)  power = 20
    else if (hpRatio > 0.35) power = 40
    else if (hpRatio > 0.2)  power = 80
    else if (hpRatio > 0.1)  power = 100
    else if (hpRatio > 0.04) power = 150
    else                     power = 200
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"), power)
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if (critical)       logs.push("급소에 맞았다!")
    if (tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    return { handled: true, damage }
  }

  // ── 객기 (자신에게 상태이상이 있으면 공격 올라감) ────────────
  if (moveInfo.guts) {
    const hasStatus = !!myPkmn.status
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const atkBonus = hasStatus ? 2 : 0
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk") + atkBonus, getActiveRank(tPkmn, "def"))
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if (hasStatus) logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 객기를 부렸다!`)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if (critical)       logs.push("급소에 맞았다!")
    if (tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    return { handled: true, damage }
  }

  // ── 구르기 (연속 사용 시 위력 증가) ──────────────────────────
  if (moveInfo.rollout) {
    if (!myPkmn.rollState?.active) {
      myPkmn.rollState = { active: true, turn: 1, basePower: 30 }
    } else {
      myPkmn.rollState.turn++
      if (myPkmn.rollState.turn > 5) {
        myPkmn.rollState = { active: false, turn: 0 }
        logs.push(`${myPkmn.name}${josa(myPkmn.name, "의")} 구르기가 끝났다!`)
        return { handled: true, damage: 0 }
      }
    }
    const power = 30 * Math.pow(2, myPkmn.rollState.turn - 1)
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) {
      myPkmn.rollState = { active: false, turn: 0 }
      logs.push("빗나갔다!")
      return { handled: true, damage: 0 }
    }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"), power)
    if (multiplier === 0) {
      myPkmn.rollState = { active: false, turn: 0 }
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`)
      return { handled: true, damage: 0 }
    }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    logs.push(`구르기 ${myPkmn.rollState.turn}턴째! (위력 ${power})`)
    if (critical)      logs.push("급소에 맞았다!")
    if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    if (myPkmn.rollState.turn >= 5) myPkmn.rollState = { active: false, turn: 0 }
    return { handled: true, damage }
  }

  // ── 마구찌르기 (2~5회 연속히트) ──────────────────────────────
  if (moveInfo.multiHit) {
    const { min, max, fixedDamage } = moveInfo.multiHit
    const hits  = Math.floor(Math.random() * (max - min + 1)) + min
    let totalDmg = 0
    for (let h = 0; h < hits; h++) {
      const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
      if (!hit) break
      if (tPkmn.hp <= 0) break
      const dmg = fixedDamage ?? Math.max(1,
        calcDamage(myPkmn, moveName, tPkmn, getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def")).damage)
      tPkmn.hp = Math.max(0, tPkmn.hp - dmg)
      totalDmg += dmg
      if (tPkmn.hp <= 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`); break }
    }
    logs.push(`${hits}번 연속으로 공격했다! (합계 ${totalDmg} 데미지)`)
    return { handled: true, damage: totalDmg }
  }

  // ── 이판사판태클 (반동 데미지) ───────────────────────────────
  if (moveInfo.effect?.recoil) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"))
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (multiplier < 1) logs.push("효과가 별로인 듯하다…")
    if (critical)       logs.push("급소에 맞았다!")
    if (tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    const recoil = Math.max(1, Math.floor(damage * moveInfo.effect.recoil))
    myPkmn.hp = Math.max(0, myPkmn.hp - recoil)
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 반동으로 ${recoil}의 피해를 입었다!`)
    if (myPkmn.hp <= 0) logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 쓰러졌다!`)
    return { handled: true, damage }
  }

  // ── 클리어스모그 (상대 랭크 리셋 후 데미지) ──────────────────
  if (moveInfo.clearSmog) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    if (tPkmn.ranks) tPkmn.ranks = defaultRanks()
    logs.push(`${tPkmn.name}${josa(tPkmn.name, "의")} 랭크가 원래대로 돌아왔다!`)
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn, 0, 0)
    if (multiplier > 0) {
      tPkmn.hp = Math.max(0, tPkmn.hp - damage)
      if (critical) logs.push("급소에 맞았다!")
      if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    }
    return { handled: true, damage: multiplier > 0 ? damage : 0 }
  }

  // ── 드래곤테일 (강제교체 + 데미지) ──────────────────────────
  if (moveInfo.dragonTail) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"))
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (critical)       logs.push("급소에 맞았다!")
    if (tPkmn.hp <= 0) {
      logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    } else {
      // 살아있으면 강제 교체
      const tEntry     = entries[tSlot]
      const tIdx       = data[`${tSlot}_active_idx`] ?? 0
      const benchAlive = tEntry.map((p, i) => i !== tIdx && p.hp > 0 ? i : -1).filter(i => i !== -1)
      if (benchAlive.length > 0) {
        const randIdx = benchAlive[Math.floor(Math.random() * benchAlive.length)]
        logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 드래곤테일에 날아갔다!`)
        logs.push(`${tEntry[randIdx].name}${josa(tEntry[randIdx].name, "이가")} 나왔다!`)
        data[`${tSlot}_active_idx`] = randIdx
      }
    }
    return { handled: true, damage }
  }

  // ── 속임수 (공격/방어 서로 교환) ─────────────────────────────
  if (moveInfo.trickster) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"))
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    tPkmn.hp = Math.max(0, tPkmn.hp - damage)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (critical)       logs.push("급소에 맞았다!")
    // 공격·방어 스탯 교환
    const tmpAtk = myPkmn.attack;  myPkmn.attack  = tPkmn.attack;  tPkmn.attack  = tmpAtk
    const tmpDef = myPkmn.defense; myPkmn.defense = tPkmn.defense; tPkmn.defense = tmpDef
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "과와")} ${tPkmn.name}의 스탯이 교환됐다!`)
    if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    return { handled: true, damage }
  }

  // ── 병상첨병 (상대 상태이상이면 추가 데미지) ─────────────────
  if (moveInfo.sickPower) {
    const { hit } = calcHit(myPkmn, moveInfo, tPkmn)
    if (!hit) { logs.push("빗나갔다!"); return { handled: true, damage: 0 } }
    const mult     = tPkmn.status ? 2 : 1
    const { damage, multiplier, critical } = calcDamage(myPkmn, moveName, tPkmn,
      getActiveRank(myPkmn, "atk"), getActiveRank(tPkmn, "def"))
    if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); return { handled: true, damage: 0 } }
    const finalDmg = Math.floor(damage * mult)
    tPkmn.hp = Math.max(0, tPkmn.hp - finalDmg)
    if (multiplier > 1) logs.push("효과가 굉장했다!")
    if (critical)       logs.push("급소에 맞았다!")
    if (mult > 1)       logs.push(`${tPkmn.name}${josa(tPkmn.name, "의")} 상태이상이 약점이 됐다!`)
    if (tPkmn.hp <= 0)  logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
    return { handled: true, damage: finalDmg }
  }

  // ── 뒀다쓰기 (다른 기술을 모두 사용했을 때만 발동) ───────────
  if (moveInfo.lastResort) {
    const usedMoves  = myPkmn.usedMoves ?? []
    const otherMoves = (myPkmn.moves ?? []).filter(m => m.name !== moveName)
    const allUsed    = otherMoves.every(m => usedMoves.includes(m.name)) && usedMoves.length > 0
    if (!allUsed) {
      logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 아직 다른 기술을 쓰지 않았다!`)
      return { handled: true, damage: 0 }
    }
    return { handled: false, damage: 0 }  // 일반 데미지로
  }

  return { handled: false, damage: 0 }
}

// ── EOT 씨뿌리기 처리 ─────────────────────────────────────────────────
async function applyLeechSeedEot(entries, data, logs) {
  // 각 슬롯의 active 포켓몬 중 seeded된 것 처리
  for (const tSlot of ALL_FS) {
    const tIdx  = data[`${tSlot}_active_idx`] ?? 0
    const tPkmn = entries[tSlot][tIdx]
    if (!tPkmn || !tPkmn.seeded || tPkmn.hp <= 0) continue

    const seederSlot = tPkmn.seederSlot
    if (!seederSlot) continue
    const sIdx  = data[`${seederSlot}_active_idx`] ?? 0
    const sPkmn = entries[seederSlot][sIdx]

    const dmg = Math.max(1, Math.floor((tPkmn.maxHp ?? tPkmn.hp) * 0.1))
    tPkmn.hp  = Math.max(0, tPkmn.hp - dmg)
    logs.push(`씨뿌리기가 ${tPkmn.name}${josa(tPkmn.name, "의")} 체력을 빼앗는다!`)
    if (sPkmn && sPkmn.hp > 0) {
      sPkmn.hp = Math.min(sPkmn.maxHp ?? sPkmn.hp, sPkmn.hp + dmg)
      logs.push(`${sPkmn.name}${josa(sPkmn.name, "은는")} 체력을 흡수했다! (+${dmg})`)
    }
    if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
  }
}

// ── 메인 핸들러 ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

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
  if (myPkmn.hp <= 0) return res.status(403).json({ error: "포켓몬 기절 상태" })

  const moveData = myPkmn.moves?.[moveIdx]
  if (!moveData || moveData.pp <= 0) return res.status(403).json({ error: "사용 불가 기술" })

  // ── 어시스트 상태 확인 ──────────────────────────────────────
  const myTeam    = teamOf(mySlot)
  const assistKey = `assist_team${myTeam}`
  const assist    = data[assistKey] ?? null
  const isRequester       = assist && assist.requester === mySlot
  const supporterSlot     = isRequester ? assist.supporter : null
  let assistUsedThisTurn  = false

  const activatedSyncKeys = new Set()
  const logs              = []
  let hitDefender         = null
  let attackDiceRoll      = null

  // ── volatile 턴 수 감소 (신비의부적 etc.) ────────────────────
  if (typeof tickVolatiles === "function") {
    tickVolatiles(myPkmn).forEach(m => logs.push(m))
  }

  // ── 선행 상태이상 체크 ───────────────────────────────────────
  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logs.push(m))

  if (!pre.blocked) {
    // ── 혼란 체크 ────────────────────────────────────────────
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logs.push(m))

    if (!conf.selfHit) {
      // PP 소모
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }

      // 사용 기술 기록 (뒀다쓰기용)
      if (!myPkmn.usedMoves) myPkmn.usedMoves = []
      if (!myPkmn.usedMoves.includes(moveData.name)) myPkmn.usedMoves.push(moveData.name)

      // 사슬묶기 체크: 다른 기술 사용 불가
      if (myPkmn.chainBound && myPkmn.chainBound.turnsLeft > 0) {
        if (moveData.name !== myPkmn.chainBound.moveName) {
          logs.push(`${myPkmn.name}${josa(myPkmn.name, "은는")} 사슬에 묶여서 ${moveData.name}${josa(moveData.name, "을를")} 사용할 수 없다!`)
          // 기술 발동 취소 (PP는 이미 소모, 턴만 넘김)
          tickRanks(myPkmn, logs)
          const newOrder     = (data.current_order ?? []).slice(1)
          const newTurnCount = (data.turn_count ?? 1) + 1
          const isEot        = newOrder.length === 0
          await writeLogs(db, roomId, logs)
          const update = {
            ...buildEntryUpdate(entries),
            current_order: newOrder, turn_count: newTurnCount,
            hit_event: null, dice_event: null, attack_dice_event: null
          }
          if (isEot) {
            const win = await handleEot(db, roomId, entries, data, update)
            await roomRef.update(update)
            return res.status(200).json({ ok: true, ...(win ? { winTeam: win } : {}) })
          }
          await roomRef.update(update)
          return res.status(200).json({ ok: true })
        }
        myPkmn.chainBound.turnsLeft--
        if (myPkmn.chainBound.turnsLeft <= 0) {
          myPkmn.chainBound = null
          logs.push(`${myPkmn.name}${josa(myPkmn.name, "의")} 사슬이 풀렸다!`)
        }
      }

      const moveInfo = moves[moveData.name]
      logs.push(`${myPkmn.name}의 ${moveData.name}!`)

      const tSlots = targetSlots ?? []

      // ── 비공격 기술 ────────────────────────────────────────
      if (!moveInfo?.power) {
        const r              = moveInfo?.rank
        const targetsEnemy   = r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined)

        // 특수 비공격 기술 먼저 처리
        const specialResult = handleSpecialNonAttack(moveInfo, moveData.name, myPkmn, tSlots, entries, data, logs)

        if (!specialResult.handled) {
          // 일반 랭크/효과 처리
          if (tSlots.length > 0) {
            for (const tSlot of tSlots) {
              const tIdx  = data[`${tSlot}_active_idx`] ?? 0
              const tPkmn = entries[tSlot][tIdx]
              if (!tPkmn || tPkmn.hp <= 0) continue
              if (targetsEnemy) {
                const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
                if (!hit) { logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!"); continue }
              }
              applyRankStack(myPkmn, moveData.name, r ?? null, tPkmn, logs)
              applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, 0).forEach(m => logs.push(m))
            }
          } else {
            // 자신 대상
            if (!moveInfo?.alwaysHit && Math.random() * 100 >= (moveInfo?.accuracy ?? 100)) {
              logs.push(`그러나 ${myPkmn.name}의 기술은 실패했다!`)
            } else {
              applyRankStack(myPkmn, moveData.name, r ?? null, myPkmn, logs)
              applyMoveEffect(moveInfo?.effect, myPkmn, myPkmn, 0).forEach(m => logs.push(m))
            }
          }
        }

      } else {
        // ── 공격 기술 ──────────────────────────────────────
        const isAoe = tSlots.length >= 2

        for (const tSlot of tSlots) {
          const tIdx  = data[`${tSlot}_active_idx`] ?? 0
          const tPkmn = entries[tSlot][tIdx]
          if (!tPkmn || tPkmn.hp <= 0) continue

          // 방어 체크
          if (tPkmn.defending) {
            logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 방어했다!`)
            continue
          }

          // 특수 공격 기술 처리
          const specialAtk = handleSpecialAttack(moveInfo, moveData.name, myPkmn, tSlot, tPkmn, entries, data, logs)
          if (specialAtk.handled) {
            if (specialAtk.damage > 0) {
              hitDefender = tSlot
              // 카운터/원수갚기 등은 dice가 없지만 일단 null
            }
            continue
          }

          // ── 일반 공격 ──────────────────────────────────
          const { hit, hitType } = calcHit(myPkmn, moveInfo, tPkmn)
          if (!hit) {
            logs.push(hitType === "evaded" ? `${tPkmn.name}에게는 맞지 않았다!` : "빗나갔다!")
            continue
          }

          hitDefender = tSlot
          const atkRank = getActiveRank(myPkmn, "atk")
          const defRank = getActiveRank(tPkmn,  "def")
          let { damage, multiplier, critical, dice } = calcDamage(myPkmn, moveData.name, tPkmn, atkRank, defRank)
          attackDiceRoll = dice

          if (multiplier === 0) { logs.push(`${tPkmn.name}${josa(tPkmn.name, "에게는")} 효과가 없다…`); continue }

          // 어시스트 보정
          if (isRequester) { damage = Math.floor(damage * 1.15); assistUsedThisTurn = true }

          // ── 싱크로나이즈 처리 ──────────────────────────
          const tTeam        = teamOf(tSlot)
          const syncKey      = `sync_team${tTeam}`
          const sync         = data[syncKey] ?? null
          const tIsInSync    = sync && (sync.requester === tSlot || sync.supporter === tSlot)
          const syncAllySlot = tIsInSync ? (sync.requester === tSlot ? sync.supporter : sync.requester) : null
          const syncAllyPkmn = syncAllySlot ? entries[syncAllySlot]?.[data[`${syncAllySlot}_active_idx`] ?? 0] : null

          let mainDmg = damage, spillDmg = 0
          if (tIsInSync && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            activatedSyncKeys.add(syncKey)
            if (isAoe) {
              mainDmg = Math.max(1, Math.floor(damage * 0.75))
              logs.push("__SYNC_EVENT__")
              logs.push(`💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name, "은는")} 피해를 분산했다! (×0.75)`)
            } else {
              mainDmg  = Math.max(1, Math.floor(damage * 0.60))
              spillDmg = Math.max(1, Math.floor(damage * 0.40))
              logs.push("__SYNC_EVENT__")
              logs.push(`💠 싱크로나이즈! ${tPkmn.name}${josa(tPkmn.name, "과와")} ${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "이가")} 피해를 분산했다!`)
            }
          }

          // 버티기 체크
          if (tPkmn.enduring && mainDmg >= tPkmn.hp) {
            mainDmg = tPkmn.hp - 1
            logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 버텼다!`)
          }
          tPkmn.enduring = false

          tPkmn.hp = Math.max(0, tPkmn.hp - mainDmg)

          // 타입 상성 / 급소 / 어시스트 로그
          if (multiplier > 1) logs.push("효과가 굉장했다!")
          if (multiplier < 1) logs.push("효과가 별로인 듯하다…")
          if (critical)       logs.push("급소에 맞았다!")
          if (isRequester && assistUsedThisTurn) logs.push("어시스트 효과로 위력이 올라갔다!")

          // 부가효과 (드레인/상태이상 등)
          applyMoveEffect(moveInfo?.effect, myPkmn, tPkmn, mainDmg).forEach(m => logs.push(m))

          // 공격 부가 랭크변화
          if (moveInfo?.rank) applyRankChanges(moveInfo.rank, myPkmn, tPkmn).forEach(m => logs.push(m))

          // 쓰러짐 체크
          if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)

          // 싱크 스필 데미지
          if (spillDmg > 0 && syncAllyPkmn && syncAllyPkmn.hp > 0) {
            if (syncAllyPkmn.enduring && spillDmg >= syncAllyPkmn.hp) {
              spillDmg = syncAllyPkmn.hp - 1
              logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "은는")} 버텼다!`)
            }
            syncAllyPkmn.enduring = false
            syncAllyPkmn.hp = Math.max(0, syncAllyPkmn.hp - spillDmg)
            logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "도")} ${spillDmg}의 피해를 받았다!`)
            if (syncAllyPkmn.hp <= 0) logs.push(`${syncAllyPkmn.name}${josa(syncAllyPkmn.name, "은는")} 쓰러졌다!`)
          }

          // 어시스트 추가 공격
          if (isRequester && assistUsedThisTurn && supporterSlot) {
            const supPkmn = entries[supporterSlot]?.[data[`${supporterSlot}_active_idx`] ?? 0]
            if (supPkmn && supPkmn.hp > 0 && tPkmn.hp > 0) {
              logs.push("__ASSIST_EVENT__")
              const bonusDmg = Math.max(1, Math.floor(damage * 0.3))
              tPkmn.hp = Math.max(0, tPkmn.hp - bonusDmg)
              logs.push(`${supPkmn.name}${josa(supPkmn.name, "이가")} 연속으로 추가 공격했다! (${bonusDmg} 데미지)`)
              if (tPkmn.hp <= 0) logs.push(`${tPkmn.name}${josa(tPkmn.name, "은는")} 쓰러졌다!`)
            }
          }

          // 받은 데미지 기록 (카운터/원수갚기용)
          tPkmn.lastReceivedDamage = mainDmg
        }
      }
    } // end !conf.selfHit
  } // end !pre.blocked

  // 구르기가 아닌 다른 기술 사용 시 구르기 상태 초기화
  if (!moves[moveData.name]?.rollout && myPkmn.rollState?.active) {
    myPkmn.rollState = { active: false, turn: 0 }
    logs.push(`${myPkmn.name}${josa(myPkmn.name, "의")} 구르기가 끊겼다!`)
  }

  // 랭크 전용 기술이 아닌 다른 기술 사용 시 랭크 스택 초기화
  if (moves[moveData.name]?.power || !moves[moveData.name]?.rank) {
    myPkmn.lastRankMove = null
    myPkmn.rankStack    = 0
  }

  tickRanks(myPkmn, logs)

  // ── 어시스트 업데이트 ─────────────────────────────────────
  const assistUpdate = {}
  if (isRequester) {
    assistUpdate[assistKey]             = null
    assistUpdate[`assist_used_${myTeam}`] = true
    if (!assistUsedThisTurn) logs.push("어시스트 효과가 사라졌다...")
  }

  // ── 싱크 업데이트 ────────────────────────────────────────
  const syncUpdate = {}
  activatedSyncKeys.forEach(k => {
    const team = k.replace("sync_team", "")
    syncUpdate[k]                    = null
    syncUpdate[`sync_used_${team}`]  = true
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

  // 울부짖기/드래곤테일로 active_idx가 변경된 경우 반영
  ALL_FS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) {
      update[`${s}_active_idx`] = data[`${s}_active_idx`]
    }
  })

  // 승리 체크
  const winTeam = checkWin(entries)
  if (winTeam) {
    update.game_over     = true
    update.winner_team   = winTeam
    update.current_order = []
    await roomRef.update(update)
    return res.status(200).json({ ok: true, winTeam })
  }

  if (isEot) {
    // EOT 씨뿌리기
    const eotLogs = []
    await applyLeechSeedEot(entries, data, eotLogs)
    if (eotLogs.length > 0) {
      Object.assign(update, buildEntryUpdate(entries))
      const logsRef = db.collection("double").doc(roomId).collection("logs")
      const base    = Date.now()
      const batch   = db.batch()
      eotLogs.forEach((text, i) => batch.set(logsRef.doc(), { text, ts: base + i }))
      await batch.commit()
    }

    const win = await handleEot(db, roomId, entries, data, update)
    if (win) {
      await roomRef.update(update)
      return res.status(200).json({ ok: true, winTeam: win })
    }
  }

  await roomRef.update(update)
  return res.status(200).json({ ok: true })
}