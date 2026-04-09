import { db } from "../lib/firestore.js"
import { roomName, deepCopyEntries, writeLogs, handleEot, corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, timerExpired } = req.body
  if(!roomId || !mySlot) return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if(!data) return res.status(404).json({ error: "방 없음" })
  if(!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const myEntry     = data[`${mySlot}_entry`] ?? []
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = myEntry[myActiveIdx]

  // 타이머 만료가 아닌 일반 스킵은 포켓몬 전멸 상태여야 함
  if(!timerExpired && !myEntry.every(p => p.hp <= 0))
    return res.status(403).json({ error: "포켓몬이 아직 살아있음" })

  const pkmnName     = myPkmn?.name ?? mySlot
  const myName       = data[`${roomName(mySlot)}_name`] ?? mySlot
  const newOrder     = (data.current_order ?? []).slice(1)
  const newTurnCount = (data.turn_count ?? 1) + 1
  const isEot        = newOrder.length === 0
  const entries      = deepCopyEntries(data)

  // ── 로그 분기: 타이머 만료 vs 전멸 스킵 ──────────────────────
  const logs = timerExpired
    ? [`⏰ ${pkmnName}의 턴이 초과되어 자동으로 턴을 넘긴다!`]
    : [`${myName}의 포켓몬이 모두 쓰러져 턴을 넘긴다...`]

  const update = {
    current_order:     newOrder,
    turn_count:        newTurnCount,
    turn_started_at:   newOrder.length > 0 ? Date.now() : null,
    hit_event:         null,
    dice_event:        null,
    attack_dice_event: null
  }

  if(isEot) {
    const win = await handleEot(db, roomId, entries, data, update)
    await writeLogs(db, roomId, logs)
    await roomRef.update(update)
    return res.status(200).json({ ok:true, ...(win ? { winTeam: win } : {}) })
  }

  await writeLogs(db, roomId, logs)
  await roomRef.update(update)
  return res.status(200).json({ ok:true })
}