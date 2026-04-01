import { db } from "../lib/firestore.js"
import { josa } from "../lib/effecthandler.js"
import {
  deepCopyEntries, buildEntryUpdate, roomName,
  writeLogs, handleEot, corsHeaders
} from "../lib/gameUtils.js"

function defaultRanks() {
  return { atk: 0, atkTurns: 0, def: 0, defTurns: 0, spd: 0, spdTurns: 0 }
}

/** 교체 나가는 포켓몬의 각종 상태 초기화 */
function resetOnSwitch(pkmn) {
  // 랭크 초기화
  pkmn.lastRankMove = null
  pkmn.rankStack    = 0
  if (pkmn.ranks) {
    pkmn.ranks = defaultRanks()
  }
  // 구르기 초기화
  pkmn.rollState = { active: false, turn: 0 }
  // 참기 취소
  pkmn.bideState = null
  // 씨뿌리기 해제 (교체 시 씨 상태 사라짐)
  pkmn.seeded = false
  // 방어 해제
  pkmn.defending  = false
  pkmn.defendTurns = 0
  // 혼란/풀죽음 유지 (교체해도 사라지지 않는 게 포켓몬 원작 룰이지만,
  //   필요시 아래 주석 해제하면 초기화됨)
  // pkmn.confusion = 0
  // pkmn.flinch    = false
  // 신비의부적·희망사항·날개쉬기 volatile은 유지
  // (원하면 여기서 초기화 가능)
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

  if (!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const entries   = deepCopyEntries(data)
  const myName    = data[`${roomName(mySlot)}_name`] ?? mySlot
  const activeIdx = data[`${mySlot}_active_idx`] ?? 0
  const prevPkmn  = entries[mySlot][activeIdx]
  const nextPkmn  = entries[mySlot][newIdx]

  if (!nextPkmn || nextPkmn.hp <= 0)
    return res.status(403).json({ error: "교체 대상 포켓몬이 없거나 기절 상태" })

  const prev = prevPkmn.name
  const next = nextPkmn.name

  // ── 교체 나가는 포켓몬 상태 초기화 ──────────────
  resetOnSwitch(prevPkmn)

  // 교체로 새로 나오는 포켓몬의 씨뿌리기는 해제
  // (씨 심은 쪽이 다르므로 유지해도 되지만 싱글 룰 따라 초기화)
  nextPkmn.seeded = false

  const logs = [
    `돌아와, ${prev}!`,
    `${myName}${josa(myName, "은는")} ${next}${josa(next, "을를")} 내보냈다!`
  ]

  const newOrder     = (data.current_order ?? []).slice(1)
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