import { db } from "../lib/firestore.js"
import { corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).end()

  const { roomId } = req.body
  if (!roomId) return res.status(400).json({ error: "roomId 필요" })

  const roomRef = db.collection("double").doc(roomId)
  const logsRef = db.collection("double").doc(roomId).collection("logs")

  // 배틀 로그만 삭제 (채팅은 보존 — ts 필터로 이전 게임 채팅 안 보임)
  const logSnap = await logsRef.get()
  if (!logSnap.empty) {
    const batch = db.batch()
    logSnap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  }

  await roomRef.update({
    player1_uid: null, player1_name: null, player1_ready: false,
    player2_uid: null, player2_name: null, player2_ready: false,
    player3_uid: null, player3_name: null, player3_ready: false,
    player4_uid: null, player4_name: null, player4_ready: false,
    spectators: [], spectator_names: [],
    game_started: false, game_over: false,
    game_started_at: null,
    winner_team: null,
    round_count: 0, turn_count: 0,
    current_order: [], pending_switches: [],
    p1_entry: null, p1_active_idx: 0,
    p2_entry: null, p2_active_idx: 0,
    p3_entry: null, p3_active_idx: 0,
    p4_entry: null, p4_active_idx: 0,
    hit_event: null, dice_event: null, attack_dice_event: null,
    assist_request: null,
    assist_teamA: null, assist_teamB: null,
    assist_used_A: false, assist_used_B: false,
    assist_event: null,
    sync_request: null,
    sync_teamA: null, sync_teamB: null,
    sync_used_A: false, sync_used_B: false,
    sync_event: null,
    sync_log_A: null, sync_log_B: null,
    // 인트로 초기화
    intro_done: false,
    intro_ready_p1: false,
    intro_ready_p2: false,
    intro_ready_p3: false,
    intro_ready_p4: false,
    background: null
  })

  return res.status(200).json({ ok: true })
}