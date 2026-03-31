import { db } from "../lib/firestore.js"
import { corsHeaders } from "../lib/gameUtils.js"

export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k,v))
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).end()

  const { roomId } = req.body
  if(!roomId) return res.status(400).json({ error: "roomId 필요" })

  await db.collection("double").doc(roomId).update({ sync_request: null })
  return res.status(200).json({ ok:true })
}