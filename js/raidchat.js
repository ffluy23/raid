// js/raidchat.js - 레이드 전체 공개 채팅
import {
  collection, addDoc, onSnapshot, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

function formatMessage(text) {
  return text.replace(/\((.+?)\)/g, '<span class="chat-action">($1)</span>')
}

function appendMessage(container, nickname, text, type = "player") {
  const div = document.createElement("div")
  div.className = `chat-message chat-message--${type}`
  div.innerHTML = `<span class="chat-nick">${nickname}:</span> ${formatMessage(text)}`
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

window.initRaidChat = function({ db, ROOM_ID, myUid, mySlot, isSpectator, gameStartedAt = 0 }) {
  const renderedPlayer    = new Set()
  const renderedSpectator = new Set()

  const labelEl = document.getElementById("chat-channel-label")

  if (!isSpectator) {
    // ── 플레이어: chat 컬렉션만 ────────────────────────────────
    if (labelEl) labelEl.innerText = "🗡 레이드 채팅"

    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "none"

    const container = document.getElementById("chat-messages")
    if (container) {
      const ref = collection(db, "raid", ROOM_ID, "chat")
      const q   = gameStartedAt > 0
        ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
        : query(ref, orderBy("ts"))
      onSnapshot(q, snap => {
        snap.docs.forEach(d => {
          if (renderedPlayer.has(d.id)) return
          renderedPlayer.add(d.id)
          const { nickname, text } = d.data()
          appendMessage(container, nickname, text, "player")
        })
      })
    }

    async function sendChat() {
      const input = document.getElementById("chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      await addDoc(collection(db, "raid", ROOM_ID, "chat"), { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendChat
    const inputEl = document.getElementById("chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendChat() })

  } else {
    // ── 관전자: 플레이어 채팅 읽기 + 관전자 채팅 읽기/쓰기 ────
    if (labelEl) labelEl.innerText = "👁 관전 중"

    const chatSection = document.getElementById("chat-section")
    if (chatSection) chatSection.style.display = "none"
    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "flex"

    const container = document.getElementById("spectator-chat-messages")
    if (!container) return

    // 플레이어 채팅 구독 (읽기 전용, 다른 색 표시)
    const playerRef = collection(db, "raid", ROOM_ID, "chat")
    const playerQ   = gameStartedAt > 0
      ? query(playerRef, orderBy("ts"), where("ts", ">=", gameStartedAt))
      : query(playerRef, orderBy("ts"))
    onSnapshot(playerQ, snap => {
      snap.docs.forEach(d => {
        if (renderedPlayer.has(d.id)) return
        renderedPlayer.add(d.id)
        const { nickname, text } = d.data()
        appendMessage(container, `[플레이어] ${nickname}`, text, "player-readonly")
      })
    })

    // 관전자 채팅 구독
    const spectRef = collection(db, "raid", ROOM_ID, "spectator_chat")
    const spectQ   = gameStartedAt > 0
      ? query(spectRef, orderBy("ts"), where("ts", ">=", gameStartedAt))
      : query(spectRef, orderBy("ts"))
    onSnapshot(spectQ, snap => {
      snap.docs.forEach(d => {
        if (renderedSpectator.has(d.id)) return
        renderedSpectator.add(d.id)
        const { nickname, text } = d.data()
        appendMessage(container, nickname, text, "spectator")
      })
    })

    async function sendSpectatorChat() {
      const input = document.getElementById("spectator-chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      await addDoc(collection(db, "raid", ROOM_ID, "spectator_chat"), { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("spectator-chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendSpectatorChat
    const inputEl = document.getElementById("spectator-chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendSpectatorChat() })
  }
}