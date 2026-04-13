import { db } from "../lib/firebase-admin.js"

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end()

  const { uid } = req.body
  if (!uid) return res.status(400).json({ error: "uid 필요" })

  try {
    const doc = await db.collection("matchmaking").doc(uid).get()
    // 이미 매칭된 경우엔 취소 불가
    if (doc.exists && doc.data().status === "matched") {
      return res.json({ ok: false, reason: "already_matched" })
    }
    await db.collection("matchmaking").doc(uid).delete()
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}