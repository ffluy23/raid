// js/doublebattleroom.js
import { auth, db } from "./firebase.js"
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js"
import {
  doc, getDoc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

const roomRef = doc(db, "double", ROOM_ID)
let myUid         = null
let myDisplayName = null
let navigated     = false
let isAdmin       = false

const PLAYER_SLOTS = ["player1","player2","player3","player4"]
const SLOT_TO_FS   = { player1:"p1", player2:"p2", player3:"p3", player4:"p4" }

function calcMySlot(room) {
  if(!room || !myUid) return null
  for(const slot of PLAYER_SLOTS) {
    if(room[`${slot}_uid`] === myUid) return slot
  }
  if((room.spectators ?? []).includes(myUid)) return "spectator"
  return null
}

onAuthStateChanged(auth, async user => {
  if(!user) return
  myUid = user.uid

  const userSnap    = await getDoc(doc(db, "users", myUid))
  const userData    = userSnap.data()
  const nickname    = userData?.nickname ?? myUid.slice(0,6)
  const activeTitle = userData?.activeTitle ?? null
  myDisplayName     = activeTitle ? `[${activeTitle}] ${nickname}` : nickname
  isAdmin           = userData?.role === "admin"

  const adminPanel = document.getElementById("admin-panel")
  if(adminPanel) adminPanel.style.display = isAdmin ? "block" : "none"

  await joinRoom()
  listenRoom()
  setupButtons()
})

async function joinRoom() {
  const snap = await getDoc(roomRef)
  const room = snap.data()
  if(!room) return
  if(calcMySlot(room)) return

  if(room.game_started) { await joinAsSpectator(room); return }

  for(const slot of PLAYER_SLOTS) {
    if(!room[`${slot}_uid`]) {
      await updateDoc(roomRef, {
        [`${slot}_uid`]:  myUid,
        [`${slot}_name`]: myDisplayName
      })
      return
    }
  }
  await joinAsSpectator(room)
}

async function joinAsSpectator(room) {
  const spectators = room.spectators ?? []
  if(spectators.includes(myUid)) return
  await updateDoc(roomRef, {
    spectators:      [...spectators, myUid],
    spectator_names: [...(room.spectator_names ?? []), myDisplayName]
  })
}

function listenRoom() {
  onSnapshot(roomRef, async snap => {
    const room = snap.data()
    if(!room) return

    const mySlot = calcMySlot(room)

    PLAYER_SLOTS.forEach(slot => {
      const nameEl  = document.getElementById(slot)
      const readyEl = document.getElementById(`${slot}-ready`)
      if(nameEl)  nameEl.innerText  = `${slot.replace("player","Player")}: ${room[`${slot}_name`] ?? "대기 중..."}`
      if(readyEl) readyEl.innerText = room[`${slot}_ready`] ? "✅" : "⬜"
    })

    const spectEl = document.getElementById("spectator-list")
    if(spectEl) {
      const names = room.spectator_names ?? []
      spectEl.innerText = names.length > 0 ? "관전자: " + names.join(", ") : "관전자 없음"
    }

    updateButtons(room, mySlot)
    renderSwapRequest(room, mySlot)
    if(isAdmin) renderAdminPanel(room)

    const allReady = PLAYER_SLOTS.every(s => room[`${s}_ready`])
    if(allReady && !room.game_started && mySlot && mySlot !== "spectator") {
      await copyMyEntry(mySlot)

      if(mySlot === "player1") {
        let retries = 0
        while(retries < 10) {
          const freshSnap = await getDoc(roomRef)
          const freshRoom = freshSnap.data()
          const allUploaded = PLAYER_SLOTS.every(s => freshRoom[`${SLOT_TO_FS[s]}_entry`] !== null)
          if(allUploaded) {
            await updateDoc(roomRef, {
              game_started:     true,
              game_started_at:  Date.now(),
              round_count:      0,
              turn_count:       0,
              current_order:    [],
              pending_switches: []
            })
            break
          }
          await new Promise(r => setTimeout(r, 500))
          retries++
        }
      }
    }

    if(room.game_started && mySlot) {
      const allEntryReady = PLAYER_SLOTS.every(s => room[`${SLOT_TO_FS[s]}_entry`] !== null)
      if(!allEntryReady) return
      if(navigated) return
      navigated = true

      const num  = ROOM_ID.replace("doublebattleroom","")
      const dest = mySlot === "spectator"
        ? `../games/doublebattleroom${num}.html?spectator=true`
        : `../games/doublebattleroom${num}.html`
      location.href = dest
    }
  })
}

// ── 교체 요청 수신 팝업 ──────────────────────────────────────────────
function renderSwapRequest(room, mySlot) {
  const popup = document.getElementById("swap-popup")
  if(!popup) return
  const req = room.swap_request ?? null
  if(req && req.toUid === myUid && mySlot && mySlot !== "spectator") {
    popup.style.display = "block"
    const msgEl = document.getElementById("swap-popup-msg")
    if(msgEl) msgEl.innerText = `${req.fromName}님이 자리 교체를 요청했어요\n(${slotLabel(req.fromSlot)} ↔ ${slotLabel(mySlot)})`
    return
  }
  popup.style.display = "none"
}

function slotLabel(slot) {
  const map = { player1:"P1(A팀)", player2:"P2(A팀)", player3:"P3(B팀)", player4:"P4(B팀)" }
  return map[slot] ?? slot
}

// ── 어드민 패널 ──────────────────────────────────────────────────────
// 선택 항목: { type: "player", slot } | { type: "spectator", uid, name, idx }
let adminSelected = null

function renderAdminPanel(room) {
  const grid = document.getElementById("admin-player-grid")
  if(!grid) return
  grid.innerHTML = ""

  // ── 플레이어 슬롯 4개
  PLAYER_SLOTS.forEach(slot => {
    const uid  = room[`${slot}_uid`]
    const name = room[`${slot}_name`] ?? "빈 자리"
    const isSelected = adminSelected?.type === "player" && adminSelected.slot === slot

    const btn = document.createElement("button")
    btn.className = "admin-slot-btn"
      + (isSelected ? " selected" : "")
      + (!uid ? " empty" : "")
    btn.innerHTML = `<span class="admin-slot-label">${slotLabel(slot)}</span><span class="admin-slot-name">${name}</span>`
    btn.onclick = () => onAdminClick({ type: "player", slot, uid, name }, room)
    grid.appendChild(btn)
  })

  // ── 관전자 목록
  const spectators     = room.spectators ?? []
  const spectatorNames = room.spectator_names ?? []
  spectators.forEach((uid, idx) => {
    const name = spectatorNames[idx] ?? uid.slice(0, 6)
    const isSelected = adminSelected?.type === "spectator" && adminSelected.uid === uid

    const btn = document.createElement("button")
    btn.className = "admin-slot-btn" + (isSelected ? " selected" : "")
    btn.innerHTML = `<span class="admin-slot-label">관전자</span><span class="admin-slot-name">${name}</span>`
    btn.onclick = () => onAdminClick({ type: "spectator", uid, name, idx }, room)
    grid.appendChild(btn)
  })

  const hint = document.getElementById("admin-hint")
  if(hint) {
    if(!adminSelected) {
      hint.innerText = "교체할 사람을 선택하세요"
    } else {
      hint.innerText = `"${adminSelected.name}" 선택됨 → 교체할 대상을 클릭하세요 (같은 버튼 클릭 시 취소)`
    }
  }
}

function onAdminClick(target, room) {
  if(!adminSelected) {
    // 첫 선택 — 플레이어 빈 자리는 선택 불가
    if(target.type === "player" && !target.uid) return
    adminSelected = target
    renderAdminPanel(room)
    return
  }

  // 같은 거 클릭 → 취소
  const isSame = adminSelected.type === target.type
    && (adminSelected.type === "player"
      ? adminSelected.slot === target.slot
      : adminSelected.uid  === target.uid)
  if(isSame) {
    adminSelected = null
    renderAdminPanel(room)
    return
  }

  // 두 번째 선택 → 강제 swap
  adminForceSwap(adminSelected, target, room)
  adminSelected = null
}

async function adminForceSwap(a, b, room) {
  // a, b 각각 { type: "player", slot, uid, name } | { type: "spectator", uid, name, idx }
  const update = { swap_request: null }

  const spectators     = [...(room.spectators ?? [])]
  const spectatorNames = [...(room.spectator_names ?? [])]

  // 두 타입 조합에 따라 처리
  if(a.type === "player" && b.type === "player") {
    // 플레이어 ↔ 플레이어
    update[`${a.slot}_uid`]   = b.uid  ?? null
    update[`${a.slot}_name`]  = b.name ?? null
    update[`${a.slot}_ready`] = false
    update[`${b.slot}_uid`]   = a.uid  ?? null
    update[`${b.slot}_name`]  = a.name ?? null
    update[`${b.slot}_ready`] = false

  } else if(a.type === "player" && b.type === "spectator") {
    // 플레이어 → 관전자 자리, 관전자 → 플레이어 자리
    update[`${a.slot}_uid`]   = b.uid
    update[`${a.slot}_name`]  = b.name
    update[`${a.slot}_ready`] = false
    // 관전자 배열에서 b 제거, a 추가
    spectators.splice(b.idx, 1, a.uid)
    spectatorNames.splice(b.idx, 1, a.name)
    update.spectators      = spectators
    update.spectator_names = spectatorNames

  } else if(a.type === "spectator" && b.type === "player") {
    // 관전자 → 플레이어 자리, 플레이어 → 관전자 자리
    update[`${b.slot}_uid`]   = a.uid
    update[`${b.slot}_name`]  = a.name
    update[`${b.slot}_ready`] = false
    spectators.splice(a.idx, 1, b.uid)
    spectatorNames.splice(a.idx, 1, b.name)
    update.spectators      = spectators
    update.spectator_names = spectatorNames

  } else {
    // 관전자 ↔ 관전자 — 이름만 swap
    spectators[a.idx]      = b.uid;  spectators[b.idx]      = a.uid
    spectatorNames[a.idx]  = b.name; spectatorNames[b.idx]  = a.name
    update.spectators      = spectators
    update.spectator_names = spectatorNames
  }

  await updateDoc(roomRef, update)
}

async function copyMyEntry(mySlot) {
  const fsSlot   = SLOT_TO_FS[mySlot]
  const userSnap = await getDoc(doc(db, "users", myUid))
  const entry    = userSnap.data()?.entry ?? []
  const entryWithMax = entry.map(p => ({ ...p, maxHp: p.hp }))
  await updateDoc(roomRef, {
    [`${fsSlot}_entry`]:      entryWithMax,
    [`${fsSlot}_active_idx`]: 0
  })
}

function updateButtons(room, mySlot) {
  const isPlayer    = mySlot && mySlot !== "spectator"
  const isSpectator = mySlot === "spectator"

  const readyBtn   = document.getElementById("readyBtn")
  const swapBtn    = document.getElementById("swapBtn")
  const leaveBtn   = document.getElementById("leaveBtn")
  const reqSwapBtn = document.getElementById("reqSwapBtn")

  if(readyBtn) {
    readyBtn.style.display = isPlayer ? "inline-block" : "none"
    if(isPlayer) {
      const alreadyReady = !!room[`${mySlot}_ready`]
      readyBtn.disabled  = alreadyReady
      readyBtn.innerText = alreadyReady ? "Ready ✅" : "Ready"
    }
  }

  if(reqSwapBtn) {
    const hasPendingReq = !!(room.swap_request)
    reqSwapBtn.style.display = isPlayer && !room.game_started ? "inline-block" : "none"
    reqSwapBtn.disabled  = hasPendingReq
    reqSwapBtn.innerText = hasPendingReq && room.swap_request?.fromUid === myUid
      ? "요청 중..." : "자리 교체 요청"
  }

  // 관전자 → 빈 플레이어 자리 이동 (빈 자리 있을 때만)
  if(swapBtn) {
    const hasEmpty = PLAYER_SLOTS.some(s => !room[`${s}_uid`])
    swapBtn.style.display = isSpectator && hasEmpty && !room.game_started ? "inline-block" : "none"
  }

  if(leaveBtn) leaveBtn.disabled = isPlayer && !!room.game_started
}

function setupButtons() {
  document.getElementById("readyBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const mySlot = calcMySlot(snap.data())
    if(!mySlot || mySlot === "spectator") return
    await updateDoc(roomRef, { [`${mySlot}_ready`]: true })
  }

  document.getElementById("leaveBtn").onclick = async () => {
    const snap   = await getDoc(roomRef)
    const room   = snap.data()
    const mySlot = calcMySlot(room)
    if(mySlot && mySlot !== "spectator" && room.game_started) {
      alert("도망칠 수 없다!"); return
    }
    await leaveRoom(mySlot, room)
  }

  const swapBtn = document.getElementById("swapBtn")
  if(swapBtn) {
    swapBtn.onclick = async () => {
      const snap = await getDoc(roomRef)
      const room = snap.data()
      for(const slot of PLAYER_SLOTS) {
        if(!room[`${slot}_uid`]) { await promoteToPlayer(slot, room); return }
      }
      alert("빈 자리가 없어요")
    }
  }

  const reqSwapBtn = document.getElementById("reqSwapBtn")
  if(reqSwapBtn) reqSwapBtn.onclick = () => openSwapTargetModal()

  const acceptBtn = document.getElementById("swap-accept-btn")
  if(acceptBtn) {
    acceptBtn.onclick = async () => {
      const snap   = await getDoc(roomRef)
      const room   = snap.data()
      const mySlot = calcMySlot(room)
      const req    = room.swap_request
      if(!req || req.toUid !== myUid || !mySlot) return
      await updateDoc(roomRef, {
        [`${req.fromSlot}_uid`]:   myUid,
        [`${req.fromSlot}_name`]:  myDisplayName,
        [`${req.fromSlot}_ready`]: false,
        [`${mySlot}_uid`]:         req.fromUid,
        [`${mySlot}_name`]:        req.fromName,
        [`${mySlot}_ready`]:       false,
        swap_request:              null
      })
    }
  }

  const rejectBtn = document.getElementById("swap-reject-btn")
  if(rejectBtn) {
    rejectBtn.onclick = async () => {
      await updateDoc(roomRef, { swap_request: null })
    }
  }
}

function openSwapTargetModal() {
  const modal = document.getElementById("swap-target-modal")
  if(!modal) return
  getDoc(roomRef).then(snap => {
    const room   = snap.data()
    const mySlot = calcMySlot(room)
    const list   = document.getElementById("swap-target-list")
    if(!list) return
    list.innerHTML = ""
    PLAYER_SLOTS.forEach(slot => {
      if(slot === mySlot) return
      const uid  = room[`${slot}_uid`]
      const name = room[`${slot}_name`]
      if(!uid) return
      const btn = document.createElement("button")
      btn.className = "btn"
      btn.style.cssText = "margin:4px 0; width:100%; font-size:14px;"
      btn.innerText = `${slotLabel(slot)}: ${name}`
      btn.onclick = async () => {
        closeSwapTargetModal()
        await updateDoc(roomRef, {
          swap_request: {
            fromUid:  myUid,
            fromName: myDisplayName,
            fromSlot: mySlot,
            toUid:    uid,
            toName:   name,
            toSlot:   slot
          }
        })
      }
      list.appendChild(btn)
    })
    modal.style.display = "flex"
  })
}

function closeSwapTargetModal() {
  const modal = document.getElementById("swap-target-modal")
  if(modal) modal.style.display = "none"
}

async function leaveRoom(mySlot, room) {
  if(room.swap_request?.fromUid === myUid || room.swap_request?.toUid === myUid) {
    await updateDoc(roomRef, { swap_request: null })
  }
  if(mySlot && mySlot !== "spectator") {
    const spectators     = room.spectators ?? []
    const spectatorNames = room.spectator_names ?? []
    if(spectators.length > 0) {
      const idx = Math.floor(Math.random() * spectators.length)
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   spectators[idx],
        [`${mySlot}_name`]:  spectatorNames[idx],
        [`${mySlot}_ready`]: false,
        spectators:      spectators.filter((_,i) => i !== idx),
        spectator_names: spectatorNames.filter((_,i) => i !== idx)
      })
    } else {
      await updateDoc(roomRef, {
        [`${mySlot}_uid`]:   null,
        [`${mySlot}_name`]:  null,
        [`${mySlot}_ready`]: false
      })
    }
  } else {
    await updateDoc(roomRef, {
      spectators:      (room.spectators ?? []).filter(u => u !== myUid),
      spectator_names: (room.spectator_names ?? []).filter(n => n !== myDisplayName)
    })
  }
  location.href = "../main.html"
}

async function promoteToPlayer(targetSlot, room) {
  const spectators     = room.spectators ?? []
  const spectatorNames = room.spectator_names ?? []
  await updateDoc(roomRef, {
    [`${targetSlot}_uid`]:   myUid,
    [`${targetSlot}_name`]:  myDisplayName,
    spectators:      spectators.filter(u => u !== myUid),
    spectator_names: spectatorNames.filter(n => n !== myDisplayName)
  })
}