// js/raidchat.js - 레이드 전체 공개 채팅
import {
  collection, addDoc, onSnapshot, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"

function formatMessage(text) {
  return text.replace(/\((.+?)\)/g, '<span class="chat-action">($1)</span>')
}

function appendMessage(container, nickname, text) {
  const div = document.createElement("div")
  div.className = "chat-message"
  div.innerHTML = `<span class="chat-nick">${nickname}:</span> ${formatMessage(text)}`
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

window.initRaidChat = function({ db, ROOM_ID, myUid, mySlot, isSpectator, gameStartedAt = 0 }) {
  const rendered         = new Set()
  const renderedSpectator = new Set()

  const labelEl = document.getElementById("chat-channel-label")
  if (labelEl) labelEl.innerText = isSpectator ? "👁 관전자 채팅" : "🗡 레이드 채팅"

  // ── 플레이어 채팅 구독 (플레이어만) ──────────────────────────
  if (!isSpectator) {
    const container = document.getElementById("chat-messages")
    if (container) {
      const ref = collection(db, "raid", ROOM_ID, "chat")
      const q   = gameStartedAt > 0
        ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
        : query(ref, orderBy("ts"))
      onSnapshot(q, snap => {
        snap.docs.forEach(d => {
          if (rendered.has(d.id)) return
          rendered.add(d.id)
          const { nickname, text } = d.data()
          appendMessage(container, nickname, text)
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

    // 플레이어한테는 관전자 섹션 숨김
    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "none"

  } else {
    // ── 관전자: 플레이어 채팅 섹션 숨김 ─────────────────────────
    const chatSection = document.getElementById("chat-section")
    if (chatSection) chatSection.style.display = "none"
    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "block"

    // 관전자 채팅 구독 — spectator_chat 전용 컬렉션
    const spectatorContainer = document.getElementById("spectator-chat-messages")
    if (spectatorContainer) {
      const ref = collection(db, "raid", ROOM_ID, "spectator_chat")
      const q   = gameStartedAt > 0
        ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
        : query(ref, orderBy("ts"))
      onSnapshot(q, snap => {
        snap.docs.forEach(d => {
          if (renderedSpectator.has(d.id)) return
          renderedSpectator.add(d.id)
          const { nickname, text } = d.data()
          appendMessage(spectatorContainer, nickname, text)
        })
      })
    }

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