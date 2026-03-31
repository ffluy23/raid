import { db } from "../lib/firestore.js"
import { rollD10, corsHeaders } from "../lib/gameUtils.js"

const ALL_FS = ["p1","p2","p3","p4"]

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId, mySlot } = req.body
  if(!roomId || !mySlot) return res.status(400).json({ error: "roomId/mySlot 필요" })

  const roomRef = db.collection("double").doc(roomId)

  try {
    const result = await db.runTransaction(async tx => {
      const snap = await tx.get(roomRef)
      const data = snap.data()
      if(!data)              return { ok:false, reason:"no_data" }
      if(!data.game_started) return { ok:false, reason:"not_started" }
      if(data.game_over)     return { ok:false, reason:"game_over" }
      if((data.current_order ?? []).length > 0) return { ok:false, reason:"already_started" }
      if((data.pending_switches ?? []).length > 0) return { ok:false, reason:"pending_switches" }

      const activeSlots = ALL_FS.filter(s => (data[`${s}_entry`] ?? []).some(p => p.hp > 0))
      if(activeSlots.length === 0) return { ok:false, reason:"no_active_slots" }

      const roundNum = (data.round_count ?? 0) + 1
      const rolls = {}, scores = {}
      activeSlots.forEach(s => {
        const idx  = data[`${s}_active_idx`] ?? 0
        const pkmn = data[`${s}_entry`]?.[idx]
        const spd  = (pkmn?.hp ?? 0) > 0 ? (pkmn?.speed ?? 3) : 0
        rolls[s]   = rollD10()
        scores[s]  = spd + rolls[s]
      })
      const order = [...activeSlots].sort((a,b) => {
        const diff = scores[b] - scores[a]
        return diff !== 0 ? diff : (Math.random() < 0.5 ? -1 : 1)
      })

      tx.update(roomRef, {
        round_count:   roundNum,
        current_order: order,
        dice_event: { type:"all", rolls, order, slots:activeSlots, ts:Date.now() }
      })
      return { ok:true, order, rolls, roundNum }
    })

    return res.status(200).json(result)
  } catch(e) {
    console.error("startRound error:", e)
    return res.status(500).json({ error: e.message })
  }
}