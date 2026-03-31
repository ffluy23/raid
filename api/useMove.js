import { db } from "../lib/firestore.js"
import { moves } from "../lib/moves.js"
import { getTypeMultiplier } from "../lib/typeChart.js"
import {
  josa, applyMoveEffect, checkPreActionStatus,
  checkConfusion, applyEndOfTurnDamage, getStatusSpdPenalty
} from "../lib/effecthandler.js"
import {
  ALL_FS, deepCopyEntries, buildEntryUpdate, checkWin, collectFaintedSlots,
  teamOf, allySlot, roomName, rollD10, getActiveRank, writeLogs, corsHeaders
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

function calcDamage(atk, moveName, def, atkRank=0, defRank=0) {
  const move = moves[moveName]
  if(!move) return { damage:0, multiplier:1, stab:false, critical:false, dice:0 }
  const dice     = rollD10()
  const defTypes = Array.isArray(def.type) ? def.type : [def.type]
  let mult = 1
  for(const dt of defTypes) mult *= getTypeMultiplier(move.type, dt)
  if(mult === 0) return { damage:0, multiplier:0, stab:false, critical:false, dice }
  const atkTypes = Array.isArray(atk.type) ? atk.type : [atk.type]
  const stab     = atkTypes.includes(move.type)
  const base     = (move.power ?? 40) + (atk.attack ?? 3)*4 + dice
  const raw      = Math.floor(base * mult * (stab ? 1.3 : 1))
  const afterAtk = Math.max(0, raw + Math.max(-raw, atkRank))
  const afterDef = Math.max(0, afterAtk - (def.defense ?? 3)*5)
  const baseDmg  = Math.max(0, afterDef - Math.min(3, Math.max(0, defRank))*3)
  const critical  = Math.random()*100 < Math.min(100, (atk.attack ?? 3)*2)
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
  const isRequester   = assist && assist.requester === mySlot
  const supporterSlot = isRequester ? assist.supporter : null

  const logs = []
  let hitDefender        = null
  let attackDiceRoll     = null
  let assistUsedThisTurn = false
  const activatedSyncKeys = new Set()

  const pre = checkPreActionStatus(myPkmn)
  pre.msgs.forEach(m => logs.push(m))

  if(!pre.blocked) {
    const conf = checkConfusion(myPkmn)
    conf.msgs.forEach(m => logs.push(m))

    if(!conf.selfHit) {
      myPkmn.moves[moveIdx] = { ...moveData, pp: moveData.pp - 1 }
      const moveInfo = moves[moveData.name]
      logs.push(`${myPkmn.name}의 ${moveData.name}!`)

      const tSlots = targetSlots ?? []

      if(!moveInfo?.power) {
        const r = moveInfo?.rank
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
      } else {
        const isAoe = tSlots.length >= 2
        for(const tSlot of tSlots) {
          const tIdx  = data[`${tSlot}_active_idx`] ?? 0
          const tPkmn = entries[tSlot][tIdx]
          if(!tPkmn || tPkmn.hp <= 0) continue

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

          if(multiplier === 0) { logs.push(`${tPkmn.name}에게는 효과가 없다…`); continue }

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
    assistUpdate[assistKey] = null
    if(!assistUsedThisTurn) logs.push("어시스트 효과가 사라졌다...")
  }
  const syncUpdate = {}
  activatedSyncKeys.forEach(k => { syncUpdate[k] = null })

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

  const winTeam = checkWin(entries)
  if(winTeam) {
    update.game_over = true; update.winner_team = winTeam; update.current_order = []
    await roomRef.update(update)
    return res.status(200).json({ ok:true, winTeam })
  }

  if(isEot) {
    const win = await handleEot(db, roomId, entries, data, update)
    if(win) { await roomRef.update(update); return res.status(200).json({ ok:true, winTeam: win }) }
  }

  await roomRef.update(update)
  return res.status(200).json({ ok:true })
}