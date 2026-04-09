import { db } from "../lib/firestore.js"
import { teamOf, allySlot, roomName, corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot } = req.body
  if(!roomId || !mySlot) return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if(!data) return res.status(404).json({ error: "방 없음" })
  if(!data.game_started || data.game_over)
    return res.status(403).json({ error: "게임 진행 중이 아님" })

  const myTeam = teamOf(mySlot)
  if(data[`sync_used_${myTeam}`]) return res.status(403).json({ error: "이미 동기화를 사용했음" })
  if(data[`sync_team${myTeam}`])  return res.status(403).json({ error: "동기화가 이미 활성화됨" })
  if(data.sync_request)           return res.status(403).json({ error: "이미 요청 중" })

  // ── 내 포켓몬이 살아있는지 체크 ──────────────────────────────
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  if(!myPkmn || myPkmn.hp <= 0)
    return res.status(403).json({ error: "내 포켓몬이 쓰러진 상태" })

  // ── 아군 포켓몬이 살아있는지 체크 ────────────────────────────
  const ally          = allySlot(mySlot)
  const allyActiveIdx = data[`${ally}_active_idx`] ?? 0
  const allyPkmn      = data[`${ally}_entry`]?.[allyActiveIdx]
  if(!allyPkmn || allyPkmn.hp <= 0)
    return res.status(403).json({ error: "아군 포켓몬이 쓰러진 상태" })

  const myName   = data[`${roomName(mySlot)}_name`] ?? mySlot
  const allyName = data[`${roomName(ally)}_name`]   ?? ally

  await roomRef.update({
    sync_request: { from: mySlot, fromName: myName, to: ally, toName: allyName, ts: Date.now() }
  })
  return res.status(200).json({ ok: true })
}