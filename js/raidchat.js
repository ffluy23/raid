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
  const rendered = new Set()

  // 채널 라벨
  const labelEl = document.getElementById("chat-channel-label")
  if (labelEl) labelEl.innerText = isSpectator ? "👁 관전자 채팅" : "🗡 레이드 채팅"

  if (isSpectator) {
    // 관전자: 일반 채팅 숨기고 관전자 섹션 표시
    const chatSection = document.getElementById("chat-section")
    if (chatSection) chatSection.style.display = "none"
    const spectatorSection = document.getElementById("spectator-chat-section")
    if (spectatorSection) spectatorSection.style.display = "block"

    // 레이드 전체 채팅 읽기 구독 (관전자도 볼 수 있음)
    const spectatorContainer = document.getElementById("spectator-chat-messages")
    if (spectatorContainer) {
      const ref = collection(db, "raid", ROOM_ID, "chat")
      const q   = gameStartedAt > 0
        ? query(ref, orderBy("ts"), where("ts", ">=", gameStartedAt))
        : query(ref, orderBy("ts"))
      onSnapshot(q, snap => {
        snap.docs.forEach(d => {
          if (rendered.has(d.id)) return
          rendered.add(d.id)
          const { nickname, text } = d.data()
          appendMessage(spectatorContainer, nickname, text)
        })
      })
    }

    // 관전자 채팅 전송
    async function sendSpectatorChat() {
      const input = document.getElementById("spectator-chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      const ref = collection(db, "raid", ROOM_ID, "chat")
      await addDoc(ref, { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("spectator-chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendSpectatorChat
    const inputEl = document.getElementById("spectator-chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendSpectatorChat() })

  } else {
    // 플레이어: 전체 공개 채팅
    const container = document.getElementById("chat-messages")
    if (!container) return

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

    async function sendChat() {
      const input = document.getElementById("chat-input")
      if (!input) return
      const text = input.value.trim()
      if (!text) return
      const nickname = window.__myDisplayName ?? myUid.slice(0, 6)
      await addDoc(ref, { uid: myUid, nickname, text, ts: Date.now() })
      input.value = ""
    }

    const sendBtn = document.getElementById("chat-send-btn")
    if (sendBtn) sendBtn.onclick = sendChat
    const inputEl = document.getElementById("chat-input")
    if (inputEl) inputEl.addEventListener("keypress", e => { if (e.key === "Enter") sendChat() })
  }
}