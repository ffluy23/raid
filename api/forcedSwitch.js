import { db } from "../lib/firestore.js"
import { josa } from "../lib/effecthandler.js"
import {
  deepCopyEntries, buildEntryUpdate, roomName,
  writeLogs, corsHeaders
} from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot, newIdx } = req.body
  if(!roomId || !mySlot || newIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  const roomRef = db.collection("double").doc(roomId)
  let logText   = ""

  try {
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(roomRef)
      const data = snap.data()
      if(!data) throw new Error("방 없음")

      const pending = data.pending_switches ?? []
      if(!pending.includes(mySlot)) return { ok:false, reason:"not_pending" }

      const entries  = deepCopyEntries(data)
      const nextPkmn = entries[mySlot][newIdx]
      if(!nextPkmn || nextPkmn.hp <= 0) throw new Error("교체 대상 포켓몬 없음")

      const myName     = data[`${roomName(mySlot)}_name`] ?? mySlot
      const newPending = pending.filter(s => s !== mySlot)
      logText = `${myName}${josa(myName,"은는")} ${nextPkmn.name}${josa(nextPkmn.name,"을를")} 내보냈다!`

      tx.update(roomRef, {
        ...buildEntryUpdate(entries),
        [`${mySlot}_active_idx`]: newIdx,
        pending_switches: newPending
      })

      return { ok:true, remainingPending: newPending }
    })

    if(result.ok && logText) {
      await writeLogs(db, roomId, [logText])
    }

    return res.status(200).json(result)
  } catch(e) {
    console.error("forcedSwitch error:", e)
    return res.status(500).json({ error: e.message })
  }
}