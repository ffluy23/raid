import { db } from "../lib/firebase-admin.js"
import { FieldValue } from "firebase-admin/firestore"

const ROOMS = ["doublebattleroom1", "doublebattleroom2", "doublebattleroom3"]

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end()

  const { uid, name } = req.body
  if (!uid || !name) return res.status(400).json({ error: "uid/name 필요" })

  const queueRef = db.collection("matchmaking")

  try {
    // 1) 이미 매칭 완료됐는지 먼저 확인
    const myDoc = await queueRef.doc(uid).get()
    if (myDoc.exists && myDoc.data().status === "matched") {
      return res.json({ status: "matched", roomId: myDoc.data().roomId })
    }

    // 2) 대기열 등록 (없거나 waiting 아닌 경우)
    if (!myDoc.exists || myDoc.data().status !== "waiting") {
      await queueRef.doc(uid).set({
        uid, name,
        joinedAt: FieldValue.serverTimestamp(),
        status: "waiting",
        roomId: null,
      })
    }

    // 3) 대기열에서 4명 가져오기 (트랜잭션 밖에서)
    const waitingSnap = await queueRef
      .where("status", "==", "waiting")
      .orderBy("joinedAt")
      .limit(4)
      .get()

    if (waitingSnap.size < 4) {
      return res.json({ status: "waiting" })
    }

    const candidates = waitingSnap.docs.map(d => d.data())

    // 4) 트랜잭션: 재확인 + 룸 배정
    const result = await db.runTransaction(async (tx) => {
      // 4-1) 아직 waiting인지 각각 재확인
      const freshDocs = await Promise.all(
        candidates.map(p => tx.get(queueRef.doc(p.uid)))
      )
      const stillWaiting = freshDocs
        .map(d => d.data())
        .filter(d => d?.status === "waiting")

      if (stillWaiting.length < 4) return { status: "waiting" }

      // 4-2) 빈 룸 찾기
      let targetRoom = null
      for (const roomId of ROOMS) {
        const roomDoc = await tx.get(db.collection("double").doc(roomId))
        const data = roomDoc.data() || {}
        const playerCount = Object.keys(data.players || {}).length
        if (playerCount === 0) { targetRoom = roomId; break }
      }
      if (!targetRoom) return { status: "waiting", reason: "no_room" }

      // 4-3) 셔플 후 p1~p4 배정
      const shuffled = [...stillWaiting].sort(() => Math.random() - 0.5)
      const slots = ["p1", "p2", "p3", "p4"]
      const playersMap = {}
      shuffled.forEach((p, i) => {
        playersMap[slots[i]] = { uid: p.uid, name: p.name }
      })

      // 4-4) 룸 문서 초기화
     tx.set(db.collection("double").doc(targetRoom), {
  player1_uid: shuffled[0].uid, player1_name: shuffled[0].name, player1_ready: false,
  player2_uid: shuffled[1].uid, player2_name: shuffled[1].name, player2_ready: false,
  player3_uid: shuffled[2].uid, player3_name: shuffled[2].name, player3_ready: false,
  player4_uid: shuffled[3].uid, player4_name: shuffled[3].name, player4_ready: false,
  matchedAt: FieldValue.serverTimestamp(),
  game_started: false,
}, { merge: true })
      // 4-5) 대기열 유저들 matched 처리
      shuffled.forEach(p => {
        tx.update(queueRef.doc(p.uid), {
          status: "matched",
          roomId: targetRoom,
        })
      })

      return { status: "matched", roomId: targetRoom }
    })

    return res.json(result)

  } catch (e) {
    console.error("[matchmaking error]", e)
    return res.status(500).json({ error: e.message })
  }
}