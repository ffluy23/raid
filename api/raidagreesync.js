// api/raidAgreeSync.js
import { db } from "../lib/firestore.js"
import { josa } from "../lib/effecthandler.js"
import { corsHeaders } from "../lib/gameUtils.js"

const PLAYER_SLOTS = ["p1", "p2", "p3"]

async function writeLogs(roomId, texts) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  texts.forEach((text, i) => batch.set(logsRef.doc(), { type: "normal", text, ts: base + i }))
  await batch.commit()
}

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

  const req_ = data.sync_request
  if (!req_)                      return res.status(403).json({ error: "요청 없음" })
  if (req_.from === mySlot)       return res.status(403).json({ error: "본인은 동의 불가" })
  if ((req_.agrees ?? []).includes(mySlot))
    return res.status(403).json({ error: "이미 동의함" })

  // 내 포켓몬 살아있는지 체크
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0)
    return res.status(403).json({ error: "내 포켓몬이 쓰러진 상태" })

  const myName    = data[`${mySlot.replace("p", "player")}_name`] ?? mySlot
  const newAgrees = [...(req_.agrees ?? []), mySlot]

 const othersCount = PLAYER_SLOTS.filter(s => {
  if (s === req_.from) return false
  const idx  = data[`${s}_active_idx`] ?? 0
  const pkmn = data[`${s}_entry`]?.[idx]
  return pkmn && pkmn.hp > 0
}).length
  const activated   = newAgrees.length >= othersCount

  if (activated) {
    // 싱크로 발동 — 보스 공격 1회 데미지 분산 대기
    await roomRef.update({
      sync_request: null,
      sync_active:  true,
      sync_used:    false,
    })
    await writeLogs(roomId, [
      `💠 싱크로나이즈 발동! `
    ])
  } else {
    await roomRef.update({ sync_request: { ...req_, agrees: newAgrees } })
    await writeLogs(roomId, [
      `${myName}${josa(myName, "이가")} 싱크로에 동의했다! 연결 유지, 끊지 마!(${newAgrees.length}/${othersCount})`
    ])
  }

  return res.status(200).json({ ok: true, activated })
}