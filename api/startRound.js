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
  const logsRef = db.collection("double").doc(roomId).collection("logs")

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

      // ── turn_started_at: 첫 번째 턴 시작 시각 기록 ──────────
      tx.update(roomRef, {
        round_count:     roundNum,
        current_order:   order,
        turn_started_at: Date.now(),
        dice_event: { type:"all", rolls, order, slots:activeSlots, ts:Date.now() }
      })

      return { ok:true, order, rolls, roundNum, data }
    })

    if(!result.ok) return res.status(200).json(result)

    // ── 라운드 시작 로그 (트랜잭션 밖에서 batch 쓰기) ──
    const { order, rolls, roundNum, data } = result

    // 순서 문자열: "피카츄(p1) → 리자몽(p3) → ..."
    const orderStr = order.map(s => {
      const idx   = data[`${s}_active_idx`] ?? 0
      const pkmn  = data[`${s}_entry`]?.[idx]
      const slotKey = s.replace("p", "player")
      const player  = (data[`${slotKey}_name`] ?? s).split("]").pop().trim()
      return `${pkmn?.name ?? s}(${player})`
    }).join(" → ")

    // 1번 슬롯 선공자
    const firstSlot   = order[0]
    const firstIdx    = data[`${firstSlot}_active_idx`] ?? 0
    const firstPkmn   = data[`${firstSlot}_entry`]?.[firstIdx]
    const firstSlotKey = firstSlot.replace("p", "player")
    const firstName    = (data[`${firstSlotKey}_name`] ?? firstSlot).split("]").pop().trim()

    const base  = Date.now()
    const batch = db.batch()
    const logEntries = [
      { type: "normal", text: `── ROUND ${roundNum} ──`,                        ts: base },
      { type: "normal", text: `순서: ${orderStr}`,                              ts: base + 1 },
      { type: "normal", text: `${firstPkmn?.name ?? firstSlot}의 선공! (${firstName})`, ts: base + 2 },
    ]
    logEntries.forEach(entry => batch.set(logsRef.doc(), entry))
    await batch.commit()

    // data 필드는 응답에서 제외
    const { data: _d, ...safeResult } = result
    return res.status(200).json(safeResult)

  } catch(e) {
    console.error("startRound error:", e)
    return res.status(500).json({ error: e.message })
  }
}