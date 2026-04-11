export async function handleEot(db, roomId, entries, data, update) {
  const { applyEndOfTurnDamage, josa } = await import("./effecthandler.js")
  const logsRef = db.collection("double").doc(roomId).collection("logs")
  const eotLogs = []
  const base    = Date.now()

  ALL_FS.forEach(s => {
    const idx  = data[`${s}_active_idx`] ?? 0
    const pkmn = entries[s][idx]
    if (!pkmn || pkmn.hp <= 0) return

    // 아쿠아링
    if (pkmn.aquaRing && !(pkmn.healBlocked > 0)) {
      const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) / 16))
      pkmn.hp = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
      eotLogs.push({ text: `${pkmn.name}${josa(pkmn.name, "은는")} 아쿠아링으로 HP를 회복했다! (+${heal})`, type: "hp", meta: { slot: s, hp: pkmn.hp, maxHp: pkmn.maxHp } })
    }

    // 희망사항 (tickVolatiles에서 처리 안 된 경우 대비)
    // → doublebattle effecthandler의 tickVolatiles에서 이미 처리되므로 여기선 생략

    // 회복봉인 턴 감소
    if ((pkmn.healBlocked ?? 0) > 0) {
      pkmn.healBlocked--
      if (pkmn.healBlocked <= 0)
        eotLogs.push({ text: `${pkmn.name}${josa(pkmn.name, "의")} 회복봉인이 풀렸다!`, type: "normal" })
    }

    // 지옥찌르기 턴 감소
    if ((pkmn.throatChopped ?? 0) > 0) {
      pkmn.throatChopped--
      if (pkmn.throatChopped <= 0)
        eotLogs.push({ text: `${pkmn.name}${josa(pkmn.name, "은는")} 다시 소리를 낼 수 있게 됐다!`, type: "normal" })
    }
  })

  // 독/화상/저주 EOT
  const allEntryArrays = ALL_FS.map(s => entries[s])
  const { msgs: eotMsgs } = applyEndOfTurnDamage(allEntryArrays)

  const allLogs = [
    ...eotLogs,
    ...eotMsgs.map(text => ({ text, type: "normal" }))
  ]

  if (allLogs.length > 0) {
    const batch = db.batch()
    allLogs.forEach((entry, i) => {
      batch.set(logsRef.doc(), { ...entry, ts: base + i })
    })
    await batch.commit()
  }

  Object.assign(update, buildEntryUpdate(entries))
  const winAfterEot = checkWin(entries)
  if (winAfterEot) {
    update.game_over     = true
    update.winner_team   = winAfterEot
    update.current_order = []
    return winAfterEot
  }
  return null
}