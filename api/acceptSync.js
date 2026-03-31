import { db } from "../lib/firestore.js"
import { josa } from "../lib/effecthandler.js"
import { teamOf, roomName, corsHeaders } from "../lib/gameUtils.js"

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

  const syncReq = data.sync_request
  if(!syncReq || syncReq.to !== mySlot)
    return res.status(403).json({ error: "수락할 요청 없음" })

  const myTeam      = teamOf(mySlot)
  const myName      = data[`${roomName(mySlot)}_name`] ?? mySlot
  const syncLogText = `💠 ${syncReq.fromName}${josa(syncReq.fromName,"과와")} ${myName}${josa(myName,"이가")} 싱크로나이즈를 맺었다!`

  await roomRef.update({
    [`sync_team${myTeam}`]:  { requester: syncReq.from, requesterName: syncReq.fromName, supporter: mySlot, supporterName: myName },
    [`sync_used_${myTeam}`]: true,
    sync_request:            null,
    [`sync_log_${myTeam}`]:  syncLogText
  })
  return res.status(200).json({ ok:true })
}