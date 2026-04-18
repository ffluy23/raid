// api/raidLeaveGame.js
import { db } from "../lib/firestore.js"
import { corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId } = req.body
  if (!roomId) return res.status(400).json({ error: "roomId 필요" })

  const roomRef = db.collection("raid").doc(roomId)
  const logsRef = db.collection("raid").doc(roomId).collection("logs")

  // 배틀 로그 삭제 (채팅은 보존)
  const logSnap = await logsRef.get()
  if (!logSnap.empty) {
    const batch = db.batch()
    logSnap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit()
  }

  await roomRef.update({
    // ── 플레이어 슬롯 초기화 ──────────────────────────────────
    player1_uid: null, player1_name: null, player1_ready: false,
    player2_uid: null, player2_name: null, player2_ready: false,
    player3_uid: null, player3_name: null, player3_ready: false,
    spectators: [], spectator_names: [],

    // ── 게임 상태 초기화 ─────────────────────────────────────
    game_started:    false,
    game_over:       false,
    game_started_at: null,
    raid_result:     null,
    round_count:     0,
    turn_count:      0,
    current_order:   [],

    // ── 엔트리 초기화 ────────────────────────────────────────
    p1_entry: null, p1_active_idx: 0,
    p2_entry: null, p2_active_idx: 0,
    p3_entry: null, p3_active_idx: 0,

    // ── 보스 상태 초기화 ─────────────────────────────────────
    boss_current_hp:   null,
    boss_status:       null,
    boss_rank:         null,
    boss_volatile:     null,
    boss_state:        null,
    boss_last_move:    null,
    boss_last_attacker: null,
    boss_damage_taken: null,
    boss_ult_cooldown: 0,

    // ── 어시스트 초기화 ──────────────────────────────────────
    assist_request:      null,
    assist_active:       false,
    assist_request_from: null,
    assist_used:         false,

    // ── 싱크로 초기화 ────────────────────────────────────────
    sync_request: null,
    sync_active:  false,
    sync_used:    false,

    // ── 유턴 강제교체 초기화 ─────────────────────────────────
    force_switch_p1: false,
    force_switch_p2: false,
    force_switch_p3: false,

    // ── 인트로 초기화 ────────────────────────────────────────
    intro_done:       false,
    intro_ready_p1:   false,
    intro_ready_p2:   false,
    intro_ready_p3:   false,
    boss_portrait_url: null,

    // ── 구역 선택 초기화 ─────────────────────────────────────
    selected_zone: null,

    // ── 이벤트 초기화 ────────────────────────────────────────
    dice_event: null,
    umbreon_used: false,
  })

  return res.status(200).json({ ok: true })
}