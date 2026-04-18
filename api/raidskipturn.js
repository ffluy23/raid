// api/raidSkipTurn.js
import { db } from "../lib/firestore.js"
import { executeBossAction, deepCopyEntries as deepCopyRaidEntries2 } from "../lib/raidBossAction.js"
import { corsHeaders } from "../lib/gameUtils.js"

const PLAYER_SLOTS = ["p1", "p2", "p3"]

function deepCopyEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

function buildEntryUpdate(entries) {
  const update = {}
  PLAYER_SLOTS.forEach(s => { update[`${s}_entry`] = entries[s] })
  return update
}

function checkRaidWin(entries, bossHp) {
  if (bossHp <= 0) return "victory"
  const allDead = PLAYER_SLOTS.every(s => (entries[s] ?? []).every(p => p.hp <= 0))
  if (allDead) return "defeat"
  return null
}

async function writeLogs(roomId, texts) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  texts.forEach((text, i) => batch.set(logsRef.doc(), { type: "normal", text, ts: base + i }))
  await batch.commit()
}


// ── 보스 턴 연속 처리 ────────────────────────────────────────────────
async function runBossIfNext(roomId) {
  const snap = await db.collection("raid").doc(roomId).get()
  const freshData = snap.data()
  if (!freshData || freshData.game_over) return null
  const order = freshData.current_order ?? []
  if (order[0] !== "boss") return null
  const freshEntries = deepCopyRaidEntries2(freshData)
  return executeBossAction(roomId, freshData, freshEntries, order)
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
  if (!data.current_order || data.current_order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  const myEntry = data[`${mySlot}_entry`] ?? []

  // 포켓몬 전멸 상태여야만 스킵 가능
  if (!myEntry.every(p => p.hp <= 0))
    return res.status(403).json({ error: "포켓몬이 아직 살아있음" })

  const myName   = data[`${mySlot.replace("p", "player")}_name`] ?? mySlot
  const newOrder = (data.current_order ?? []).slice(1)
  const isEot    = newOrder.length === 0
  const entries  = deepCopyEntries(data)

  const logs = [`${myName}의 포켓몬이 모두 쓰러져 턴을 넘긴다...`]

  const update = {
    ...buildEntryUpdate(entries),
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
  }

  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined) update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  // EOT 처리
  if (isEot) {
    const result = checkRaidWin(entries, data.boss_current_hp ?? 0)
    if (result) {
      update.game_over     = true
      update.raid_result   = result
      update.current_order = []
      update.turn_started_at = null
    }
    update.boss_current_hp = data.boss_current_hp ?? 0
  }

  await writeLogs(roomId, logs)
  await roomRef.update(update)

  await runBossIfNext(roomId).catch(e => console.warn("보스 연속 처리 오류:", e.message))

  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)
  return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
}