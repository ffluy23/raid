import { db } from "../lib/firestore.js"
import { josa } from "../lib/effecthandler.js"
import {
  deepCopyEntries, buildEntryUpdate, roomName,
  writeLogs, handleEot, corsHeaders
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
  pkmn.defending   = false
  pkmn.defendTurns = 0
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

  // 기절 상태인지 체크
  const isFainted = !prevPkmn || prevPkmn.hp <= 0

  // 기절 교체: 턴 체크 없이 허용
  // 일반 교체: 내 턴이어야 함
  if (!isFainted && order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  if (!nextPkmn || nextPkmn.hp <= 0)
    return res.status(403).json({ error: "교체 대상 포켓몬이 없거나 기절 상태" })

  const myName = data[`${roomName(mySlot)}_name`] ?? mySlot
  const prev   = prevPkmn?.name ?? "?"
  const next   = nextPkmn.name

  resetOnSwitch(prevPkmn)
  nextPkmn.seeded = false

  const logs = [
    `돌아와, ${prev}!`,
    `${myName}${josa(myName, "은는")} ${next}${josa(next, "을를")} 내보냈다!`
  ]

  // 기절 교체는 턴을 소모하지 않음
  if (isFainted) {
    await writeLogs(db, roomId, logs)
    await roomRef.update({
      ...buildEntryUpdate(entries),
      [`${mySlot}_active_idx`]: newIdx,
    })
    return res.status(200).json({ ok: true })
  }

  // 일반 교체는 기존대로 턴 소모
  const newOrder     = order.slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0

  const update = {
    ...buildEntryUpdate(entries),
    [`${mySlot}_active_idx`]: newIdx,
    current_order:     newOrder,
    turn_count:        newTurnCount,
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