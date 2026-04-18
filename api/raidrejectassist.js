// api/raidRejectAssist.js
import { db } from "../lib/firestore.js"
import { corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId, mySlot } = req.body
  if (!roomId) return res.status(400).json({ error: "roomId 필요" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })

  const req_ = data.assist_request
  if (!req_) return res.status(200).json({ ok: true })  // 이미 없으면 무시

  // 신청자 본인이 취소하거나, 동의 대상자가 거절
  await roomRef.update({ assist_request: null })
  return res.status(200).json({ ok: true })
}