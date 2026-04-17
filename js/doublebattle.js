// js/doublebattle.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, collection, getDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
import { moves } from "./moves.js"
import { josa } from "./effecthandler.js"

window.__moves = moves

const API = "https://zenithfrontier.vercel.app/api"

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

const _startRound    = (data) => callApi("startRound",    data)
const _useMove       = (data) => callApi("useMove",       data)
const _switchPkmn    = (data) => callApi("switchPokemon", data)
const _skipTurn      = (data) => callApi("skipTurn",      data)
const _requestAssist = (data) => callApi("requestAssist", data)
const _acceptAssist  = (data) => callApi("acceptAssist",  data)
const _rejectAssist  = (data) => callApi("rejectAssist",  data)
const _requestSync   = (data) => callApi("requestSync",   data)
const _acceptSync    = (data) => callApi("acceptSync",    data)
const _rejectSync    = (data) => callApi("rejectSync",    data)
const _leaveGame     = (data) => callApi("leaveGame",     data)

const roomRef = doc(db, "double", ROOM_ID)
const logsRef = collection(db, "double", ROOM_ID, "logs")

let mySlot = null, myUid = null
let myTurn = false, actionDone = false, gameOver = false
let renderedLogIds   = new Set()
let renderedSyncLogs = new Set()
let isSpectator = new URLSearchParams(location.search).get("spectator") === "true"

let logQueue        = []
let isProcessing    = false
let pendingRoomData = null

const TYPE_COLORS = {
  "노말":"#949495","불":"#e56c3e","물":"#5185c5","전기":"#fbb917","풀":"#66a945",
  "얼음":"#6dc8eb","격투":"#e09c40","독":"#735198","땅":"#9c7743","바위":"#bfb889",
  "비행":"#a2c3e7","에스퍼":"#dd6b7b","벌레":"#9fa244","고스트":"#684870",
  "드래곤":"#535ca8","악":"#4c4948","강철":"#69a9c7","페어리":"#dab4d4"
}

let timerTickInterval = null
let timerSecondsLeft  = 120
let lastTurnSlot      = null
const TIMER_SECONDS   = 30

function $(id) { return document.getElementById(id) }
function rollD10() { return Math.floor(Math.random() * 10) + 1 }
function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

function teamOf(s)       { return ["p1","p2"].includes(s) ? "A" : "B" }
function allyOf(s)       { return s==="p1"?"p2":s==="p2"?"p1":s==="p3"?"p4":"p3" }
function enemySlotsOf(s) { return teamOf(s)==="A" ? ["p3","p4"] : ["p1","p2"] }

function isTeamAllDead(data) {
  if (!mySlot) return false
  const ally      = allyOf(mySlot)
  const myEntry   = data[`${mySlot}_entry`] ?? []
  const allyEntry = data[`${ally}_entry`]   ?? []
  return myEntry.every(p => p.hp <= 0) && allyEntry.every(p => p.hp <= 0)
}

function cannotRequestSupport(data) {
  if (!mySlot) return true
  const myActiveIdx = data[`${mySlot}_active_idx`] ?? 0
  const myPkmn      = data[`${mySlot}_entry`]?.[myActiveIdx]
  return !myPkmn || myPkmn.hp <= 0
}

const SPECTATOR_PREFIX = { p1: "my", p2: "ally", p3: "enemy1", p4: "enemy2" }

function slotToPrefix(slot) {
  if (!mySlot) return SPECTATOR_PREFIX[slot] ?? null
  if (slot === mySlot)          return "my"
  if (slot === allyOf(mySlot))  return "ally"
  const enemies = enemySlotsOf(mySlot)
  return slot === enemies[0] ? "enemy1" : "enemy2"
}

function updateHpBar(barId, textId, hp, maxHp, showNum) {
  const bar = $(barId), txt = textId ? $(textId) : null
  if (!bar) return
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, hp / maxHp * 100)) : 0
  bar.style.width = pct + "%"
  bar.style.backgroundColor = pct > 50 ? "#4caf50" : pct > 20 ? "#ff9800" : "#f44336"
  if (txt) txt.innerText = showNum ? `HP: ${hp} / ${maxHp}` : ""
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
  img.classList.remove("visible")
  img.style.display = "block"; img.src = pokemon.portrait; img.alt = pokemon.name
  setTimeout(() => img.classList.add("visible"), 60)
}

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
    const STATUS_LABEL = { "마비": "[마비]", "화상": "[화상]", "독": "[독]", "얼음": "[얼음]" }
    const statusTag    = pokemon.status ? " " + (STATUS_LABEL[pokemon.status] ?? "") : ""
    const confusionTag = (pokemon.confusion ?? 0) > 0 ? " [혼란]" : ""
    const flyTag       = pokemon.flyState?.flying   ? " ✈" : ""
    const digTag       = pokemon.digState?.digging  ? " ⛏" : ""
   const myTeam = teamOf(slot)
const screenTurns = data[`lightScreen_team${myTeam}`] ?? 0
const screenTag = screenTurns > 0 ? ` [막(${screenTurns})]` : ""
    nameEl.innerText = (pokemon.name ?? "???") + statusTag + confusionTag + flyTag + digTag + screenTag
  }

  const isMyTeam = prefix === "my" || prefix === "ally"
  updateHpBar(`${prefix}-hp-bar`, `${prefix}-active-hp`, pokemon.hp, pokemon.maxHp, isMyTeam)
  updatePortrait(prefix, pokemon)
}

function updateTimerDisplay() {
  const el = $("turn-timer")
  if (!el) return
  const m = Math.floor(timerSecondsLeft / 60)
  const s = timerSecondsLeft % 60
  el.innerText = `${m}:${String(s).padStart(2, "0")}`
  el.style.color = timerSecondsLeft <= 30 ? "#f44336"
                 : timerSecondsLeft <= 60 ? "#ff9800"
                 : "#888"
}

function startTurnTimer(turnStartedAt, data) {
  clearTurnTimer()
  const el = $("turn-timer")
  if (el) el.style.display = "inline"
  const calcRemaining = () => {
    const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000)
    return Math.max(0, TIMER_SECONDS - elapsed)
  }
  timerSecondsLeft = calcRemaining()
  updateTimerDisplay()
  timerTickInterval = setInterval(() => {
    timerSecondsLeft = calcRemaining()
    updateTimerDisplay()
    if (timerSecondsLeft <= 0) {
      clearTurnTimer()
      if (!isSpectator) triggerAutoAction(data)
    }
  }, 1000)
}

function clearTurnTimer() {
  if (timerTickInterval) { clearInterval(timerTickInterval); timerTickInterval = null }
  const el = $("turn-timer")
  if (el) { el.style.display = "none"; el.innerText = "" }
}

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
  if (usable.length === 0) {
    actionDone = true; doSkipTurn(true); return
  }
  const { mv, i: moveIdx } = usable[Math.floor(Math.random() * usable.length)]
  const moveInfo = moves[mv.name] ?? {}
  if (moveInfo.aoe) {
    const aoeTargets = ["p1","p2","p3","p4"].filter(s => {
      if (s === mySlot) return false
      const ai = data[`${s}_active_idx`] ?? 0
      const p  = data[`${s}_entry`]?.[ai]
      return p && p.hp > 0
    })
    doUseMove(moveIdx, aoeTargets, data); return
  }
  if (moveInfo.aoeEnemy) {
    const et = enemySlotsOf(mySlot).filter(s => {
      const ai = data[`${s}_active_idx`] ?? 0
      const p  = data[`${s}_entry`]?.[ai]
      return p && p.hp > 0
    })
    doUseMove(moveIdx, et, data); return
  }
  const r = moveInfo.rank
  const needsTarget =
    moveInfo.power
    || (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))
    || moveInfo.roar || moveInfo.leechSeed || moveInfo.chainBind
    || moveInfo.dragonTail || moveInfo.healPulse || moveInfo.poisonPowder || moveInfo.decoration
    || moveInfo.pollenPuff || moveInfo.curse || moveInfo.ghostDive|| moveInfo.memento || moveInfo.taunt
    || (moveInfo.effect?.volatile && !moveInfo.targetSelf)
    || (moveInfo.effect?.status && moveInfo.targetSelf === false)
  if (needsTarget) {
    if (moveInfo.pollenPuff) {
      const ally = allyOf(mySlot)
      const allyPkmn = data[`${ally}_entry`]?.[data[`${ally}_active_idx`] ?? 0]
      const allyAlive = allyPkmn && allyPkmn.hp > 0
      const enemies = enemySlotsOf(mySlot).filter(s => {
        const ai = data[`${s}_active_idx`] ?? 0
        const p  = data[`${s}_entry`]?.[ai]
        return p && p.hp > 0
      })
      if (allyAlive && (enemies.length === 0 || Math.random() < 0.5)) {
        doUseMove(moveIdx, [ally], data)
      } else if (enemies.length > 0) {
        doUseMove(moveIdx, [enemies[Math.floor(Math.random() * enemies.length)]], data)
      } else {
        doUseMove(moveIdx, [], data)
      }
    } else {
      const enemies = enemySlotsOf(mySlot).filter(s => {
        const ai = data[`${s}_active_idx`] ?? 0
        const p  = data[`${s}_entry`]?.[ai]
        return p && p.hp > 0
      })
      const target = enemies.length > 0
        ? enemies[Math.floor(Math.random() * enemies.length)]
        : null
      doUseMove(moveIdx, target ? [target] : [], data)
    }
  } else {
    doUseMove(moveIdx, [], data)
  }
}

async function handleLogEntry(entry) {
  const { type, text, meta } = entry
  const logEl = $("battle-log")
  switch (type) {
    case "normal":
    case "after_hit": {
      if (!text) break
      await typeText(logEl, text); await wait(120); break
    }
    case "move_announce": {
      if (!text) break
      await typeText(logEl, text); await wait(200); break
    }
    case "dice": {
      if (!meta) break
      await animateAttackDice(meta.slot, meta.roll); break
    }
    case "hit": {
      if (!meta?.defender) break
      const prefix = slotToPrefix(meta.defender)
      if (prefix) { await triggerAttackEffect(prefix); await triggerBlink(prefix) }
      break
    }
    case "hp": {
      if (!meta?.slot) break
      const prefix = slotToPrefix(meta.slot)
      if (!prefix) break
      const isMyTeam = prefix === "my" || prefix === "ally"
      await animateHpBar(prefix, meta.hp, meta.maxHp, isMyTeam)
      if (text) await typeText(logEl, text)
      await wait(100); break
    }
    case "assist": { await showAssistAnimation(); break }
    case "sync":   { await showSyncAnimation();   break }
    case "faint": {
      if (text) await typeText(logEl, text)
      if (meta?.slot) {
        const prefix = slotToPrefix(meta.slot)
        const area   = $(`${prefix}-pokemon-area`)
        if (area) area.classList.add("fainted")
      }
      await wait(300); break
    }
    default: { if (text) { await typeText(logEl, text) } break }
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
  const entry = logQueue.shift()
  try { await handleLogEntry(entry) } catch (e) { console.warn("logEntry 처리 오류:", e) }
  isProcessing = false
  setTimeout(processLogQueue, 50)
}

function animateHpBar(prefix, targetHp, maxHp, showNum) {
  return new Promise(resolve => {
    const bar = $(`${prefix}-hp-bar`)
    const txt = $(`${prefix}-active-hp`)
    if (!bar) { resolve(); return }
    const targetPct = maxHp > 0 ? Math.max(0, Math.min(100, targetHp / maxHp * 100)) : 0
    const color = targetPct > 50 ? "#4caf50" : targetPct > 20 ? "#ff9800" : "#f44336"
    bar.style.transition = "width 0.4s ease, background-color 0.4s ease"
    bar.style.width      = targetPct + "%"
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
    ;["p1","p2","p3","p4"].forEach(s => {
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
    ;["p1","p2","p3","p4"].forEach(s => {
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

// ── 기술 버튼 ────────────────────────────────────
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
      btn.innerHTML = `
        <span style="display:block;font-size:13px;font-weight:bold">${mv.name} 🔗</span>
        <span style="display:block;font-size:10px;opacity:.85">사슬묶기 중!</span>
      `
      btn.style.setProperty("--btn-color", "#666")
      btn.style.background = "#555"
      btn.style.boxShadow  = "inset 0 0 0 2px white, 0 0 0 2px #666"
      btn.disabled = true; btn.onclick = null; continue
    }

    if (isAutoTurn) {
      const isActiveFly = myPokemon?.flyState?.flying  && moveInfo.fly
      const isActiveDig = myPokemon?.digState?.digging && moveInfo.dig
      btn.innerHTML = `
        <span style="display:block;font-size:13px;font-weight:bold">${mv.name}${isActiveFly ? " ✈" : isActiveDig ? " ⛏" : ""}</span>
        <span style="display:block;font-size:10px;opacity:.85">${isActiveFly || isActiveDig ? "준비 중..." : `PP: ${mv.pp} | ${acc}`}</span>
      `
      const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
      btn.style.setProperty("--btn-color", color)
      btn.style.background = color
      btn.style.boxShadow  = `inset 0 0 0 2px white, 0 0 0 2px ${color}`
      btn.disabled = true; btn.onclick = null; continue
    }

    btn.innerHTML = `
      <span style="display:block;font-size:13px;font-weight:bold">${mv.name}</span>
      <span style="display:block;font-size:10px;opacity:.85">PP: ${mv.pp} | ${acc}</span>
    `
    const color = TYPE_COLORS[moveInfo.type] ?? "#a0a0a0"
    btn.style.setProperty("--btn-color", color)
    btn.style.background = color
    btn.style.boxShadow  = `inset 0 0 0 2px white, 0 0 0 2px ${color}`

    const lockedByTorment    = !!(myPokemon?.tormented && mv.name === myPokemon?.lastUsedMove)
    const soundMoves         = ["금속음","돌림노래","바크아웃","소란피기","싫은소리","울부짖기","울음소리","차밍보이스","비밀이야기","하이퍼보이스","매혹의보이스"]
    const lockedByThroatChop = !!((myPokemon?.throatChopped ?? 0) > 0 && soundMoves.includes(mv.name))
    const lockedByOutrage    = !!(myPokemon?.outrageState?.active)
    const lockedByTaunt = !!((myPokemon?.taunted ?? 0) > 0 && !(moveInfo?.power > 0))

    const canUse = !isSpectator && !fainted && mv.pp > 0 && myTurn && !actionDone
      && !isChainBlocked && !lockedByTorment && !lockedByThroatChop && !lockedByOutrage && !lockedByTaunt
    btn.disabled = !canUse
    btn.onclick  = canUse ? () => { playSound(SFX_BTN); onMoveClick(i, moveInfo, data) } : null
  }
}

let pendingMoveIdx = -1

function onMoveClick(idx, moveInfo, data) {
  if (actionDone) return
   if (moveInfo?.outrage) {
    const enemies = enemySlotsOf(mySlot).filter(s => {
      const ai = data[`${s}_active_idx`] ?? 0
      const p  = data[`${s}_entry`]?.[ai]
      return p && p.hp > 0
    })
    const target = enemies.length > 0
      ? enemies[Math.floor(Math.random() * enemies.length)]
      : null
    doUseMove(idx, target ? [target] : [], data)
    return
  }
  if (moveInfo?.aoe) {
    const aoeTargets = ["p1","p2","p3","p4"].filter(s => {
      if (s === mySlot) return false
      const activeIdx = data[`${s}_active_idx`] ?? 0
      const p = data[`${s}_entry`]?.[activeIdx]
      return p && p.hp > 0
    })
    doUseMove(idx, aoeTargets, data); return
  }
  if (moveInfo?.aoeEnemy) {
    const enemyTargets = enemySlotsOf(mySlot).filter(s => {
      const activeIdx = data[`${s}_active_idx`] ?? 0
      const p = data[`${s}_entry`]?.[activeIdx]
      return p && p.hp > 0
    })
    doUseMove(idx, enemyTargets, data); return
  }
  const r = moveInfo?.rank
 const targetsEnemy =
    moveInfo?.power || moveInfo?.ghostDive || moveInfo?.futureSight
    || moveInfo?.taunt|| moveInfo?.memento
    || (r && (r.targetAtk !== undefined || r.targetDef !== undefined || r.targetSpd !== undefined))
    || moveInfo?.roar || moveInfo?.leechSeed || moveInfo?.chainBind
    || moveInfo?.dragonTail || moveInfo?.healPulse || moveInfo?.poisonPowder
    || moveInfo?.pollenPuff || moveInfo?.curse
    || (moveInfo?.effect?.volatile && !moveInfo?.targetSelf)
    || (moveInfo?.effect?.status && moveInfo?.targetSelf === false)
  const targetsAlly = moveInfo?.healPulse || moveInfo?.pollenPuff || moveInfo?.decoration

  if (targetsEnemy || targetsAlly) {
    enterTargetMode(idx, data, { targetsEnemy: !!targetsEnemy, targetsAlly: !!targetsAlly })
  } else {
    doUseMove(idx, [], data)
  }
}

function enterTargetMode(idx, data, { targetsEnemy = true, targetsAlly = false } = {}) {
  pendingMoveIdx = idx
  const hint = $("target-hint")
  if (hint) hint.style.display = "block"
  const clickableSlots = []
  if (targetsEnemy) enemySlotsOf(mySlot).forEach(s => clickableSlots.push(s))
  if (targetsAlly)  clickableSlots.push(allyOf(mySlot))
  clickableSlots.forEach(eSlot => {
    const eActiveIdx = data[`${eSlot}_active_idx`] ?? 0
    const ePkmn      = data[`${eSlot}_entry`]?.[eActiveIdx]
    if (!ePkmn || ePkmn.hp <= 0) return
    const prefix = slotToPrefix(eSlot)
    const area   = $(`${prefix}-pokemon-area`)
    if (!area) return
    area.classList.add("target-selectable")
    area.onclick = () => {
      playSound(SFX_BTN)
      const capturedIdx = pendingMoveIdx
      exitTargetMode()
      doUseMove(capturedIdx, [eSlot], data)
    }
  })
}

function exitTargetMode() {
  pendingMoveIdx = -1
  const hint = $("target-hint")
  if (hint) hint.style.display = "none"
  ;["enemy1","enemy2","ally"].forEach(prefix => {
    const area = $(`${prefix}-pokemon-area`)
    if (!area) return
    area.classList.remove("target-selectable")
    area.onclick = null
  })
}

async function doUseMove(moveIdx, targetSlots, data) {
  if (actionDone) return
  clearTurnTimer()
  actionDone = true
  updateMoveButtons(data)
  try {
    await _useMove({ roomId: ROOM_ID, mySlot, moveIdx, targetSlots })
  } catch (e) {
    console.error("useMove 오류:", e.message)
    actionDone = false
    updateMoveButtons(data)
  }
}

// ── 교체 버튼 ────────────────────────────────────
function updateBenchButtons(data) {
  const bench = $("bench-container")
  if (!bench) return
  bench.innerHTML = ""

  const myEntry      = data[`${mySlot}_entry`] ?? []
  const activeIdx    = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = myEntry[activeIdx]
  const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0

  // 유턴 강제교체 여부 (force_switch + 내 턴 + 살아있음)
  const forceSwitch = !!data[`force_switch_${mySlot}`]

  // 고스트다이브/공중날기/구멍파기 중이면 교체 불가
  const isDiving  = !!(myActivePkmn?.ghostDiveState?.diving)
  const isFlying  = !!(myActivePkmn?.flyState?.flying)
  const isDigging = !!(myActivePkmn?.digState?.digging)

  const forcedHint = $("forced-switch-hint")
  if (forcedHint) forcedHint.style.display = "none"

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
  console.log("doSwitchPokemon", { newIdx, forceSwitch, actionDone })
  const myEntry      = data[`${mySlot}_entry`] ?? []
  const activeIdx    = data[`${mySlot}_active_idx`] ?? 0
  const myActivePkmn = myEntry[activeIdx]
  const isFainted    = !myActivePkmn || myActivePkmn.hp <= 0
  if (!isFainted && !forceSwitch && actionDone) return
  clearTurnTimer()
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

function updateOrderDisplay(data) {
  const el = $("order-display")
  if (!el) return
  const order = data.current_order ?? []
  if (order.length === 0) { el.innerHTML = ""; return }
  el.innerHTML = order.map((slot, i) => {
    const slotKey = slot.replace("p", "player")
    const name    = (data[`${slotKey}_name`] ?? slot).split("]").pop().trim()
    const isActive = i === 0
    const isMine   = slot === mySlot
    let cls = "order-item"
    if (isActive) cls += " active"
    else if (isMine) cls += " mine"
    return `<div class="${cls}">${i+1}. ${name}</div>`
  }).join("")
}

function updateTurnUI(data) {
  const el = $("turn-display")
  if (!el) return
  const order = data.current_order ?? []
  if (isSpectator) {
    if (order.length > 0) {
      const s       = order[0]
      const slotKey = s.replace("p", "player")
      const name    = (data[`${slotKey}_name`] ?? s).split("]").pop().trim()
      el.innerText  = `${name}의 턴`; el.style.color = "#333"
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
  } else {
    const idx    = order.indexOf(mySlot)
    el.innerText = idx > 0 ? `${idx}번째 대기중...` : "상대 턴..."
    el.style.color = "gray"
  }
  const tc = $("turn-count")
  if (tc) tc.innerText = `${data.round_count ?? 0}라운드 / ${data.turn_count ?? 0}턴`
}

function updateAssistUI(data) {
  const myTeam   = teamOf(mySlot)
  const assist   = data[`assist_team${myTeam}`] ?? null
  const used     = data[`assist_used_${myTeam}`] ?? false
  const req      = data.assist_request ?? null
  const teamDead = isTeamAllDead(data)
  const blocked  = cannotRequestSupport(data)
  const reqBtn = $("assist-request-btn")
  if (reqBtn) {
    const isMyReq = req && req.from === mySlot
    if (isSpectator || used || assist || teamDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : assist ? "🤝 어시스트 중" : used ? "지원 완료" : blocked ? "요청 불가" : "지원 요청"
    } else if (isMyReq) {
      reqBtn.disabled = true; reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled = false; reqBtn.innerText = "지원 요청"
      reqBtn.onclick = () => { playSound(SFX_BTN); doRequestAssist() }
    }
  }
  const statusEl = $("assist-status")
  if (statusEl) {
    if (assist?.requester === mySlot) {
      statusEl.innerText = `🤝 어시스트 대기 중 (${assist.supporterName})`; statusEl.style.color = "#e67e22"
    } else if (assist?.supporter === mySlot) {
      statusEl.innerText = `🤝 어시스트 지원 중 (${assist.requesterName})`; statusEl.style.color = "#3498db"
    } else {
      statusEl.innerText = ""
    }
  }
  const popup = $("assist-popup")
  if (popup) {
    const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
    const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
    const myFainted    = !myActivePkmn || myActivePkmn.hp <= 0
    if (req && req.to === mySlot && !isSpectator && !myFainted) {
      popup.style.display = "block"
      const nameEl = $("assist-popup-name")
      if (nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }
}

function updateSyncUI(data) {
  const myTeam   = teamOf(mySlot)
  const sync     = data[`sync_team${myTeam}`] ?? null
  const used     = data[`sync_used_${myTeam}`] ?? false
  const req      = data.sync_request ?? null
  const teamDead = isTeamAllDead(data)
  const blocked  = cannotRequestSupport(data)
  const reqBtn = $("sync-request-btn")
  if (reqBtn) {
    const isMyReq = req && req.from === mySlot
    if (isSpectator || used || sync || teamDead || blocked) {
      reqBtn.disabled  = true
      reqBtn.innerText = teamDead ? "사용 불가" : sync ? "💠 싱크로나이즈 중" : used ? "동기화 완료" : blocked ? "요청 불가" : "동기화 요청"
    } else if (isMyReq) {
      reqBtn.disabled = true; reqBtn.innerText = "요청 중..."
    } else {
      reqBtn.disabled = false; reqBtn.innerText = "동기화 요청"
      reqBtn.onclick = () => { playSound(SFX_BTN); doRequestSync() }
    }
  }
  const statusEl = $("sync-status")
  if (statusEl) {
    if (sync?.requester === mySlot || sync?.supporter === mySlot) {
      const partner = sync.requester === mySlot ? sync.supporterName : sync.requesterName
      statusEl.innerText = `💠 싱크로나이즈 (${partner})`; statusEl.style.color = "#9b59b6"
    } else {
      statusEl.innerText = ""
    }
  }
  const popup = $("sync-popup")
  if (popup) {
    const myActiveIdx2  = data[`${mySlot}_active_idx`] ?? 0
    const myActivePkmn2 = data[`${mySlot}_entry`]?.[myActiveIdx2]
    const myFainted2    = !myActivePkmn2 || myActivePkmn2.hp <= 0
    if (req && req.to === mySlot && !isSpectator && !myFainted2) {
      popup.style.display = "block"
      const nameEl = $("sync-popup-name")
      if (nameEl) nameEl.innerText = req.fromName ?? req.from
    } else {
      popup.style.display = "none"
    }
  }
  const myTeamKey = `sync_log_${myTeam}`
  const syncLog   = data[myTeamKey]
  if (syncLog && !renderedSyncLogs.has(syncLog)) {
    renderedSyncLogs.add(syncLog)
    logQueue.push({ type: "normal", text: syncLog, ts: Date.now() })
    processLogQueue()
  }
}

function showGameOver(data) {
  if (gameOver) return
  gameOver = true
  clearTurnTimer()
  exitTargetMode()
  const myTeam = teamOf(mySlot)
  const win    = data.winner_team === myTeam
  const td     = $("turn-display")
  if (isSpectator) {
    if (td) { td.innerText = `🏆 팀 ${data.winner_team} 승리!`; td.style.color = "gold" }
  } else {
    if (td) { td.innerText = win ? "🏆 승리!" : "💀 패배..."; td.style.color = win ? "gold" : "red" }
  }
  for (let i = 0; i < 4; i++) { const b = $(`move-btn-${i}`); if (b) { b.disabled = true; b.onclick = null } }
  const bench = $("bench-container"); if (bench) bench.innerHTML = ""
  const lb = $("leaveBtn")
  if (lb) { lb.style.display = "inline-block"; lb.disabled = false; lb.onclick = leaveGame }
}

async function doSkipTurn(timerExpired = false) {
  try {
    await _skipTurn({ roomId: ROOM_ID, mySlot, timerExpired })
  } catch (e) {
    console.warn("skipTurn 오류:", e.message)
    actionDone = false
  }
}

function applyRoomData(data) {
  ;["p1","p2","p3","p4"].forEach(s => updateSlotUI(s, data))
  updateOrderDisplay(data)
  updateTurnUI(data)
  if (!isSpectator) {
    updateMoveButtons(data)
    updateBenchButtons(data)
    updateAssistUI(data)
    updateSyncUI(data)
  }
  const spectEl = $("spectator-list")
  if (spectEl) {
    const names = data.spectator_names ?? []
    spectEl.innerText = names.length > 0 ? "관전: " + names.join(", ") : ""
  }
  if (data.game_over) { showGameOver(data); return }
}

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

function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const data = snap.data()
    if (!data || !data.p1_entry) return

    const order           = data.current_order ?? []
    const currentTurnSlot = order[0] ?? null

    if (currentTurnSlot !== lastTurnSlot) {
      lastTurnSlot = currentTurnSlot
      clearTurnTimer()
      if (currentTurnSlot && !data.game_over) {
        const turnStartedAt = data.turn_started_at ?? Date.now()
        if (isSpectator) {
          const calcRemaining = () => {
            const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000)
            return Math.max(0, TIMER_SECONDS - elapsed)
          }
          timerSecondsLeft = calcRemaining()
          const el = $("turn-timer")
          if (el) el.style.display = "inline"
          updateTimerDisplay()
          timerTickInterval = setInterval(() => {
            timerSecondsLeft = calcRemaining()
            updateTimerDisplay()
            if (timerSecondsLeft <= 0) clearTurnTimer()
          }, 1000)
        }
      }
    }

    if (!isSpectator && !data.game_over) {
      const wasMyTurn   = myTurn
      const isMyTurnNow = order[0] === mySlot
      myTurn = isMyTurnNow

      if (!wasMyTurn && isMyTurnNow) {
        actionDone = false
        const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
        const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
        const isAutoTurnNow = !!(
          myActivePkmn?.bideState             ||
          myActivePkmn?.rollState?.active      ||
          myActivePkmn?.flyState?.flying       ||
          myActivePkmn?.digState?.digging      ||
          myActivePkmn?.ghostDiveState?.diving ||
          myActivePkmn?.hyperBeamState
        )
        if (!isAutoTurnNow) {
          const turnStartedAt = data.turn_started_at ?? Date.now()
          startTurnTimer(turnStartedAt, data)
        }
      }

      if (!isMyTurnNow && currentTurnSlot && !data.game_over) {
        if (!timerTickInterval) {
          clearTurnTimer()
          const turnStartedAt = data.turn_started_at ?? Date.now()
          const calcRemaining = () => {
            const elapsed = Math.floor((Date.now() - turnStartedAt) / 1000)
            return Math.max(0, TIMER_SECONDS - elapsed)
          }
          timerSecondsLeft = calcRemaining()
          const el = $("turn-timer")
          if (el) el.style.display = "inline"
          updateTimerDisplay()
          timerTickInterval = setInterval(() => {
            timerSecondsLeft = calcRemaining()
            updateTimerDisplay()
            if (timerSecondsLeft <= 0) clearTurnTimer()
          }, 1000)
        }
      }

      if (myTurn && !actionDone) {
        const myEntry = data[`${mySlot}_entry`] ?? []
        if (myEntry.every(p => p.hp <= 0)) {
          actionDone = true; doSkipTurn(false)
        } else {
          const myActiveIdx  = data[`${mySlot}_active_idx`] ?? 0
          const myActivePkmn = data[`${mySlot}_entry`]?.[myActiveIdx]
          const needsAutoMove = myActivePkmn?.bideState || myActivePkmn?.rollState?.active
          const needsAutoFly  = myActivePkmn?.flyState?.flying
          const needsAutoDig  = myActivePkmn?.digState?.digging
          const needsAutoDive = myActivePkmn?.ghostDiveState?.diving

          // 유턴 강제교체 — 자동처리보다 먼저 체크
          if (data[`force_switch_${mySlot}`] && myActivePkmn && myActivePkmn.hp > 0) {
            actionDone = false
            applyRoomData(data)
            return
          }

          // outrageState 자동발동
       if (myActivePkmn?.outrageState?.active) {
  const outrageMoveIdx = (myActivePkmn.moves ?? [])
    .findIndex(m => m.name === myActivePkmn.outrageState.moveName)
  if (outrageMoveIdx !== -1) {
    const enemies = enemySlotsOf(mySlot).filter(s => {
      const ai = data[`${s}_active_idx`] ?? 0
      const p  = data[`${s}_entry`]?.[ai]
      return p && p.hp > 0
    })
    const target = enemies.length > 0
      ? enemies[Math.floor(Math.random() * enemies.length)]
      : null
    actionDone = true
    _useMove({ roomId: ROOM_ID, mySlot, moveIdx: outrageMoveIdx, targetSlots: target ? [target] : [] })
      .catch(e => { console.warn("역린 자동처리 오류:", e.message); actionDone = false })
    return
  }
}

         if (!actionDone && (needsAutoMove || needsAutoFly || needsAutoDig || needsAutoDive || myActivePkmn?.hyperBeamState)) {
            actionDone = true
            _useMove({ roomId: ROOM_ID, mySlot, moveIdx: 0, targetSlots: [] })
              .catch(e => { console.warn("자동처리 오류:", e.message); actionDone = false })
          }
        }
      }

      if (order.length === 0 && data.game_started && data.intro_done) {
        tryStartRound()
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
  try {
    await _startRound({ roomId: ROOM_ID, mySlot })
  } catch (e) {
    console.warn("startRound:", e.message)
  } finally {
    setTimeout(() => startRoundLock = false, 3000)
  }
}

async function doRequestAssist() {
  if (!myTurn) { alert("자신의 턴에만 지원 요청할 수 있어!"); return }
  try { await _requestAssist({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`어시스트 요청 실패: ${e.message}`) }
}
async function doAcceptAssist() {
  playSound(SFX_BTN)
  try { await _acceptAssist({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`수락 실패: ${e.message}`) }
}
async function doRejectAssist() {
  playSound(SFX_BTN)
  try { await _rejectAssist({ roomId: ROOM_ID }) }
  catch (e) { console.warn("거절 실패:", e.message) }
}

async function doRequestSync() {
  if (!myTurn) { alert("자신의 턴에만 동기화 요청할 수 있어!"); return }
  try { await _requestSync({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`동기화 요청 실패: ${e.message}`) }
}
async function doAcceptSync() {
  playSound(SFX_BTN)
  try { await _acceptSync({ roomId: ROOM_ID, mySlot }) }
  catch (e) { alert(`수락 실패: ${e.message}`) }
}
async function doRejectSync() {
  playSound(SFX_BTN)
  try { await _rejectSync({ roomId: ROOM_ID }) }
  catch (e) { console.warn("거절 실패:", e.message) }
}

async function leaveGame() {
  try { await _leaveGame({ roomId: ROOM_ID, myUid }) }
  catch (e) { console.error("leaveGame 오류:", e) }
  location.href = "../main.html"
}

onAuthStateChanged(auth, async user => {
  if (!user) return
  myUid = user.uid
  const roomSnap = await getDoc(roomRef)
  const data     = roomSnap.data()
  ;["p1","p2","p3","p4"].forEach(s => {
    const slotKey = s.replace("p", "player")
    if (data?.[`${slotKey}_uid`] === myUid) mySlot = s
  })
  if (isSpectator) {
    const td = $("turn-display")
    if (td) { td.innerText = "관전 중"; td.style.color = "gray" }
  }
  if (window.initDoubleChat) {
    const userSnap = await getDoc(doc(db, "users", myUid))
    window.__myDisplayName = userSnap.data()?.nickname ?? myUid.slice(0, 6)
    window.initDoubleChat({ db, ROOM_ID, myUid, mySlot, isSpectator, gameStartedAt: data?.game_started_at ?? 0 })
  }
  if (data?.p1_entry) applyRoomData(data)
  listenLogs(data?.game_started_at ?? 0)
  listenRoom()
})

window.__doRequestAssist = doRequestAssist
window.__doAcceptAssist  = doAcceptAssist
window.__doRejectAssist  = doRejectAssist
window.__doRequestSync   = doRequestSync
window.__doAcceptSync    = doAcceptSync
window.__doRejectSync    = doRejectSync