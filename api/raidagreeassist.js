// api/raidAgreeAssist.js
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

  const req_ = data.assist_request
  if (!req_)                       return res.status(403).json({ error: "요청 없음" })
  if (req_.from === mySlot)        return res.status(403).json({ error: "본인은 동의 불가" })
  if ((req_.agrees ?? []).includes(mySlot))
    return res.status(403).json({ error: "이미 동의함" })

  // 내 포켓몬 살아있는지 체크
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0)
    return res.status(403).json({ error: "내 포켓몬이 쓰러진 상태" })

  const myName    = data[`${mySlot.replace("p", "player")}_name`] ?? mySlot
  const newAgrees = [...(req_.agrees ?? []), mySlot]

  // 나 제외 나머지 플레이어 수 (신청자 포함 동의가 필요한 인원)
 const othersCount = PLAYER_SLOTS.filter(s => {
  if (s === req_.from) return false
  const idx  = data[`${s}_active_idx`] ?? 0
  const pkmn = data[`${s}_entry`]?.[idx]
  return pkmn && pkmn.hp > 0  // 살아있는 플레이어만 카운트
}).length  // 2명
  const activated   = newAgrees.length >= othersCount  // 2명 다 동의하면 발동

  if (activated) {
    await roomRef.update({
      assist_request:      null,
      assist_active:       true,
      assist_request_from: req_.from,
      assist_used:         false,
    })
    await writeLogs(roomId, [
      `🤝 어시스트 발동! ${req_.fromName}${josa(req_.fromName, "이가")} 전투에서 강해진다! 믿을게!`
    ])
  } else {
    await roomRef.update({ assist_request: { ...req_, agrees: newAgrees } })
    await writeLogs(roomId, [
      `${myName}${josa(myName, "이가")} 어시스트에 동의했다! (${newAgrees.length}/${othersCount})`
    ])
  }

  return res.status(200).json({ ok: true, activated })
}