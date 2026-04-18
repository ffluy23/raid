// api/raidUseItem.js
import { db } from "../lib/firestore.js"
import {
  deepCopyEntries, corsHeaders
} from "../lib/gameUtils.js"
import { josa } from "../lib/effecthandler.js"
import { executeBossAction, deepCopyEntries as deepCopyRaidEntries2 } from "../lib/raidBossAction.js"

// ── 상수 ─────────────────────────────────────────────────────────────
const PLAYER_SLOTS = ["p1", "p2", "p3"]

// ── 아이템 정의 ──────────────────────────────────────────────────────
export const ITEMS = {
  "회복약": {
    name: "회복약",
    desc: "모든 상태이상을 없애고 HP를 완전히 회복한다.",
    // 기절한 포켓몬에는 사용 불가
    canUse: (pkmn) => pkmn.hp > 0,
    apply: (pkmn) => {
      pkmn.hp        = pkmn.maxHp ?? pkmn.hp
      pkmn.status    = null
      pkmn.confusion = 0
    },
    logText: (pkmnName) =>
      `${pkmnName}${josa(pkmnName, "의")} 상태이상이 사라지고 HP가 완전히 회복됐다!`,
  },
  "기력의덩어리": {
    name: "기력의덩어리",
    desc: "기절한 포켓몬을 HP 가득 채워서 부활시킨다.",
    // 기절한 포켓몬에만 사용 가능
    canUse: (pkmn) => pkmn.hp <= 0,
    apply: (pkmn) => {
      pkmn.hp     = pkmn.maxHp ?? 1
      pkmn.status = null
    },
    logText: (pkmnName) =>
      `${pkmnName}${josa(pkmnName, "은는")} 기력의덩어리로 부활했다!`,
  },
}

// ── 유틸 ─────────────────────────────────────────────────────────────
function makeLog(type, text = "", meta = null) {
  return { type, text, ...(meta ? { meta } : {}) }
}

async function writeLogs(roomId, logEntries) {
  const logsRef = db.collection("raid").doc(roomId).collection("logs")
  const base    = Date.now()
  const batch   = db.batch()
  logEntries.forEach((entry, i) => {
    batch.set(logsRef.doc(), { ...entry, ts: base + i })
  })
  await batch.commit()
}

function deepCopyRaidEntries(data) {
  const entries = {}
  PLAYER_SLOTS.forEach(s => {
    entries[s] = JSON.parse(JSON.stringify(data[`${s}_entry`] ?? []))
  })
  return entries
}

function buildRaidEntryUpdate(entries) {
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

// ── 보스 턴 연속 처리 ────────────────────────────────────────────────
async function runBossIfNext(roomId) {
  const snap      = await db.collection("raid").doc(roomId).get()
  const freshData = snap.data()
  if (!freshData || freshData.game_over) return
  const order = freshData.current_order ?? []
  if (order[0] !== "boss") return
  const freshEntries = deepCopyRaidEntries2(freshData)
  return executeBossAction(roomId, freshData, freshEntries, order)
}

// ════════════════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).end()

  const { roomId, mySlot, itemName, targetIdx } = req.body
  if (!roomId || !mySlot || !itemName || targetIdx === undefined)
    return res.status(400).json({ error: "파라미터 부족" })

  // ── 아이템 정의 확인 ─────────────────────────────────────────────
  const itemDef = ITEMS[itemName]
  if (!itemDef) return res.status(400).json({ error: "존재하지 않는 아이템" })

  const roomRef = db.collection("raid").doc(roomId)
  const snap    = await roomRef.get()
  const data    = snap.data()
  if (!data) return res.status(404).json({ error: "방 없음" })

  // ── 내 턴 확인 ───────────────────────────────────────────────────
  const order = data.current_order ?? []
  if (order[0] !== mySlot)
    return res.status(403).json({ error: "내 턴이 아님" })

  // ── 인벤토리 확인 ────────────────────────────────────────────────
  const inventory = data.inventory ?? {}
  const itemCount = inventory[itemName] ?? 0
  if (itemCount <= 0)
    return res.status(403).json({ error: "아이템이 없음" })

  // ── 타겟 포켓몬 확인 ─────────────────────────────────────────────
  const myEntry = JSON.parse(JSON.stringify(data[`${mySlot}_entry`] ?? []))
  const target  = myEntry[targetIdx]
  if (!target)
    return res.status(400).json({ error: "대상 포켓몬 없음" })

  // ── 사용 조건 확인 ───────────────────────────────────────────────
  if (!itemDef.canUse(target))
    return res.status(403).json({ error: `${itemName}을(를) 이 포켓몬에게 사용할 수 없음` })

  // ── 아이템 효과 적용 ─────────────────────────────────────────────
  const entries = deepCopyRaidEntries(data)
  // myEntry는 이미 복사했으니 entries에 반영
  entries[mySlot] = myEntry

  itemDef.apply(target)
  entries[mySlot][targetIdx] = target

  // ── 로그 ─────────────────────────────────────────────────────────
  const logEntries = [
    makeLog("normal",  `${data[`${mySlot.replace("p","player")}_name`] ?? mySlot}${josa(data[`${mySlot.replace("p","player")}_name`] ?? mySlot, "은는")} ${itemName}을(를) 사용했다!`),
    makeLog("hp", itemDef.logText(target.name), {
      slot:  mySlot,
      hp:    target.hp,
      maxHp: target.maxHp,
    }),
  ]

  // 기절 → 부활이면 faint 클래스 해제용 로그 추가
  if (itemDef.name === "기력의덩어리") {
    logEntries.push(makeLog("revive", `${target.name}${josa(target.name, "은는")} 다시 싸울 수 있다!`, { slot: mySlot, pkmnIdx: targetIdx }))
  }

  await writeLogs(roomId, logEntries)

  // ── 인벤토리 차감 & 턴 진행 ──────────────────────────────────────
  const newInventory = { ...inventory, [itemName]: itemCount - 1 }
  const newOrder     = order.slice(1)

  const update = {
    ...buildRaidEntryUpdate(entries),
    inventory:       newInventory,
    current_order:   newOrder,
    turn_count:      (data.turn_count ?? 1) + 1,
    turn_started_at: newOrder.length > 0 ? Date.now() : null,
  }

  // 활성 인덱스 보존
  PLAYER_SLOTS.forEach(s => {
    if (data[`${s}_active_idx`] !== undefined)
      update[`${s}_active_idx`] = data[`${s}_active_idx`]
  })

  // 승패 체크 (혹시 모를 예외 상황)
  const result = checkRaidWin(entries, data.boss_current_hp ?? 0)
  if (result) {
    update.game_over      = true
    update.raid_result    = result
    update.current_order  = []
    update.turn_started_at = null
  }

  await roomRef.update(update)

  // 다음 턴이 보스면 서버에서 연속 처리
  if (!result) {
    await runBossIfNext(roomId).catch(e => console.warn("보스 연속 처리 오류:", e.message))
  }

  return res.status(200).json({ ok: true, ...(result ? { result } : {}) })
}
