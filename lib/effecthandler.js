// effecthandler.js (double battle)
// 싱글배틀 기준으로 타입 면역 / amulet 차단 / tickVolatiles 통합 포팅

export function statusName(status) {
  return status
}

export function josa(word, type) {
  if (!word) return type === "은는" ? "은" : type === "이가" ? "이" : type === "을를" ? "을" : type === "과와" ? "과" : "으로"
  const code = word.charCodeAt(word.length - 1)
  if (code < 0xAC00 || code > 0xD7A3) {
    return type === "은는" ? "은" : type === "이가" ? "이" : type === "을를" ? "을" : type === "과와" ? "과" : "으로"
  }
  const hasFinal = (code - 0xAC00) % 28 !== 0
  if (type === "은는") return hasFinal ? "은" : "는"
  if (type === "이가") return hasFinal ? "이" : "가"
  if (type === "을를") return hasFinal ? "을" : "를"
  if (type === "과와") return hasFinal ? "과" : "와"
  if (type === "으로") return hasFinal ? "으로" : "로"
  return ""
}

// ── 상태이상 부여 (타입 면역 + amulet 차단 포팅) ──────────────────
export function applyStatus(pokemon, status) {
  if (pokemon.status) return []
  if (pokemon.hp <= 0) return []

  // 신비의 부적: 상태이상 무효
  if ((pokemon.amuletTurns ?? 0) > 0)
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 신비의 부적으로 상태이상을 막았다!`]

  // 타입 면역
  const types = Array.isArray(pokemon.type) ? pokemon.type : [pokemon.type]
  if (status === "독" && (types.includes("독") || types.includes("강철")))
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 독에 걸리지 않는다!`]
  if (status === "화상" && types.includes("불"))
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 화상에 걸리지 않는다!`]
  if (status === "얼음" && types.includes("얼음"))
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 얼음에 걸리지 않는다!`]

  pokemon.status = status
  return [`${pokemon.name}${josa(pokemon.name, "은는")} ${statusName(status)} 상태가 됐다!`]
}

// ── 휘발성 상태 부여 ──────────────────────────────────────────────
export function applyVolatile(pokemon, volatile) {
  if (pokemon.hp <= 0) return []
  if (volatile === "혼란") {
    if ((pokemon.confusion ?? 0) > 0) return []
    pokemon.confusion = Math.floor(Math.random() * 3) + 1
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 혼란에 빠졌다!`]
  }
  if (volatile === "풀죽음") {
    if (pokemon.flinch) return []
    pokemon.flinch = true
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 풀이 죽었다!`]
  }
  return []
}

// ── 기술 부가효과 적용 ────────────────────────────────────────────
export function applyMoveEffect(moveEffect, attacker, defender, damage = 0) {
  if (!moveEffect) return []
  const msgs = []

  // 흡수 (drain)
  if (moveEffect.drain) {
    const heal = Math.floor(damage * moveEffect.drain)
    if (heal > 0) {
      attacker.hp = Math.min(attacker.maxHp ?? attacker.hp, attacker.hp + heal)
      msgs.push(`${attacker.name}${josa(attacker.name, "은는")} 체력을 흡수했다! (+${heal})`)
    }
    return msgs
  }

  if (defender.hp <= 0) return []

  // 불꽃세례: 얼음 해제
  if (moveEffect.thawEnemy && defender.status === "얼음") {
    defender.status = null
    msgs.push(`${defender.name}${josa(defender.name, "은는")} 얼음 상태에서 회복됐다!`)
  }

  // 상태이상 부여
  if (moveEffect.status && Math.random() < moveEffect.chance) {
    msgs.push(...applyStatus(defender, moveEffect.status))
  }

  // 상태변화 부여
  if (moveEffect.volatile && Math.random() < moveEffect.chance) {
    msgs.push(...applyVolatile(defender, moveEffect.volatile))
  }

  return msgs
}

// ── 행동 전 상태 체크 (마비/얼음/풀죽음) ─────────────────────────
export function checkPreActionStatus(pokemon) {
  const msgs = []
  if (pokemon.flinch) {
    pokemon.flinch = false
    msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 풀이 죽어서 움직일 수 없다!`)
    return { blocked: true, msgs, statusCleared: false }
  }
  if (pokemon.status === "마비") {
    if (Math.random() < 0.25) {
      msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 몸이 저려서 움직일 수 없다!`)
      return { blocked: true, msgs, statusCleared: false }
    }
  }
  if (pokemon.status === "얼음") {
    if (Math.random() < 0.20) {
      pokemon.status = null
      msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 얼음 상태에서 회복됐다!`)
      return { blocked: false, msgs, statusCleared: true }
    } else {
      msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 꽁꽁 얼어서 움직일 수 없다!`)
      return { blocked: true, msgs, statusCleared: false }
    }
  }
  return { blocked: false, msgs, statusCleared: false }
}

// ── 혼란 체크 ────────────────────────────────────────────────────
export function checkConfusion(pokemon) {
  if ((pokemon.confusion ?? 0) <= 0) {
    pokemon.confusion = 0
    return { selfHit: false, damage: 0, msgs: [], fainted: false }
  }
  pokemon.confusion--
  if (pokemon.confusion <= 0) {
    pokemon.confusion = 0
    return { selfHit: false, damage: 0, msgs: [`${pokemon.name}${josa(pokemon.name, "은는")} 혼란에서 깨어났다!`], fainted: false }
  }
  if (Math.random() < 1 / 3) {
    const damage = (pokemon.attack ?? 3) * 2
    pokemon.hp = Math.max(0, pokemon.hp - damage)
    const msgs = [
      `${pokemon.name}${josa(pokemon.name, "은는")} 혼란 상태다!`,
      `${pokemon.name}${josa(pokemon.name, "은는")} 영문도 모른 채 자신을 공격했다! (${damage} 데미지)`
    ]
    const fainted = pokemon.hp <= 0
    if (fainted) msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 쓰러졌다!`)
    return { selfHit: true, damage, msgs, fainted }
  }
  return { selfHit: false, damage: 0, msgs: [`${pokemon.name}${josa(pokemon.name, "은는")} 혼란 상태다!`], fainted: false }
}

// ── tickVolatiles: 턴 시작 시 volatile 상태 일괄 처리 ─────────────
export function tickVolatiles(pokemon) {
  const msgs = []

  // 신비의 부적 턴 감소
  if ((pokemon.amuletTurns ?? 0) > 0) {
    pokemon.amuletTurns--
    if (!pokemon.amuletTurns)
      msgs.push(`${pokemon.name}${josa(pokemon.name, "의")} 신비의 부적 효과가 사라졌다!`)
  }

  // 날개쉬기 roostTurns: 비행 타입 복원
  if ((pokemon.roostTurns ?? 0) > 0) {
    pokemon.roostTurns--
    if (!pokemon.roostTurns && pokemon._origType !== undefined) {
      pokemon.type = pokemon._origType
      delete pokemon._origType
    }
  }

  // 방어 턴 감소
  if ((pokemon.defendTurns ?? 0) > 0) {
    pokemon.defendTurns--
    if (!pokemon.defendTurns) pokemon.defending = false
  }

  // 희망사항 회복
  if ((pokemon.wishTurns ?? 0) > 0) {
    pokemon.wishTurns--
    if (!pokemon.wishTurns) {
      const heal = Math.max(1, Math.floor((pokemon.maxHp ?? pokemon.hp) * 0.22))
      pokemon.hp = Math.min(pokemon.maxHp ?? pokemon.hp, pokemon.hp + heal)
      msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 희망사항으로 HP를 회복했다! (+${heal})`)
    }
  }

  // 빛의 장막 턴 감소
  if ((pokemon.lightScreenTurns ?? 0) > 0) {
    pokemon.lightScreenTurns--
    if (!pokemon.lightScreenTurns)
      msgs.push(`${pokemon.name}${josa(pokemon.name, "의")} 빛의 장막이 사라졌다!`)
  }

  return msgs
}

// ── EOT 독/화상/아쿠아링/저주/미래예지/회복봉인/목조르기 ──────────
export function applyEndOfTurnDamage(entries, allEntries) {
  const msgs = []
  let anyFainted = false

  // entries: 각 슬롯의 entry 배열 배열 [[p1entries],[p2entries],...]
  // allEntries는 futureSight 공격 대상 탐색용 (flat)
  const ALL_SLOTS = ["p1", "p2", "p3", "p4"]


  for (const entry of entries) {
    for (const pkmn of entry) {
      if (pkmn.hp <= 0) continue

      // 아쿠아링 회복
      if (pkmn.aquaRing) {
        const heal = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.0625))
        pkmn.hp = Math.min(pkmn.maxHp ?? pkmn.hp, pkmn.hp + heal)
        msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 아쿠아링으로 HP를 회복했다! (+${heal})`)
      }

      // 저주 데미지
      if (pkmn.cursed) {
        const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) * 0.25))
        pkmn.hp = Math.max(0, pkmn.hp - dmg)
        msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 저주 때문에 ${dmg} 데미지를 입었다!`)
        if (pkmn.hp <= 0) { msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`); anyFainted = true; continue }
      }

      // 미래예지 카운트다운
      if (pkmn.futureSight) {
  pkmn.futureSight.turnsLeft--
  if (pkmn.futureSight.turnsLeft <= 0) {
    const power      = pkmn.futureSight.power ?? 70
    const atkName    = pkmn.futureSight.attackerName ?? "미래예지"
    const targetSlot = pkmn.futureSight.targetSlot ?? null
    pkmn.futureSight = null
    const entryIdx   = ALL_SLOTS.indexOf(targetSlot)
    const realTarget = entryIdx !== -1 ? entries[entryIdx]?.find(p => p.hp > 0) : null
    if (!realTarget) {
      msgs.push(`${atkName}의 미래예지가 실패했다!`)
    } else {
      const dmg = Math.max(1, power)
      realTarget.hp = Math.max(0, realTarget.hp - dmg)
      msgs.push(`${atkName}의 미래예지가 ${realTarget.name}${josa(realTarget.name, "을를")} 공격했다! (${dmg} 데미지)`)
      if (realTarget.hp <= 0) { msgs.push(`${realTarget.name}${josa(realTarget.name, "은는")} 쓰러졌다!`); anyFainted = true }
    }
  }
}

      // 회복봉인 턴 감소
      if ((pkmn.healBlocked ?? 0) > 0) {
        pkmn.healBlocked--
        if (!pkmn.healBlocked)
          msgs.push(`${pkmn.name}${josa(pkmn.name, "의")} 회복봉인이 풀렸다!`)
      }

      // 목조르기 턴 감소
      if ((pkmn.throatChopped ?? 0) > 0) {
        pkmn.throatChopped--
        if (!pkmn.throatChopped)
          msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 다시 소리를 낼 수 있게 됐다!`)
      }

      // 독/화상 데미지
      if (pkmn.status !== "독" && pkmn.status !== "화상") continue
      const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) / 16))
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
      msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} ${statusName(pkmn.status)} 때문에 ${dmg} 데미지를 입었다!`)
      if (pkmn.hp <= 0) { msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`); anyFainted = true }
    }
  }
  return { msgs, anyFainted }
}

// ── 날씨 효과 ─────────────────────────────────────────────────────
export function applyWeatherEffect(moveEffect) {
  if (!moveEffect?.weather) return { weather: null, msgs: [] }
  return { weather: moveEffect.weather, msgs: [`날씨가 ${moveEffect.weather}(으)로 바뀌었다!`] }
}

// ── 스피드 페널티 (마비/얼음) ─────────────────────────────────────
export function getStatusSpdPenalty(pokemon) {
  if (pokemon.status === "마비") return 1
  if (pokemon.status === "얼음") return 3
  return 0
}