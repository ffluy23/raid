import { db } from "../lib/firestore.js"
import { josa, applyStatus } from "../lib/effecthandler.js"
import {
  deepCopyEntries, buildEntryUpdate, roomName,
  writeLogs, handleEot, corsHeaders, teamOf
} from "../lib/gameUtils.js"

function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

function resetOnSwitch(pkmn) {
  pkmn.lastRankMove = null
  pkmn.rankStack    = 0
  if (pkmn.ranks) pkmn.ranks = defaultRanks()
  pkmn.rollState   = { active: false, turn: 0 }
  pkmn.bideState   = null
  pkmn.seeded      = false
  pkmn.defending     = false
  pkmn.defendTurns   = 0
  pkmn.aquaRing      = false
  pkmn.cursed        = false
  pkmn.futureSight   = null
  pkmn.healBlocked   = 0
  pkmn.throatChopped = 0
  pkmn.tormented     = false
  pkmn.outrageState  = null
  pkmn.hyperBeamState = false
}

// 문자열 배열로 반환 (writeLogs가 string[] 기대)
function applyEntryHazards(slot, entries, data) {
  const logs      = []
  const team      = teamOf(slot)
  const activeIdx = data[`${slot}_active_idx`] ?? 0
  const pkmn      = entries[slot][activeIdx]
  if (!pkmn || pkmn.hp <= 0) return logs

  // 스텔스록
  const srKey = `field_${team}_stealth_rock`
  if ((data[srKey] ?? 0) > 0) {
    const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.125))
    pkmn.hp = Math.max(0, pkmn.hp - dmg)
    logs.push(`스텔스록이 ${pkmn.name}${josa(pkmn.name, "을를")} 공격했다! (-${dmg})`)
    if (pkmn.hp <= 0) logs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`)
  }

  // 독압정
  const tsKey = `field_${team}_toxic_spikes`
  const tsVal = data[tsKey] ?? 0
  if (tsVal > 0 && pkmn.hp > 0 && !pkmn.status) {
    const pkmnTypes = Array.isArray(pkmn.type) ? pkmn.type : [pkmn.type]
    if (!pkmnTypes.includes("비행") && !pkmnTypes.includes("강철") && !pkmnTypes.includes("독")) {
      applyStatus(pkmn, "독").forEach(m => logs.push(m))
    }
  }

  return logs
}

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId, mySlot, newIdx } = req.body
  if (!roomId || !mySlot || newIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })

  const order     = data.current_order ?? []
  const activeIdx = data[`${mySlot}_active_idx`] ?? 0
  const entries   = deepCopyEntries(data)
  const prevPkmn  = entries[mySlot][activeIdx]
  const nextPkmn  = entries[mySlot][newIdx]

  const isFainted = !prevPkmn || prevPkmn.hp <= 0

  if (!isFainted && order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  if (!nextPkmn || nextPkmn.hp <= 0)
    return res.status(403).json({ error: "교체 대상 포켓몬이 없거나 기절 상태" })

  const myName = data[`${roomName(mySlot)}_name`] ?? mySlot
  const prev   = prevPkmn?.name ?? "?"
  const next   = nextPkmn.name

  resetOnSwitch(prevPkmn)
  nextPkmn.seeded = false

  // 장판 발동 — active_idx를 newIdx로 미리 반영해야 올바른 포켓몬에 적용됨
  data[`${mySlot}_active_idx`] = newIdx
  const hazardLogs = applyEntryHazards(mySlot, entries, data)

  const logs = [
    `돌아와, ${prev}!`,
    `${myName}${josa(myName, "은는")} ${next}${josa(next, "을를")} 내보냈다!`,
    ...hazardLogs
  ]

  // 기절 교체: 턴 소모 없음
  if (isFainted) {
    await writeLogs(db, roomId, logs)
    await roomRef.update({
      ...buildEntryUpdate(entries),
      [`${mySlot}_active_idx`]: newIdx,
    })
    return res.status(200).json({ ok: true })
  }

  // 일반 교체: 턴 소모
  const newOrder     = order.slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0

  const update = {
    ...buildEntryUpdate(entries),
    [`${mySlot}_active_idx`]: newIdx,
    current_order:     newOrder,
    turn_count:        newTurnCount,
    turn_started_at:   newOrder.length > 0 ? Date.now() : null,
    hit_event:         null,
    dice_event:        null,
    attack_dice_event: null
  }

  if (isEot) {
    const win = await handleEot(db, roomId, entries, data, update)
    await writeLogs(db, roomId, logs)
    await roomRef.update(update)
    return res.status(200).json({ ok: true, ...(win ? { winTeam: win } : {}) })
  }

  await writeLogs(db, roomId, logs)
  await roomRef.update(update)
  return res.status(200).json({ ok: true })
}