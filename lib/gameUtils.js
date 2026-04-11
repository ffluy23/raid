export const ALL_FS = ["p1","p2","p3","p4"]
export const TEAM_A = ["p1","p2"]
export const TEAM_B = ["p3","p4"]

export function teamOf(s)      { return TEAM_A.includes(s) ? "A" : "B" }
export function allySlot(s)    { return s==="p1"?"p2": s==="p2"?"p1": s==="p3"?"p4": "p3" }
export function roomName(s)    { return s.replace("p","player") }
export function rollD10()      { return Math.floor(Math.random()*10)+1 }
export function defaultRanks() { return { atk:0,atkTurns:0,def:0,defTurns:0,spd:0,spdTurns:0 } }

export function getActiveRank(pkmn, key) {
  const r = pkmn.ranks ?? {}
  return (r[`${key}Turns`] ?? 0) > 0 ? (r[key] ?? 0) : 0
}

export function deepCopyEntries(data) {
  const e = {}
  ALL_FS.forEach(s => {
    e[s] = (data[`${s}_entry`] ?? []).map(p => ({
      ...p,
      moves: (p.moves ?? []).map(m => ({...m})),
      ranks: { ...defaultRanks(), ...(p.ranks ?? {}) }
    }))
  })
  return e
}

function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize)
  if (obj !== null && typeof obj === "object") {
    const result = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k] = v === undefined ? null : sanitize(v)
    }
    return result
  }
  return obj
}

export function buildEntryUpdate(entries) {
  const u = {}
  ALL_FS.forEach(s => { u[`${s}_entry`] = sanitize(entries[s]) })
  return u
}

export function checkWin(entries) {
  const aAllDead = entries.p1.every(p=>p.hp<=0) && entries.p2.every(p=>p.hp<=0)
  const bAllDead = entries.p3.every(p=>p.hp<=0) && entries.p4.every(p=>p.hp<=0)
  if(aAllDead) return "B"
  if(bAllDead) return "A"
  return null
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
}

export async function writeLogs(db, roomId, msgs) {
  const filtered = msgs.filter(t =>
    t !== "__ASSIST_EVENT__" &&
    t !== "__SYNC_EVENT__" &&
    !t.startsWith("__DICE__")
  )
  if(!filtered.length) return { assistEventTs: null, syncEventTs: null }
  const logsRef = db.collection("double").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  let assistEventTs = null
  let syncEventTs   = null
  msgs.forEach((text, i) => {
    if(text === "__ASSIST_EVENT__") { assistEventTs = base + i; return }
    if(text === "__SYNC_EVENT__")   { syncEventTs   = base + i; return }
    if(text.startsWith("__DICE__")) { return }
    batch.set(logsRef.doc(), { text, ts: base + i })
  })
  await batch.commit()
  return { assistEventTs, syncEventTs }
}

export async function handleEot(db, roomId, entries, data, update) {
  const { applyEndOfTurnDamage } = await import("./effecthandler.js")
  const allEntryArrays = ALL_FS.map(s => entries[s])
  const { msgs: eotMsgs } = applyEndOfTurnDamage(allEntryArrays, data)
  if(eotMsgs.length > 0) {
    const logsRef = db.collection("double").doc(roomId).collection("logs")
    const base    = Date.now()
    const batch   = db.batch()
    eotMsgs.forEach((text, i) => batch.set(logsRef.doc(), { text, ts: base + i }))
    await batch.commit()
  }
  Object.assign(update, buildEntryUpdate(entries))
  const winAfterEot = checkWin(entries)
  if(winAfterEot) {
    update.game_over     = true
    update.winner_team   = winAfterEot
    update.current_order = []
    return winAfterEot
  }
  // pending_switches 완전 제거
  return null
}