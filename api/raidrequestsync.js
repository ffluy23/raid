// api/raidRequestSync.js
import { db } from "../lib/firestore.js"
import { corsHeaders } from "../lib/gameUtils.js"

const PLAYER_SLOTS = ["p1", "p2", "p3"]

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId, mySlot } = req.body
  if (!roomId || !mySlot) return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })
  if (!data.game_started || data.game_over)
    return res.status(403).json({ error: "게임 진행 중이 아님" })

  if (data.sync_used)    return res.status(403).json({ error: "이미 싱크로를 사용했음" })
  if (data.sync_active)  return res.status(403).json({ error: "싱크로가 이미 활성화됨" })
  if (data.sync_request) return res.status(403).json({ error: "이미 요청 중" })

  // 내 포켓몬 살아있는지 체크
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0)
    return res.status(403).json({ error: "내 포켓몬이 쓰러진 상태" })

  // 동의할 아군이 있는지
  const others = PLAYER_SLOTS.filter(s => s !== mySlot)
 const anyAllyAlive = others.some(s =>
  (data[`${s}_entry`] ?? []).some(p => p.hp > 0)
)
  if (!anyAllyAlive) return res.status(403).json({ error: "동의할 수 있는 아군이 없음" })

  const myName = data[`${mySlot.replace("p", "player")}_name`] ?? mySlot

  await roomRef.update({
    sync_request: {
      from:     mySlot,
      fromName: myName,
      agrees:   [],
      ts:       Date.now()
    }
  })
  return res.status(200).json({ ok: true })
}