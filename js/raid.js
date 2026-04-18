// js/raid.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, onSnapshot, query, orderBy, updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { moves } from "./moves.js"
import { josa } from "./effecthandler.js"
import { openItemModal, closeItemModal, updateBagBadge } from "./item.js"

window.__moves = moves

const API = "https://raidzenith.vercel.app/api"

const SFX_DICE = "https://slippery-copper-mzpmcmc2ra.edgeone.app/soundreality-bicycle-bell-155622.mp3"
const SFX_BTN  = "https://usual-salmon-mnqxptwyvw.edgeone.app/Pokemon%20(A%20Button)%20-%20Sound%20Effect%20(HD)%20(1)%20(1).mp3"

function playSound(url) {
  const a = new Audio(url); a.volume = 0.6; a.play().catch(() => {})
}

async function callApi(endpoint, data) {
  const res = await fetch(`${API}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? "API 오류")
  return json
}

const _startRound    = (data) => callApi("raidstartround",    data)
const _useMove       = (data) => callApi("raidusemove",       data)
const _useItem       = (data) => callApi("raiduseitem",       data)
const _switchPkmn    = (data) => callApi("raidswitchpokemon", data)
const _skipTurn      = (data) => callApi("raidskipturn",      data)
const _requestAssist = (data) => callApi("raidrequestassist", data)
const _agreeAssist   = (data) => callApi("raidagreeassist",   data)
const _rejectAssist  = (data) => callApi("raidrejectassist",  data)
const _requestSync   = (data) => callApi("raidrequestsync",   data)
const _agreeSync     = (data) => callApi("raidagreesync",     data)
const _rejectSync    = (data) => callApi("raidrejectsync",    data)
const _leaveGame     = (data) => callApi("raidleavegame",     data)
const _bossTurn      = (data) => callApi("raidbossturn",      data)

const roomRef = doc(db, "raid", ROOM_ID)
const logsRef = collection(db, "raid", ROOM_ID, "logs")

let mySlot = null, myUid = null
let myTurn = false, actionDone = false, gameOver = false
let renderedLogIds = new Set()
let isSpectator    = new URLSearchParams(location.search).get("spectator") === "true"

let logQueue        = []
let isProcessing    = false
let pendingRoomData = null
let currentRoomData = null

// 독침붕 타겟 선택 상태
let pendingMoveIdx     = -1
let pendingMoveInfo    = null
let beedrillTargetMode = false

const TYPE_COLORS = {
  "노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945",
  "얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889",
  "비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870",
  "드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"
}

let lastTurnSlot = null
const PLAYER_SLOTS = ["p1", "p2", "p3"]

function $(id) { return document.getElementById(id) }
function rollD10() { return Math.floor(Math.random() * 10) + 1 }
function wait(ms)  { return new Promise(r => setTimeout(r, ms)) }

function otherPlayerSlots() { return PLAYER_SLOTS.filter(s => s !== mySlot) }
function isPlayerSlot(slot) { return PLAYER_SLOTS.includes(slot) }
function isBeedrillSlot(slot) { return slot === "beedrill_0" || slot === "beedrill_1" }

function anyBeedrillAlive(data) {
  return (data.Beedrill ?? []).some(b => b.hp > 0)
}

function isAllPlayersDead(data) {
  return PLAYER_SLOTS.every(s => {
    const entry = data[`${s}_entry`] ?? []
    return entry.every(p => p.hp <= 0)
  })
}

function cannotRequestSupport(data) {
  if (!mySlot) return true
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  return !myPkmn || myPkmn.hp <= 0
}

const SPECTATOR_PREFIX = { p1: "my", p2: "ally1", p3: "ally2" }

function slotToPrefix(slot) {
  if (slot === "boss") return "boss"
  if (isBeedrillSlot(slot)) return null  // 독침붕은 별도 UI
  if (!mySlot) return SPECTATOR_PREFIX[slot] ?? null
  if (slot === mySlot) return "my"
  const others = otherPlayerSlots()
  return slot === others[0] ? "ally1" : "ally2"
}

// ── HP바 / 포트레이트 ────────────────────────────────────────────────
function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar = $(barId), txt = textId ? $(textId) : null
  if (!bar) return
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 0
  bar.style.width           = pct + "%"
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336"
  if (txt) txt.innerText    = showNum ? `HP: ${hp} / ${maxHp}` : ""
}

function updatePortrait(prefix, pokemon) {
  const img = $(`${prefix}-portrait`)
  const ph  = $(`${prefix}-portrait-placeholder`)
  if (!img) return
  if (!pokemon?.portrait) {
    img.classList.remove("visible"); img.style.display = "none"
    if (ph) ph.style.display = "block"
    return
  }
  if (ph) ph.style.display = "none"
  if (img.dataset.loadedSrc === pokemon.portrait) return
  img.dataset.loadedSrc = pokemon.portrait
  img.classList.remove("visible")
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name
  setTimeout(() => img.classList.add("visible"), 60)
}

// ── 플레이어 슬롯 UI ─────────────────────────────────────────────────
function updateSlotUI(slot, data) {
  const prefix = slotToPrefix(slot)
  if (!prefix) return
  const activeIdx = data[`${slot}_active_idx`] ?? 0
  const pokemon   = data[`${slot}_entry`]?.[activeIdx]
  if (!pokemon) return

  const slotKey   = slot.replace("p", "player")
  const nameLabel = $(`${prefix}-name-label`)
  if (nameLabel) nameLabel.innerText = data[`${slotKey}_name`] ?? slot

  const nameEl = $(`${prefix}-active-name`)
  if (nameEl) {
    const STATUS_LABEL = { "마비":"[마비]","화상":"[화상]","독":"[독]","얼음":"[얼음]" }
    const statusTag    = pokemon.status ? " " + (STATUS_LABEL[pokemon.status] ?? "") : ""
    const confusionTag = (pokemon.confusion ?? 0) > 0 ? " [혼란]" : ""
    const flyTag       = pokemon.flyState?.flying  ? " ✈" : ""
    const digTag       = pokemon.digState?.digging ? " ⛏" : ""
    nameEl.innerText   = (pokemon.name ?? "???") + statusTag + confusionTag + flyTag + digTag
  }

  updateHpBar(`${prefix}-hp-bar`, `${prefix}-active-hp`, pokemon.hp, pokemon.maxHp, prefix === "my")
  updatePortrait(prefix, pokemon)
}

// ── 보스 UI ──────────────────────────────────────────────────────────
function updateBossUI(data) {
  const bossHp    = data.boss_current_hp ?? 0
  const bossMaxHp = data.boss_max_hp ?? 1
  const bossName  = data.boss_name       ?? "보스"

  const nameEl = $("boss-name")
  if (nameEl) nameEl.innerText = bossName

  updateHpBar("boss-hp-bar", "boss-hp-text", bossHp, bossMaxHp, true)

  // 보스 포트레이트
  const img = $("boss-portrait")
  const ph  = document.querySelector(".boss-portrait-placeholder")
  if (img) {
    const portrait = data.boss_portrait_url ?? null
    if (!portrait) {
      img.classList.remove("visible"); img.style.display = "none"
      if (ph) ph.style.display = "block"
    } else if (img.dataset.loadedSrc !== portrait) {
      img.dataset.loadedSrc = portrait
      if (ph) ph.style.display = "none"
      img.classList.remove("visible")
      img.style.display = "block"
      img.src = portrait
      img.alt = bossName
      setTimeout(() => img.classList.add("visible"), 60)
    }
  }

  const statusEl = $("boss-status")
  if (statusEl) {
    const s = data.boss_status ?? null
    statusEl.innerText = s ? `[${s}]` : ""
  }

  const rankEl = $("boss-rank")
  if (rankEl) {
    const rank = data.boss_rank ?? {}
    const tags = []
    if ((rank.atk ?? 0) > 0) tags.push(`공+${rank.atk}`)
    else if ((rank.atk ?? 0) < 0) tags.push(`공${rank.atk}`)
    if ((rank.def ?? 0) > 0) tags.push(`방+${rank.def}`)
    else if ((rank.def ?? 0) < 0) tags.push(`방${rank.def}`)
    rankEl.innerText = tags.join(" / ")
  }
}

// ── 독침붕 UI ────────────────────────────────────────────────────────
function updateBeedrillUI(data) {
  const beedrills = data.Beedrill ?? []
  const row       = $("beedrill-row")
  if (!row) return

  if (beedrills.length === 0) {
    row.classList.remove("visible")
    return
  }
  row.classList.add("visible")

  beedrills.forEach((bee, i) => {
    const card     = $(`beedrill-card-${i}`)
    const hpBar    = $(`beedrill-hp-bar-${i}`)
    const hpNum    = $(`beedrill-hp-num-${i}`)
    const rankEl   = $(`beedrill-rank-${i}`)
    const portrait = $(`beedrill-portrait-${i}`)
    if (!card) return

    const pct = (bee.maxHp ?? bee.hp) > 0
      ? Math.max(0, bee.hp / (bee.maxHp ?? bee.hp) * 100) : 0

    card.classList.toggle("fainted", bee.hp <= 0)

    if (hpBar) {
      hpBar.style.width           = `${pct}%`
      hpBar.style.backgroundColor = pct > 50 ? "#c0a020" : pct > 20 ? "#e67e22" : "#e74c3c"
    }
    if (hpNum) hpNum.textContent = `${bee.hp}/${bee.maxHp ?? bee.hp}`
    if (rankEl) {
      const def = bee.ranks?.def ?? 0
      rankEl.textContent = def !== 0 ? `방어 ${def > 0 ? "+" : ""}${def}` : ""
    }
    if (portrait && bee.portrait && portrait.dataset.loadedSrc !== bee.portrait) {
      portrait.dataset.loadedSrc = bee.portrait
      portrait.src               = bee.portrait
      portrait.style.display     = "block"
      setTimeout(() => portrait.classList.add("visible"), 60)
    }
  })
}

// ── 독침붕 타겟 선택 모드 ────────────────────────────────────────────
function enterBeedrillTargetMode(data) {
  beedrillTargetMode = true
  const hint = $("beedrill-target-hint")
  if (hint) hint.style.display = "block"

  const beedrills = data.Beedrill ?? []
  beedrills.forEach((bee, i) => {
    const card = $(`beedrill-card-${i}`)
    if (!card || bee.hp <= 0) return
    card.classList.add("targetable")
    card.onclick = () => {
      exitBeedrillTargetMode(data)
      doUseMove(pendingMoveIdx, [`beedrill_${i}`], data)
    }
  })
}

function exitBeedrillTargetMode(data) {
  beedrillTargetMode = false
  const hint = $("beedrill-target-hint")
  if (hint) hint.style.display = "none"

  const beedrills = data.Beedrill ?? []
  beedrills.forEach((_, i) => {
    const card = $(`beedrill-card-${i}`)
    if (!card) return
    card.classList.remove("targetable")
    card.onclick = null
  })

  pendingMoveIdx  = -1
  pendingMoveInfo = null
}

// ── 자동 행동 ────────────────────────────────────────────────────────
function triggerAutoAction(data) {
  if (actionDone || !myTurn || isSpectator) return
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  if (!myPkmn || myPkmn.hp <= 0) return

  const movesArr   = myPkmn.moves ?? []
  const chainBound = myPkmn.chainBound ?? null
  const usable     = movesArr
    .map((mv, i) => ({ mv, i }))
    .filter(({ mv }) => mv.pp > 0 && !(chainBound && chainBound.moveName === mv.name))

  if (usable.length === 0) { actionDone = true; doSkipTurn(true); return }

  const { mv, i: moveIdx } = usable[Math.floor(Math.random() * usable.length)]
  const moveInfo = moves[mv.name] ?? {}

  // 독침붕 살아있으면 독침붕 랜덤 타겟
  if (anyBeedrillAlive(data)) {
    const aliveBees = (data.Beedrill ?? [])
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.hp > 0)
    if (aliveBees.length > 0) {
      const { i: bIdx } = aliveBees[Math.floor(Math.random() * aliveBees.length)]
      const tSlot = moveInfo.aoe ? [] : [`beedrill_${bIdx}`]
      doUseMove(moveIdx, tSlot, data)
      return
    }
  }

  if (moveInfo.aoe || moveInfo.aoeEnemy) {
    doUseMove(moveIdx, ["boss"], data); return
  }

  const needsTarget = moveInfo.power || moveInfo.ghostDive || moveInfo.futureSight
    || moveInfo.taunt || moveInfo.memento || moveInfo.leechSeed || moveInfo.chainBind
    || moveInfo.poisonPowder || moveInfo.pollenPuff || moveInfo.curse
    || (moveInfo.effect?.volatile && !moveInfo.targetSelf)
    || (moveInfo.effect?.status && moveInfo.targetSelf === false)

  doUseMove(moveIdx, needsTarget ? ["boss"] : [], data)
}

// ── 로그 처리 ────────────────────────────────────────────────────────
async function handleLogEntry(entry) {
  const { type, text, meta } = entry
  const logEl = $("battle-log")
  switch (type) {
    case "normal":
    case "after_hit":
    case "move_announce": {
      if (!text) break
      await typeText(logEl, text)
      await wait(type === "move_announce" ? 200 : 120)
      break
    }
    case "dice": {
      if (!meta) break
      await animateAttackDice(meta.slot, meta.roll)
      break
    }
    case "hit": {
      if (!meta?.defender) break
      if (isBeedrillSlot(meta.defender)) {
        // 독침붕 피격 이펙트
        const card = $(`beedrill-card-${meta.defender.replace("beedrill_", "")}`)
        if (card) {
          card.classList.remove("defender-hit"); void card.offsetWidth
          card.classList.add("defender-hit")
          await new Promise(r => card.addEventListener("animationend", r, { once: true }))
        }
      } else {
        const prefix = slotToPrefix(meta.defender)
        if (prefix) { await triggerAttackEffect(prefix); await triggerBlink(prefix) }
      }
      break
    }
    case "hp": {
      if (!meta?.slot) break
      if (isBeedrillSlot(meta.slot)) {
        // 독침붕 HP 애니메이션
        const idx    = parseInt(meta.slot.replace("beedrill_", ""), 10)
        const hpBar  = $(`beedrill-hp-bar-${idx}`)
        const hpNum  = $(`beedrill-hp-num-${idx}`)
        const card   = $(`beedrill-card-${idx}`)
        if (hpBar && meta.maxHp > 0) {
          const pct = Math.max(0, meta.hp / meta.maxHp * 100)
          hpBar.style.width           = `${pct}%`
          hpBar.style.backgroundColor = pct > 50 ? "#c0a020" : pct > 20 ? "#e67e22" : "#e74c3c"
        }
        if (hpNum) hpNum.textContent = `${meta.hp}/${meta.maxHp}`
        if (text) await typeText(logEl, text)
      } else {
        const prefix  = slotToPrefix(meta.slot)
        if (!prefix) break
        const showNum = prefix === "my" || prefix === "boss"
        await animateHpBar(prefix, meta.hp, meta.maxHp, showNum)
        if (text) await typeText(logEl, text)
      }
      await wait(100)
      break
    }
    case "beedrill_summon": {
      // 소환 로그 — UI는 pendingRoomData applyRoomData에서 처리
      if (text) await typeText(logEl, text)
      await wait(200)
      break
    }
    case "beedrill_hp": {
      // 독침붕 전체 HP 갱신 (방어지령/회복지령 후)
      if (meta?.beedrills) {
        meta.beedrills.forEach((bee, i) => {
          const hpBar = $(`beedrill-hp-bar-${i}`)
          const hpNum = $(`beedrill-hp-num-${i}`)
          if (!hpBar) return
          const pct = (bee.maxHp ?? bee.hp) > 0
            ? Math.max(0, bee.hp / (bee.maxHp ?? bee.hp) * 100) : 0
          hpBar.style.width           = `${pct}%`
          hpBar.style.backgroundColor = pct > 50 ? "#c0a020" : pct > 20 ? "#e67e22" : "#e74c3c"
          if (hpNum) hpNum.textContent = `${bee.hp}/${bee.maxHp ?? bee.hp}`
        })
      }
      if (text) await typeText(logEl, text)
      await wait(100)
      break
    }
    case "assist":  { await showAssistAnimation();  break }
    case "sync":    { await showSyncAnimation();    break }
    case "umbreon": { await showUmbreonAnimation(); break }
    case "revive": {
      if (meta?.slot) {
        const prefix = slotToPrefix(meta.slot)
        const area   = $(`${prefix}-pokemon-area`)
        if (area) area.classList.remove("fainted")
      }
      if (text) await typeText(logEl, text)
      await wait(200)
      break
    }
    case "faint": {
      if (text) await typeText(logEl, text)
      if (meta?.slot) {
        if (isBeedrillSlot(meta.slot)) {
          const idx  = parseInt(meta.slot.replace("beedrill_", ""), 10)
          const card = $(`beedrill-card-${idx}`)
          if (card) card.classList.add("fainted")
        } else {
          const prefix = slotToPrefix(meta.slot)
          const area   = $(`${prefix}-pokemon-area`)
          if (area) area.classList.add("fainted")
        }
      }
      await wait(300)
      break
    }
    default: { if (text) await typeText(logEl, text); break }
  }
}

function typeText(logEl, text) {
  return new Promise(resolve => {
    if (!logEl) { resolve(); return }
    const line  = document.createElement("p")
    logEl.appendChild(line)
    const chars = [...text]; let i = 0
    function next() {
      if (i >= chars.length) { logEl.scrollTop = logEl.scrollHeight; resolve(); return }
      line.textContent += chars[i++]
      logEl.scrollTop = logEl.scrollHeight
      setTimeout(next, 18)
    }
    next()
  })
}

function enqueueLogs(entries) {
  entries.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  entries.forEach(e => { if (!e.type) e.type = "normal" })
  logQueue.push(...entries)
  processLogQueue()
}

async function processLogQueue() {
  if (isProcessing) return
  if (logQueue.length === 0) {
    if (pendingRoomData) {
      const data = pendingRoomData
      pendingRoomData = null
      setTimeout(async () => {
        if (data.dice_event && data.dice_event.ts > lastDiceEventTs) {
          lastDiceEventTs = data.dice_event.ts
          await animateRoundDice(data.dice_event.rolls, data.dice_event.slots)
        }
        applyRoomData(data)
      }, 80)
    }
    return
  }
  isProcessing = true
  const entry  = logQueue.shift()
  try { await handleLogEntry(entry) } catch (e) { console.warn("logEntry 처리 오류:", e) }
  isProcessing = false
  setTimeout(processLogQueue, 50)
}

// ── 애니메이션 ───────────────────────────────────────────────────────
function animateHpBar(prefix, targetHp, maxHp, showNum) {
  return new Promise(resolve => {
    const bar = $(`${prefix}-hp-bar`)
    const txt = $(`${prefix}-active-hp`) ?? $(`${prefix}-hp-text`)
    if (!bar) { resolve(); return }
    const targetPct = maxHp > 0 ? Math.max(0, Math.min(100, targetHp / maxHp * 100)) : 0
    const color = targetPct > 50 ? "#4caf50" : targetPct > 20 ? "#ff9800" : "#f44336"
    bar.style.transition      = "width 0.4s ease, background-color 0.4s ease"
    bar.style.width           = targetPct + "%"
    bar.style.backgroundColor = color
    if (txt && showNum) txt.innerText = `HP: ${targetHp} / ${maxHp}`
    setTimeout(() => { bar.style.transition = ""; resolve() }, 420)
  })
}

function triggerAttackEffect(defPrefix) {
  return new Promise(resolve => {
    const defArea = $(`${defPrefix}-pokemon-area`)
    const wrapper = $("battle-wrapper")
    if (wrapper) {
      wrapper.classList.remove("screen-shake"); void wrapper.offsetWidth
      wrapper.classList.add("screen-shake")
      wrapper.addEventListener("animationend", () => wrapper.classList.remove("screen-shake"), { once: true })
    }
    if (defArea) {
      defArea.classList.remove("defender-hit"); void defArea.offsetWidth
      defArea.classList.add("defender-hit")
      defArea.addEventListener("animationend", () => { defArea.classList.remove("defender-hit"); resolve() }, { once: true })
    } else resolve()
  })
}

function triggerBlink(prefix) {
  return new Promise(resolve => {
    const area = $(`${prefix}-pokemon-area`)
    if (!area) { resolve(); return }
    const targets = [
      area.querySelector(".portrait-wrap"),
      area.querySelector(".hp-card")
    ].filter(Boolean)
    if (targets.length === 0) { resolve(); return }
    let done = 0
    targets.forEach(el => {
      el.classList.remove("blink-damage"); void el.offsetWidth
      el.classList.add("blink-damage")
      el.addEventListener("animationend", () => {
        el.classList.remove("blink-damage")
        if (++done >= targets.length) resolve()
      }, { once: true })
    })
  })
}

function animateAttackDice(slot, finalRoll) {
  return new Promise(resolve => {
    const wrap   = $("dice-wrap")
    const diceEl = $(`dice-${slot}`)
    if (!wrap || !diceEl) { resolve(); return }
    ;["p1","p2","p3","boss"].forEach(s => {
      const box = $(`dice-box-${s}`)
      if (box) box.style.display = s === slot ? "block" : "none"
    })
    wrap.style.display = "flex"
    let count = 0
    const iv = setInterval(() => {
      diceEl.innerText = rollD10()
      if (++count >= 16) {
        clearInterval(iv)
        diceEl.innerText = finalRoll
        diceEl.classList.remove("pop"); void diceEl.offsetWidth; diceEl.classList.add("pop")
        playSound(SFX_DICE)
        setTimeout(() => { wrap.style.display = "none"; resolve() }, 900)
      }
    }, 55)
  })
}

function animateRoundDice(rolls, slots) {
  return new Promise(resolve => {
    const wrap = $("dice-wrap")
    if (!wrap) { resolve(); return }
    ;["p1","p2","p3","boss"].forEach(s => {
      const box = $(`dice-box-${s}`)
      if (box) box.style.display = slots.includes(s) ? "block" : "none"
    })
    wrap.style.display = "flex"
    let count = 0
    const iv = setInterval(() => {
      slots.forEach(s => {
        const el = $(`dice-${s}`)
        if (el) el.innerText = rollD10()
      })
      if (++count >= 20) {
        clearInterval(iv)
        slots.forEach(s => {
          const el = $(`dice-${s}`)
          if (el) { el.innerText = rolls[s]; el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop") }
        })
        playSound(SFX_DICE)
        setTimeout(() => { wrap.style.display = "none"; resolve() }, 1600)
      }
    }, 60)
  })
}

function showAssistAnimation() {
  return new Promise(resolve => {
    const el = $("assist-anim")
    if (!el) { resolve(); return }
    el.classList.remove("assist-show"); void el.offsetWidth; el.classList.add("assist-show")
    setTimeout(resolve, 800)
  })
}

function showSyncAnimation() {
  return new Promise(resolve => {
    const el = $("sync-anim")
    if (!el) { resolve(); return }
    el.classList.remove("sync-show"); void el.offsetWidth; el.classList.add("sync-show")
    setTimeout(resolve, 800)
  })
}

function showUmbreonAnimation() {
  return new Promise(resolve => {
    const el      = $("umbreon-anim")
    const wrapper = $("battle-wrapper")
    if (!el) { resolve(); return }
    playSound(SFX_DICE)
    if (wrapper) {
      let shakeCount = 0
      const doShake = () => {
        wrapper.classList.remove("screen-shake-heavy"); void wrapper.offsetWidth
        wrapper.classList.add("screen-shake-heavy")
        wrapper.addEventListener("animationend", () => {
          wrapper.classList.remove("screen-shake-heavy")
          shakeCount++
          if (shakeCount < 3) setTimeout(doShake, 50)
        }, { once: true })
      }
      doShake()
    }
    el.classList.remove("umbreon-show"); void el.offsetWidth; el.classList.add("umbreon-show")
    setTimeout(resolve, 1400)
  })
}

// ── 기술 버튼 ────────────────────────────────────────────────────────
function updateMoveButtons(data) {
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPokemon   = data[`${mySlot}_entry`]?.[myActiveIdx]
  const fainted     = !myPokemon || myPokemon.hp <= 0
  const movesArr    = myPokemon?.moves ?? []
  const chainBound  = myPokemon?.chainBound ?? null

  const isAutoTurn = !!(
    myPokemon?.flyState?.flying       ||
    myPokemon?.digState?.digging      ||
    myPokemon?.ghostDiveState?.diving ||
    myPokemon?.bideState              ||
    myPokemon?.rollState?.active      ||
    myPokemon?.hyperBeamState
  )

  for (let i = 0; i < 4; i++) {
    const btn = $(`move-btn-${i}`)
    if (!btn) continue
    if (i >= movesArr.length) {
      btn.innerHTML = '<span style="font-size:13px">-</span>'
      btn.disabled = true; btn.onclick = null; continue
    }
    const mv       = movesArr[i]
    const moveInfo = moves[mv.name] ?? {}
    const acc      = moveInfo.alwaysHit ? "필중" : `${moveInfo.accuracy ?? 100}%`

    const isChainBlocked = !!(chainBound && chainBound.moveName === mv.name)
    if (isChainBlocked) {
      btn.innerHTML = `<span style="display:block;font-size:13px;font-weight:bold">${mv.name} 🔗</span><span style="display:block;font-size:10px;opacity:.85">사슬묶기 중!</span>`
      btn.style.background = "#555"; btn.disabled = true; btn.onclick = null; continue
    }

    if (isAutoTurn) {
      btn.innerHTML = `<span style="display:block;font-size:13px;font-weight:bold">${mv.name}</span><span style="display:block;font-size:10px;opacity:.85">자동처리 중...</span>`
      const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
      btn.style.background = color; btn.disabled = true; btn.onclick = null; continue
    }

    btn.innerHTML = `<span style="display:block;font-size:13px;font-weight:bold">${mv.name}</span><span style="display:block;font-size:10px;opacity:.85">PP: ${mv.pp} | ${acc}</span>`
    const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
    btn.style.background = color
    btn.style.boxShadow  = `inset 0 0 0 2px white, 0 0 0 2px ${color}`

    const lockedByTorment    = !!(myPokemon?.tormented && mv.name === myPokemon?.lastUsedMove)
    const soundMoves         = ["금속음","돌림노래","바크아웃","소란피기","싫은소리","울부짖기","울음소리","차밍보이스","비밀이야기","하이퍼보이스","매혹의보이스"]
    const lockedByThroatChop = !!((myPokemon?.throatChopped ?? 0) > 0 && soundMoves.includes(mv.name))
    const lockedByOutrage    = !!(myPokemon?.outrageState?.active)
    const lockedByTaunt      = !!((myPokemon?.taunted ?? 0) > 0 && !(moveInfo?.power > 0))

    const canUse = !isSpectator && !fainted && mv.pp > 0 && myTurn && !actionDone
      && !isChainBlocked && !lockedByTorment && !lockedByThroatChop && !lockedByOutrage && !lockedByTaunt
    btn.disabled = !canUse
    btn.onclick  = canUse ? () => { playSound(SFX_BTN); onMoveClick(i, moveInfo, data) } : null
  }
}

function onMoveClick(idx, moveInfo, data) {
  if (actionDone) return

  const hasBeedrills = anyBeedrillAlive(data)

  // aoe 기술: 독침붕 있으면 독침붕 전원, 없으면 보스
  if (moveInfo?.aoe || moveInfo?.aoeEnemy) {
    doUseMove(idx, hasBeedrills ? [] : ["boss"], data)
    return
  }

  if (moveInfo?.outrage) {
    if (hasBeedrills) {
      // 역린 → 독침붕 랜덤
      const aliveBees = (data.Beedrill ?? []).map((b,i) => ({b,i})).filter(({b}) => b.hp > 0)
      const { i: bIdx } = aliveBees[Math.floor(Math.random() * aliveBees.length)]
      doUseMove(idx, [`beedrill_${bIdx}`], data)
    } else {
      doUseMove(idx, ["boss"], data)
    }
    return
  }

  const r = moveInfo?.rank
  const targetsEnemy =
    moveInfo?.power || moveInfo?.ghostDive || moveInfo?.futureSight
    || moveInfo?.taunt || moveInfo?.memento
    || (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))
    || moveInfo?.roar || moveInfo?.leechSeed || moveInfo?.chainBind
    || moveInfo?.dragonTail || moveInfo?.healPulse || moveInfo?.poisonPowder
    || moveInfo?.pollenPuff || moveInfo?.curse
    || (moveInfo?.effect?.volatile && !moveInfo?.targetSelf)
    || (moveInfo?.effect?.status && moveInfo?.targetSelf === false)

  if (!targetsEnemy) {
    // 자기/아군 대상 기술 → 독침붕 관계없이 그냥 사용
    doUseMove(idx, [], data)
    return
  }

  // 공격 기술인데 독침붕이 살아있음 → 독침붕 타겟 선택
  if (hasBeedrills) {
    const aliveBees = (data.Beedrill ?? []).filter(b => b.hp > 0)
    if (aliveBees.length === 1) {
      // 살아있는 독침붕이 1마리면 바로
      const bIdx = (data.Beedrill ?? []).findIndex(b => b.hp > 0)
      doUseMove(idx, [`beedrill_${bIdx}`], data)
    } else {
      // 2마리 다 살아있으면 선택 모드
      pendingMoveIdx  = idx
      pendingMoveInfo = moveInfo
      enterBeedrillTargetMode(data)
    }
    return
  }

  // 독침붕 없으면 보스
  doUseMove(idx, ["boss"], data)
}

async function doUseMove(moveIdx, targetSlots, data) {
  if (actionDone) return
  actionDone = true
  updateMoveButtons(data)
  try {
    await _useMove({ roomId: ROOM_ID, mySlot, moveIdx, targetSlots })
  } catch (e) {
    console.error("useMove 오류:", e.message)
    actionDone = false; updateMoveButtons(data)
  }
}

// ── 아이템 사용 ──────────────────────────────────────────────────────
async function doUseItem(itemName, targetIdx, data) {
  if (actionDone) return
  actionDone = true
  updateMoveButtons(data)
  updateBagButton(data)
  try {
    await _useItem({ roomId: ROOM_ID, mySlot, itemName, targetIdx })
  } catch (e) {
    console.error("useItem 오류:", e.message)
    actionDone = false
    updateMoveButtons(data)
    updateBagButton(data)
  }
}

// ── 가방 버튼 ────────────────────────────────────────────────────────
function updateBagButton(data) {
  const btn = $("bag-btn")
  if (!btn) return
  updateBagBadge("bag-btn", data.inventory ?? {})
  if (isSpectator || gameOver) { btn.disabled = true; return }
  const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
  const hasAliveInParty = (data[`${mySlot}_entry`] ?? []).some(p => p.hp > 0)
  const canOpen = myTurn && !actionDone && hasAliveInParty
  btn.disabled = !canOpen
  btn.onclick  = canOpen
    ? () => {
        playSound(SFX_BTN)
        openItemModal(
          currentRoomData, mySlot, myTurn, actionDone,
          (itemName, targetIdx) => doUseItem(itemName, targetIdx, currentRoomData)
        )
      }
    : () => closeItemModal()
}

// ── 교체 버튼 ────────────────────────────────────────────────────────
function updateBenchButtons(data) {
  const bench = $("bench-container")
  if (!bench) return
  bench.innerHTML = ""
  const myEntry      = data[`${mySlot}_entry`] ?? []
  const activeIdx    = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = myEntry[activeIdx]
  const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0
  const forceSwitch  = !!data[`force_switch_${mySlot}`]
  const isDiving     = !!(myActivePkmn?.ghostDiveState?.diving)
  const isFlying     = !!(myActivePkmn?.flyState?.flying)
  const isDigging    = !!(myActivePkmn?.digState?.digging)

  myEntry.forEach((pkmn, idx) => {
    if (idx === activeIdx) return
    const btn = document.createElement("button")
    if (pkmn.hp <= 0) {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">기절</span>`
      btn.disabled  = true
    } else {
      btn.innerHTML = `<span class="bench-name">${pkmn.name}</span><span class="bench-hp">HP: ${pkmn.hp}/${pkmn.maxHp}</span>`
      if (isSpectator) {
        btn.disabled = true
      } else {
        const canSwitch = (isFainted || forceSwitch || (myTurn && !actionDone))
          && !isDiving && !isFlying && !isDigging
        btn.disabled = !canSwitch
        if (canSwitch) btn.onclick = () => { playSound(SFX_BTN); doSwitchPokemon(idx, data, forceSwitch) }
      }
    }
    bench.appendChild(btn)
  })
}

async function doSwitchPokemon(newIdx, data, forceSwitch = false) {
  const myEntry      = data[`${mySlot}_entry`] ?? []
  const activeIdx    = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = myEntry[activeIdx]
  const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0
  if (!isFainted && !forceSwitch && actionDone) return
  if (!isFainted) actionDone = true
  const bench = $("bench-container")
  if (bench) bench.querySelectorAll("button").forEach(b => { b.disabled = true; b.onclick = null })
  try {
    await _switchPkmn({ roomId: ROOM_ID, mySlot, newIdx })
  } catch (e) {
    console.error("switchPokemon 오류:", e.message)
    if (!isFainted) actionDone = false
    updateBenchButtons(data)
  }
}

// ── 턴 순서 표시 ─────────────────────────────────────────────────────
function updateOrderDisplay(data) {
  const el = $("order-display")
  if (!el) return
  const order = data.current_order ?? []
  if (order.length === 0) { el.innerHTML = ""; return }
  el.innerHTML = order.map((slot, i) => {
    const label   = slot === "boss" ? (data.boss_name ?? "보스") :
                    (data[`${slot.replace("p","player")}_name`] ?? slot).split("]").pop().trim()
    const isActive = i === 0
    const isMine   = slot === mySlot
    let cls = "order-item"
    if (isActive) cls += " active"
    else if (isMine) cls += " mine"
    return `<div class="${cls}">${i+1}. ${label}</div>`
  }).join("")
}

function updateTurnUI(data) {
  const el = $("turn-display")
  if (!el) return
  const order = data.current_order ?? []
  if (isSpectator) {
    if (order.length > 0) {
      const s     = order[0]
      const label = s === "boss" ? (data.boss_name ?? "보스") :
                    (data[`${s.replace("p","player")}_name`] ?? s).split("]").pop().trim()
      el.innerText = `${label}의 턴`; el.style.color = "#333"
    } else {
      el.innerText = "라운드 대기 중..."; el.style.color = "#aaa"
    }
    return
  }
  const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
  const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0
  if (isFainted) {
    el.innerText = "교체할 포켓몬을 선택!"; el.style.color = "#e67e22"
  } else if (order.length === 0) {
    el.innerText = "라운드 대기 중..."; el.style.color = "#aaa"
  } else if (order[0] === mySlot) {
    el.innerText = "내 턴!"; el.style.color = "green"
  } else if (order[0] === "boss") {
    el.innerText = "보스 턴..."; el.style.color = "#e74c3c"
  } else {
    const idx    = order.indexOf(mySlot)
    el.innerText = idx > 0 ? `${idx}번째 대기중...` : "다른 플레이어 턴..."
    el.style.color = "gray"
  }
  const tc = $("turn-count")
  if (tc) tc.innerText = `${data.round_count ?? 0}라운드 / ${data.turn_count ?? 0}턴`
}

// ── 어시스트 UI ──────────────────────────────────────────────────────
function updateAssistUI(data) {
  const assist  = data.assist_active  ?? null
  const used    = data.assist_used    ?? false
  const req     = data.assist_request ?? null
  const blocked = cannotRequestSupport(data)
  const allDead = isAllPlayersDead(data)

  const reqBtn = $("assist-request-btn")
  if (reqBtn) {
    const isMyReq = req?.from === mySlot
    if (isSpectator || used || assist || allDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = allDead ? "사용 불가" : assist ? "🤝 어시스트 중" : used ? "지원 완료" : "요청 불가"
    } else if (isMyReq) {
      reqBtn.disabled  = true
      const agreeCnt   = req.agrees?.length ?? 0
      reqBtn.innerText = `요청 중... (${agreeCnt}/2 동의)`
    } else {
      reqBtn.disabled  = false
      reqBtn.innerText = "지원 요청"
      reqBtn.onclick   = () => { playSound(SFX_BTN); doRequestAssist() }
    }
  }

  const popup = $("assist-popup")
  if (popup) {
    const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
    const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
    const myFainted    = !myActivePkmn || myActivePkmn.hp <= 0
    const canAgree     = req && req.from !== mySlot
                      && !(req.agrees ?? []).includes(mySlot)
                      && !isSpectator && !myFainted
    if (canAgree) {
      popup.style.display = "block"
      const nameEl = $("assist-popup-name")
      if (nameEl) nameEl.innerText = req.fromName ?? req.from
      const agreeCnt = req.agrees?.length ?? 0
      const cntEl = $("assist-agree-count")
      if (cntEl) cntEl.innerText = `(${agreeCnt}/2 동의)`
    } else {
      popup.style.display = "none"
    }
  }
}

// ── 싱크로나이즈 UI ──────────────────────────────────────────────────
function updateSyncUI(data) {
  const sync    = data.sync_active  ?? null
  const used    = data.sync_used    ?? false
  const req     = data.sync_request ?? null
  const blocked = cannotRequestSupport(data)
  const allDead = isAllPlayersDead(data)

  const reqBtn = $("sync-request-btn")
  if (reqBtn) {
    const isMyReq = req?.from === mySlot
    if (isSpectator || used || sync || allDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = allDead ? "사용 불가" : sync ? "💠 싱크로 중" : used ? "동기화 완료" : "요청 불가"
    } else if (isMyReq) {
      reqBtn.disabled  = true
      const agreeCnt   = req.agrees?.length ?? 0
      reqBtn.innerText = `요청 중... (${agreeCnt}/2 동의)`
    } else {
      reqBtn.disabled  = false
      reqBtn.innerText = "동기화 요청"
      reqBtn.onclick   = () => { playSound(SFX_BTN); doRequestSync() }
    }
  }

  const statusEl = $("sync-status")
  if (statusEl) {
    if (sync) {
      const readyCnt = sync.ready?.length ?? 0
      statusEl.innerText = `💠 싱크로 진행 중 (${readyCnt}/3 준비)`
      statusEl.style.color = "#9b59b6"
    } else {
      statusEl.innerText = ""
    }
  }

  const popup = $("sync-popup")
  if (popup) {
    const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
    const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
    const myFainted    = !myActivePkmn || myActivePkmn.hp <= 0
    const canAgree     = req && req.from !== mySlot
                      && !(req.agrees ?? []).includes(mySlot)
                      && !isSpectator && !myFainted
    if (canAgree) {
      popup.style.display = "block"
      const nameEl = $("sync-popup-name")
      if (nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }
}

// ── 게임 오버 ────────────────────────────────────────────────────────
function showGameOver(data) {
  if (gameOver) return
  gameOver = true
  closeItemModal()
  const win = data.raid_result === "victory"
  const td  = $("turn-display")
  if (isSpectator) {
    if (td) { td.innerText = win ? "🏆 레이드 성공!" : "💀 레이드 실패..."; td.style.color = win ? "gold" : "red" }
  } else {
    if (td) { td.innerText = win ? "🏆 승리!" : "💀 패배..."; td.style.color = win ? "gold" : "red" }
  }
  for (let i = 0; i < 4; i++) { const b = $(`move-btn-${i}`); if (b) { b.disabled = true; b.onclick = null } }
  const bench = $("bench-container"); if (bench) bench.innerHTML = ""
  const bagBtn = $("bag-btn"); if (bagBtn) { bagBtn.disabled = true; bagBtn.onclick = null }
  const lb = $("leaveBtn")
  if (lb) { lb.style.display = "inline-block"; lb.disabled = false; lb.onclick = leaveGame }
}

async function doSkipTurn(timerExpired = false) {
  try { await _skipTurn({ roomId: ROOM_ID, mySlot, timerExpired }) }
  catch (e) { console.warn("skipTurn 오류:", e.message); actionDone = false }
}

// ── applyRoomData ────────────────────────────────────────────────────
function applyRoomData(data) {
  currentRoomData = data

  PLAYER_SLOTS.forEach(s => updateSlotUI(s, data))
  updateBossUI(data)
  updateBeedrillUI(data)
  updateOrderDisplay(data)
  updateTurnUI(data)
  if (!isSpectator) {
    updateMoveButtons(data)
    updateBenchButtons(data)
    updateAssistUI(data)
    updateSyncUI(data)
    updateBagButton(data)
  }
  const spectEl = $("spectator-list")
  if (spectEl) {
    const names = data.spectator_names ?? []
    spectEl.innerText = names.length > 0 ? "관전: " + names.join(", ") : ""
  }
  if (data.game_over) { showGameOver(data); return }
}

// ── 로그 리스너 ──────────────────────────────────────────────────────
function listenLogs(gameStartedAt) {
  let firstSnapshot = true
  const q = query(logsRef, orderBy("ts"))
  onSnapshot(q, snap => {
    const newEntries = []
    snap.docs.forEach(d => {
      if (renderedLogIds.has(d.id)) return
      const logData = d.data()
      if (gameStartedAt && logData.ts < gameStartedAt) return
      renderedLogIds.add(d.id)
      if (firstSnapshot) return
      newEntries.push(logData)
    })
    firstSnapshot = false
    if (newEntries.length > 0) enqueueLogs(newEntries)
  })
}

let lastDiceEventTs = 0

// ── 룸 리스너 ────────────────────────────────────────────────────────
function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const data = snap.data()
    if (!data || !data.p1_entry) return

    const order           = data.current_order ?? []
    const currentTurnSlot = order[0] ?? null
    lastTurnSlot = currentTurnSlot

    if (!isSpectator && !data.game_over) {
      const wasMyTurn   = myTurn
      const isMyTurnNow = order[0] === mySlot
      myTurn = isMyTurnNow

      if (!wasMyTurn && isMyTurnNow) {
        actionDone = false
        closeItemModal()
        // 타겟 선택 모드 해제
        if (beedrillTargetMode) exitBeedrillTargetMode(data)
      }

      if (myTurn && !actionDone) {
        const myEntry = data[`${mySlot}_entry`] ?? []
        if (myEntry.every(p => p.hp <= 0)) {
          actionDone = true; doSkipTurn(false)
        } else {
          const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
          const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]

          if (data[`force_switch_${mySlot}`] && myActivePkmn && myActivePkmn.hp > 0) {
            actionDone = false; applyRoomData(data); return
          }

          if (myActivePkmn?.outrageState?.active) {
            const outrageMoveIdx = (myActivePkmn.moves ?? [])
              .findIndex(m => m.name === myActivePkmn.outrageState.moveName)
            if (outrageMoveIdx !== -1) {
              actionDone = true
              // 역린도 독침붕 우선
              const hasBees = anyBeedrillAlive(data)
              let tSlots = ["boss"]
              if (hasBees) {
                const aliveBees = (data.Beedrill ?? []).map((b,i) => ({b,i})).filter(({b}) => b.hp > 0)
                const { i: bIdx } = aliveBees[Math.floor(Math.random() * aliveBees.length)]
                tSlots = [`beedrill_${bIdx}`]
              }
              _useMove({ roomId: ROOM_ID, mySlot, moveIdx: outrageMoveIdx, targetSlots: tSlots })
                .catch(e => { console.warn("역린 자동처리 오류:", e.message); actionDone = false })
              return
            }
          }

          const needsAutoMove = myActivePkmn?.bideState || myActivePkmn?.rollState?.active
          const needsAutoFly  = myActivePkmn?.flyState?.flying
          const needsAutoDig  = myActivePkmn?.digState?.digging
          const needsAutoDive = myActivePkmn?.ghostDiveState?.diving
          if (!actionDone && (needsAutoMove || needsAutoFly || needsAutoDig || needsAutoDive || myActivePkmn?.hyperBeamState)) {
            actionDone = true
            // 자동처리 기술도 독침붕 우선
            const hasBees = anyBeedrillAlive(data)
            let tSlots = ["boss"]
            if (hasBees) {
              const aliveBees = (data.Beedrill ?? []).map((b,i) => ({b,i})).filter(({b}) => b.hp > 0)
              const { i: bIdx } = aliveBees[Math.floor(Math.random() * aliveBees.length)]
              tSlots = [`beedrill_${bIdx}`]
            }
            _useMove({ roomId: ROOM_ID, mySlot, moveIdx: 0, targetSlots: tSlots })
              .catch(e => { console.warn("자동처리 오류:", e.message); actionDone = false })
          }
        }
      }

      if (order.length === 0 && data.game_started && data.intro_done) {
        tryStartRound()
      }
    }

    if (!isSpectator && !data.game_over && mySlot) {
      const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
      const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
      const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0
      const hasAlive     = (data[`${mySlot}_entry`] ?? []).some(p => p.hp > 0)
      const forceSwitch  = !!data[`force_switch_${mySlot}`]
      if (isFainted && hasAlive && (forceSwitch || myTurn)) {
        updateBenchButtons(data)
        updateTurnUI(data)
      }
    }

    if (data.dice_event && data.dice_event.ts > lastDiceEventTs) {
      if (!isProcessing && logQueue.length === 0) {
        lastDiceEventTs = data.dice_event.ts
        await animateRoundDice(data.dice_event.rolls, data.dice_event.slots)
        applyRoomData(data)
      } else {
        pendingRoomData = data
      }
      return
    }

    if (!isProcessing && logQueue.length === 0) {
      applyRoomData(data)
    } else {
      pendingRoomData = data
    }
  })
}

let startRoundLock = false
async function tryStartRound() {
  if (startRoundLock) return
  startRoundLock = true
  try { await _startRound({ roomId: ROOM_ID, mySlot }) }
  catch (e) { console.warn("startRound:", e.message) }
  finally { setTimeout(() => startRoundLock = false, 3000) }
}

// ── 어시스트 / 싱크로 API ────────────────────────────────────────────
async function doRequestAssist() {
  if (!myTurn) { alert("자신의 턴에만 지원 요청할 수 있어!"); return }
  try { await _requestAssist({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`어시스트 요청 실패: ${e.message}`) }
}
async function doAgreeAssist() {
  playSound(SFX_BTN)
  try { await _agreeAssist({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`동의 실패: ${e.message}`) }
}
async function doRejectAssist() {
  playSound(SFX_BTN)
  try { await _rejectAssist({ roomId: ROOM_ID, mySlot }) }
  catch (e) { console.warn("거절 실패:", e.message) }
}
async function doRequestSync() {
  if (!myTurn) { alert("자신의 턴에만 동기화 요청할 수 있어!"); return }
  try { await _requestSync({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`동기화 요청 실패: ${e.message}`) }
}
async function doAgreeSync() {
  playSound(SFX_BTN)
  try { await _agreeSync({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`동의 실패: ${e.message}`) }
}
async function doRejectSync() {
  playSound(SFX_BTN)
  try { await _rejectSync({ roomId: ROOM_ID, mySlot }) }
  catch (e) { console.warn("거절 실패:", e.message) }
}

async function leaveGame() {
  try { await _leaveGame({ roomId: ROOM_ID, myUid }) }
  catch (e) { console.error("leaveGame 오류:", e) }
  location.href = "../main.html"
}

// ── 초기화 ───────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (!user) return
  myUid = user.uid
  const roomSnap = await getDoc(roomRef)
  const data     = roomSnap.data()

  PLAYER_SLOTS.forEach(s => {
    const slotKey = s.replace("p", "player")
    if (data?.[`${slotKey}_uid`] === myUid) mySlot = s
  })

  if (isSpectator) {
    mySlot = null
    const td = $("turn-display")
    if (td) { td.innerText = "관전 중"; td.style.color = "gray" }
  }

  if (window.initRaidChat) {
    const userSnap = await getDoc(doc(db, "users", myUid))
    window.__myDisplayName = userSnap.data()?.nickname ?? myUid.slice(0, 6)
    window.initRaidChat({ db, ROOM_ID, myUid, mySlot, isSpectator, gameStartedAt: data?.game_started_at ?? 0 })
  }

  if (data?.p1_entry) applyRoomData(data)
  listenLogs(data?.game_started_at ?? 0)
  listenRoom()
})

window.__doRequestAssist = doRequestAssist
window.__doAgreeAssist   = doAgreeAssist
window.__doRejectAssist  = doRejectAssist
window.__doRequestSync   = doRequestSync
window.__doAgreeSync     = doAgreeSync
window.__doRejectSync    = doRejectSync