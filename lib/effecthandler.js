// effecthandler.js

export function statusName(status) {
  const map = { "독": "독", "화상": "화상", "마비": "마비", "얼음": "얼음" }
  return map[status] ?? status
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

export function applyStatus(pokemon, status) {
  if (pokemon.status) return []
  if (pokemon.hp <= 0) return []
  pokemon.status = status
  return [`${pokemon.name}${josa(pokemon.name, "은는")} ${statusName(status)} 상태가 됐다!`]
}

export function applyVolatile(pokemon, volatile) {
  if (pokemon.hp <= 0) return []
  if (volatile === "혼란") {
    if ((pokemon.confusion ?? 0) > 0) return []
    pokemon.confusion = Math.floor(Math.random() * 3) + 2  // 2~4턴
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 혼란에 빠졌다!`]
  }
  if (volatile === "풀죽음") {
    if (pokemon.flinch) return []
    pokemon.flinch = true
    return [`${pokemon.name}${josa(pokemon.name, "은는")} 풀이 죽었다!`]
  }
  return []
}

export function applyMoveEffect(moveEffect, attacker, defender, damage = 0) {
  if (!moveEffect) return []
  if (defender.hp <= 0) return []

  const msgs = []

  if (moveEffect.drain) {
    const heal = Math.floor(damage * moveEffect.drain)
    if (heal > 0) {
      attacker.hp = Math.min(attacker.maxHp ?? attacker.hp, attacker.hp + heal)
      msgs.push(`${attacker.name}${josa(attacker.name, "은는")} 체력을 흡수했다! (+${heal})`)
    }
    return msgs
  }

  if (moveEffect.status && Math.random() < moveEffect.chance) {
    msgs.push(...applyStatus(defender, moveEffect.status))
  }

  if (moveEffect.volatile && Math.random() < moveEffect.chance) {
    msgs.push(...applyVolatile(defender, moveEffect.volatile))
  }

  return msgs
}

export function checkPreActionStatus(pokemon) {
  const msgs = []
  if (pokemon.flinch) {
    pokemon.flinch = false
    msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 풀이 죽어서 움직일 수 없다!`)
    return { blocked: true, msgs, statusCleared: false }
  }
  // 마비: 25% 확률로 행동 불가
  if (pokemon.status === "마비") {
    if (Math.random() < 0.25) {
      msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 몸이 저려서 움직일 수 없다!`)
      return { blocked: true, msgs, statusCleared: false }
    }
  }
  // 얼음: 20% 확률로 해제, 아니면 행동 불가
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

export function checkConfusion(pokemon) {
  if ((pokemon.confusion ?? 0) <= 0) {
    pokemon.confusion = 0
    return { selfHit: false, damage: 0, msgs: [], fainted: false }
  }

  const msgs = []
  msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 혼란 상태다!`)

  let selfHit = false, damage = 0, fainted = false

  if (Math.random() < 1 / 3) {
    damage = (pokemon.attack ?? 3) * 2
    pokemon.hp = Math.max(0, pokemon.hp - damage)
    msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 영문도 모른 채 자신을 공격했다! (${damage} 데미지)`)
    fainted = pokemon.hp <= 0
    if (fainted) msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 쓰러졌다!`)
    selfHit = true
  }

  // 자해/행동 판정 이후에 턴 차감
  pokemon.confusion--
  if (pokemon.confusion <= 0) {
    pokemon.confusion = 0
    msgs.push(`${pokemon.name}${josa(pokemon.name, "은는")} 혼란에서 깨어났다!`)
  }

  return { selfHit, damage, msgs, fainted }
}

export function applyEndOfTurnDamage(entries) {
  const msgs = []
  let anyFainted = false
  for (const entry of entries) {
    for (const pkmn of entry) {
      if (pkmn.hp <= 0) continue
      if (pkmn.status !== "독" && pkmn.status !== "화상") continue
      const dmg = Math.max(1, Math.floor((pkmn.maxHp ?? pkmn.hp) / 16))
      pkmn.hp = Math.max(0, pkmn.hp - dmg)
      msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} ${statusName(pkmn.status)} 때문에 ${dmg} 데미지를 입었다!`)
      if (pkmn.hp <= 0) { msgs.push(`${pkmn.name}${josa(pkmn.name, "은는")} 쓰러졌다!`); anyFainted = true }
    }
  }
  return { msgs, anyFainted }
}

export function applyWeatherEffect(moveEffect) {
  if (!moveEffect?.weather) return { weather: null, msgs: [] }
  return { weather: moveEffect.weather, msgs: [`날씨가 ${moveEffect.weather}(으)로 바뀌었다!`] }
}

// 마비: 스피드 -1, 얼음: 스피드 -3
export function getStatusSpdPenalty(pokemon) {
  if (pokemon.status === "마비") return 1
  if (pokemon.status === "얼음") return 3
  return 0
}