const express = require('express')
const http = require('http')
const path = require('path')
const WebSocket = require('ws')
const crypto = require('crypto')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 16 * 1024 })

const MAX_PLAYERS = 8
const SUITS = ['harten', 'ruiten', 'klaveren', 'schoppen']
const RANKS = ['10', '9', '8', '7', 'A', 'H', 'V', 'B']
const RANK_ORDER = { '10': 8, '9': 7, '8': 6, '7': 5, A: 4, H: 3, V: 2, B: 1 }
const SUIT_ICONS = { harten: '♥', ruiten: '♦', klaveren: '♣', schoppen: '♠' }
// Weergave: Boer=J, Vrouw=Q, Heer=K (intern blijven de codes B/V/H).
const RANK_LABELS = { '10': '10', '9': '9', '8': '8', '7': '7', A: 'A', H: 'K', V: 'Q', B: 'J' }
// Plaatjes = J, Q, K (Boer, Vrouw, Heer). Aas en 10 tellen NIET als plaatje.
const FACE_RANKS = ['B', 'V', 'H']

function countRank(hand, rank) {
  return hand.filter((card) => card.rank === rank).length
}

function isVuileWasHand(hand) {
  const faceCount = hand.filter((card) => FACE_RANKS.includes(card.rank)).length
  const hasSeven = hand.some((card) => card.rank === '7')
  return faceCount === 4 || (faceCount === 3 && hasSeven)
}

app.set('trust proxy', 1)
app.use(express.json({ limit: '32kb' }))
app.use(express.static(path.join(__dirname, '..', 'dist')))

const rooms = new Map()

const ROOM_TTL_MS = 6 * 60 * 60 * 1000 // verwijder rooms na 6 uur inactiviteit
const MAX_ROOMS = 2000
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

function clamp(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function touchRoom(room) {
  if (room) room.lastActivity = Date.now()
}

function makeId() {
  return crypto.randomBytes(8).toString('hex')
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  let code = ''
  for (let i = 0; i < 4; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

function makeDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, label: RANK_LABELS[rank] + SUIT_ICONS[suit], order: RANK_ORDER[rank] })
    }
  }
  return deck
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
}

function createRoom(name, settings) {
  const code = makeUniqueCode()
  const player = createPlayer(name)
  const room = {
    code,
    hostId: player.id,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    players: [player],
    settings: {
      maxPoints: clamp(settings.maxPoints, 5, 100, 15),
      // Vuile was staat standaard AAN (alleen uit als expliciet false meegestuurd).
      houseSwap: !!settings.houseSwap,
      houseDirtyWash: settings.houseDirtyWash === undefined ? true : !!settings.houseDirtyWash
    },
    phase: 'lobby',
    roundNumber: 0,
    logs: [],
    chat: [],
    game: {
      dealerIndex: -1,
      currentTurnId: null,
      leadSuit: null,
      currentStake: 1,
      isBetting: false,
      toeperId: null,
      bettingOrder: [],
      bettingIndex: 0,
      trick: [],
      finishedTricks: [],
      drawPile: [],
      washClaim: null
    }
  }
  rooms.set(code, room)
  return { room, player }
}

function makeUniqueCode() {
  let attempts = 0
  let code
  do {
    code = makeCode()
    attempts += 1
    if (attempts > 100) break
  } while (rooms.has(code))
  return code
}

function createPlayer(name) {
  return {
    id: makeId(),
    name: sanitizeName(name) || 'Speler',
    score: 0,
    hand: [],
    ws: null,
    inRound: true,
    passed: false,
    swapped: false,
    dirtyWashUsed: false,
    washResolved: false,
    eligibleArmoe: false,
    eligibleSwap: false,
    eligibleDirtyWash: false,
    eligibleFluiten: false,
    fourRank: null,
    connected: true
  }
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 20)
}

function sanitizeChat(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

function pushChat(room, player, text) {
  const message = sanitizeChat(text)
  if (!message) return
  room.chat.push({ id: makeId(), playerId: player.id, name: player.name, text: message, time: Date.now() })
  if (room.chat.length > 60) room.chat = room.chat.slice(-60)
}

function getRoom(code) {
  return rooms.get(code)
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId)
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function log(room, message) {
  room.logs.unshift({ id: makeId(), message, time: Date.now() })
  room.logs = room.logs.slice(0, 20)
}

function roomStateForPlayer(room, playerId) {
  const player = getPlayer(room, playerId)
  const others = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: !!p.ws,
    inRound: p.inRound,
    passed: p.passed,
    isHost: p.id === room.hostId,
    eliminated: p.score >= room.settings.maxPoints
  }))

  const turnPlayer = room.players.find((p) => p.id === room.game.currentTurnId)
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: others,
    yourId: playerId,
    yourName: player ? player.name : '',
    yourHand: player ? player.hand : [],
    currentStake: room.game.currentStake,
    currentTurnId: room.game.currentTurnId,
    currentTurnName: turnPlayer ? turnPlayer.name : null,
    leadSuit: room.game.leadSuit,
    trick: room.game.trick,
    finishedTricks: room.game.finishedTricks,
    roundNumber: room.roundNumber,
    logs: room.logs,
    chat: room.chat,
    settings: room.settings,
    maxPoints: room.settings.maxPoints,
    canStart: room.phase === 'lobby' && room.players.length >= 2,
    canBeginRound: room.phase === 'preplay' && room.hostId === playerId && !room.game.washClaim,
    canToep:
      room.phase === 'playing' && room.game.currentTurnId === playerId && !room.game.isBetting &&
      room.game.toeperId !== playerId,
    betting:
      room.game.isBetting && room.game.bettingOrder[room.game.bettingIndex] === playerId,
    bettingChoiceAvailable: room.game.isBetting,
    canSwap:
      room.phase === 'preplay' && player && player.eligibleSwap && !player.swapped,
    canClaimWash:
      room.phase === 'preplay' && room.settings.houseDirtyWash && !room.game.washClaim &&
      player && player.score < room.settings.maxPoints && !player.washResolved,
    washClaim: room.game.washClaim
      ? { claimerId: room.game.washClaim.claimerId, claimerName: getPlayer(room, room.game.washClaim.claimerId)?.name }
      : null,
    washRespond: !!(room.game.washClaim && room.game.washClaim.responders[room.game.washClaim.index] === playerId),
    canFluiten:
      player && (room.phase === 'preplay' || room.phase === 'playing') && countRank(player.hand, '10') === 3,
    canPlay:
      room.phase === 'playing' && room.game.currentTurnId === playerId && !room.game.isBetting,
    gameOver: room.phase === 'game-over',
    winnerId: room.winnerId || null,
    availableBetChoices: room.game.isBetting
  }
}

function broadcastRoom(room) {
  touchRoom(room)
  room.players.forEach((player) => {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      send(player.ws, { type: 'state', payload: roomStateForPlayer(room, player.id) })
    }
  })
}

function setHostIfNeeded(room) {
  // De kamermaker blijft host, ook bij een tijdelijke disconnect (spelers worden
  // niet uit de room verwijderd). Alleen als de host echt niet meer bestaat,
  // dragen we het host-schap over aan een andere speler.
  const hostExists = room.players.some((p) => p.id === room.hostId)
  if (hostExists) return
  const fallback = room.players.find((p) => p.ws && p.ws.readyState === WebSocket.OPEN) || room.players[0]
  if (fallback) {
    room.hostId = fallback.id
    log(room, `${fallback.name} is nu host.`)
  }
}

function applyHouseRules(room) {
  room.players.forEach((player) => {
    const counts = {}
    RANKS.forEach((rank) => { counts[rank] = countRank(player.hand, rank) })
    const fourRank = RANKS.find((rank) => counts[rank] === 4) || null
    // 4 dezelfde = altijd directe rondewinst (geen instelling).
    player.eligibleArmoe = !!fourRank
    player.fourRank = fourRank
    player.eligibleSwap = room.settings.houseSwap && RANKS.some((rank) => counts[rank] === 3)
    // eligibleDirtyWash = of de hand ÉCHT vuile was is (voor de controle/bluf).
    player.eligibleDirtyWash = isVuileWasHand(player.hand)
    // 3 tienen = fluiten (gimmick).
    player.eligibleFluiten = counts['10'] === 3
    player.washResolved = false
  })
}

function startRound(room) {
  const activePlayers = room.players.filter((player) => player.score < room.settings.maxPoints)
  if (activePlayers.length < 2) {
    room.phase = 'game-over'
    const winner = activePlayers[0]
    if (winner) {
      room.winnerId = winner.id
      log(room, `${winner.name} wint het spel!`)
    }
    return
  }

  const deck = makeDeck()
  shuffle(deck)
  room.players.forEach((player) => {
    if (player.score >= room.settings.maxPoints) {
      player.hand = []
      player.inRound = false
      player.passed = true
      player.swapped = false
      player.dirtyWashUsed = false
      player.eligibleArmoe = false
      player.eligibleSwap = false
      player.eligibleDirtyWash = false
      return
    }
    player.hand = deck.splice(0, 4)
    player.inRound = true
    player.passed = false
    player.swapped = false
    player.dirtyWashUsed = false
    player.eligibleArmoe = false
    player.eligibleSwap = false
    player.eligibleDirtyWash = false
  })
  room.game = {
    dealerIndex: typeof room.game.dealerIndex === 'number' ? (room.game.dealerIndex + 1) % room.players.length : 0,
    currentTurnId: null,
    leadSuit: null,
    currentStake: 1,
    isBetting: false,
    toeperId: null,
    bettingOrder: [],
    bettingIndex: 0,
    trick: [],
    finishedTricks: [],
    drawPile: deck,
    roundHasStarted: false,
    trickNumber: 0,
    washClaim: null
  }

  room.roundNumber += 1
  const nextDealerIndex = room.game.dealerIndex
  const nextLeadIndex = room.players.findIndex(
    (player, index) => index === (nextDealerIndex + 1) % room.players.length && player.score < room.settings.maxPoints
  )
  const startingPlayer = room.players[nextLeadIndex] || room.players.find((player) => player.score < room.settings.maxPoints)
  room.game.currentTurnId = startingPlayer.id
  room.game.startingPlayerId = startingPlayer.id

  applyHouseRules(room)

  log(room, `Ronde ${room.roundNumber} gestart. ${startingPlayer.name} begint.`)

  const armoeWinner = room.players.find((player) => player.eligibleArmoe)
  if (armoeWinner) {
    room.phase = 'playing'
    if (armoeWinner.fourRank === '10') {
      // 4 tienen = "op tafel"-gimmick.
      log(room, `Vier tienen voor ${armoeWinner.name}! Op tafel — en directe rondewinst.`)
      broadcastEffect(room, { kind: 'tafel', name: armoeWinner.name })
    } else {
      log(room, `Vier gelijke voor ${armoeWinner.name}! Directe rondewinst.`)
    }
    finishRound(room, armoeWinner.id, true)
    return
  }

  // Met vuile was aan kun je elke ronde (bluf)claimen, dus gaan we altijd eerst
  // naar de preplay-fase. Zonder vuile was alleen als iemand mag wisselen.
  const needsPreplay = room.settings.houseDirtyWash || room.players.some((player) => player.eligibleSwap)
  room.phase = needsPreplay ? 'preplay' : 'playing'
  if (needsPreplay) {
    log(room, 'Vóór de ronde: vuile was claimen of wisselen kan nu. Host start de ronde.')
  }
}

function beginPlay(room) {
  if (room.phase !== 'preplay') return { error: 'De ronde is al begonnen.' }
  if (room.game.washClaim) return { error: 'Eerst de vuile-was-controle afronden.' }
  room.phase = 'playing'
  log(room, 'De ronde begint.')
  broadcastRoom(room)
  return { ok: true }
}

function finishRound(room, winnerId, directWin, multiplier = 1) {
  const winner = getPlayer(room, winnerId)
  if (!winner) return
  const activePlayers = room.players.filter((player) => player.inRound && !player.passed && player.score < room.settings.maxPoints)
  const losers = activePlayers.filter((player) => player.id !== winnerId)
  const penalty = room.game.currentStake * multiplier

  if (multiplier > 1) {
    log(room, 'Beslissende slag met een boer — dubbele strafpunten!')
  }
  if (losers.length > 0) {
    losers.forEach((player) => {
      player.score += penalty
    })
  }

  room.phase = 'round-end'
  room.winnerId = winnerId
  log(room, `${winner.name} wint de ronde.`)
  if (losers.length > 0 && !directWin) {
    log(room, `${losers.map((player) => `${player.name} +${penalty}`).join(', ')}`)
  }

  const deadPlayers = room.players.filter((player) => player.score >= room.settings.maxPoints)
  if (deadPlayers.length > 0) {
    room.phase = 'game-over'
    room.winnerId = winnerId
    log(room, `${winner.name} wint het spel. ${deadPlayers.map((p) => p.name).join(', ')} is dood.`)
  }
}

function getNextActivePlayer(room, fromId) {
  const living = room.players.filter((player) => player.score < room.settings.maxPoints)
  const startIndex = living.findIndex((player) => player.id === fromId)
  for (let offset = 1; offset < living.length; offset += 1) {
    const next = living[(startIndex + offset) % living.length]
    if (next.inRound && !next.passed) return next
  }
  return null
}

function validatePlay(room, player, card) {
  if (room.phase !== 'playing' || room.game.isBetting) return 'Niet in de speelmodus.'
  if (room.game.currentTurnId !== player.id) return 'Het is niet jouw beurt.'
  if (!card) return 'Geen kaart opgegeven.'
  const handCard = player.hand.find((c) => c.suit === card.suit && c.rank === card.rank)
  if (!handCard) return 'Je hebt die kaart niet.'
  if (room.game.leadSuit) {
    const hasSameSuit = player.hand.some((c) => c.suit === room.game.leadSuit)
    if (hasSameSuit && card.suit !== room.game.leadSuit) return 'Je moet kleur bekennen.'
  }
  return null
}

function determineTrickWinner(trick) {
  const leadSuit = trick[0].card.suit
  return trick.filter((play) => play.card.suit === leadSuit).reduce((best, play) => {
    return play.card.order > best.card.order ? play : best
  })
}

function playCard(room, playerId, card) {
  const player = getPlayer(room, playerId)
  if (!player) return
  const err = validatePlay(room, player, card)
  if (err) return { error: err }

  const index = player.hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank)
  const playedCard = player.hand.splice(index, 1)[0]
  const trickPlay = { playerId, card: playedCard }
  if (!room.game.leadSuit) {
    room.game.leadSuit = playedCard.suit
  }
  room.game.trick.push(trickPlay)
  room.game.roundHasStarted = true
  log(room, `${player.name} speelt ${playedCard.label}.`)

  const activeCount = room.players.filter((p) => p.inRound && !p.passed && p.score < room.settings.maxPoints).length
  if (room.game.trick.length < activeCount) {
    const nextPlayer = getNextActivePlayer(room, player.id)
    room.game.currentTurnId = nextPlayer ? nextPlayer.id : null
    broadcastRoom(room)
    return { ok: true }
  }

  const winnerPlay = determineTrickWinner(room.game.trick)
  const winner = getPlayer(room, winnerPlay.playerId)
  room.game.finishedTricks.push({ plays: room.game.trick, winnerId: winner.id })
  room.game.trick = []
  room.game.leadSuit = null
  room.game.currentTurnId = winner.id
  room.game.trickNumber = (room.game.trickNumber || 0) + 1
  log(room, `${winner.name} wint de slag met ${winnerPlay.card.label}.`)

  const unfinishedPlayers = room.players.filter((p) => p.inRound && !p.passed && p.score < room.settings.maxPoints)
  if (unfinishedPlayers.length <= 1 || room.game.trickNumber >= 4) {
    // Beslissende slag gewonnen met een boer (J) => dubbele strafpunten.
    const decidedByBoer = winnerPlay.card.rank === 'B'
    finishRound(room, winner.id, false, decidedByBoer ? 2 : 1)
    broadcastRoom(room)
    return { ok: true }
  }

  broadcastRoom(room)
  return { ok: true }
}

function beginBetting(room, playerId) {
  if (room.phase !== 'playing' || room.game.isBetting) return { error: 'Kan nu niet toepen.' }
  if (room.game.currentTurnId !== playerId) return { error: 'Het is niet jouw beurt.' }
  // Je mag niet twee keer achter elkaar toepen: pas weer nadat iemand anders heeft getoept.
  if (room.game.toeperId === playerId) {
    return { error: 'Je mag niet twee keer achter elkaar toepen — wacht tot iemand anders toept.' }
  }
  const player = getPlayer(room, playerId)
  if (!player) return { error: 'Speler niet gevonden.' }
  const activePlayers = room.players.filter((p) => p.inRound && !p.passed && p.score < room.settings.maxPoints)
  if (activePlayers.length < 2) return { error: 'Niet genoeg spelers voor toep.' }

  room.game.currentStake = room.game.currentStake + 1
  room.game.toeperId = player.id
  room.game.isBetting = true
  room.game.bettingOrder = activePlayers
    .filter((p) => p.id !== player.id)
    .map((p) => p.id)
  room.game.bettingIndex = 0

  log(room, `${player.name} toept! Inzet is nu ${room.game.currentStake}.`) 
  const next = getPlayer(room, room.game.bettingOrder[room.game.bettingIndex])
  if (next) {
    room.game.currentTurnId = next.id
  }
  broadcastRoom(room)
  return { ok: true }
}

function processBet(room, playerId, choice) {
  if (!room.game.isBetting) return { error: 'Er is geen toepronde.' }
  if (room.game.bettingOrder[room.game.bettingIndex] !== playerId) return { error: 'Het is niet jouw beurt om te kiezen.' }
  const player = getPlayer(room, playerId)
  const toeper = getPlayer(room, room.game.toeperId)
  if (!player || !toeper) return { error: 'Speler niet gevonden.' }

  if (choice === 'pass') {
    player.passed = true
    player.inRound = false
    player.score += room.game.currentStake
    log(room, `${player.name} past en krijgt ${room.game.currentStake} strafpunt(en).`)
  } else if (choice === 'agree') {
    log(room, `${player.name} gaat mee.`)
  } else {
    return { error: 'Ongeldige keuze.' }
  }

  room.game.bettingIndex += 1
  const remaining = room.game.bettingOrder.slice(room.game.bettingIndex).filter((id) => {
    const p = getPlayer(room, id)
    return p && p.score < room.settings.maxPoints
  })
  if (remaining.length > 0) {
    room.game.currentTurnId = remaining[0]
    broadcastRoom(room)
    return { ok: true }
  }

  room.game.isBetting = false
  room.game.bettingOrder = []
  room.game.bettingIndex = 0
  const activePlayers = room.players.filter((p) => p.inRound && !p.passed && p.score < room.settings.maxPoints)
  if (activePlayers.length === 1) {
    finishRound(room, activePlayers[0].id, true)
    broadcastRoom(room)
    return { ok: true }
  }

  room.game.currentTurnId = toeper.id
  broadcastRoom(room)
  return { ok: true }
}

function swapCard(room, playerId) {
  if (room.phase !== 'preplay') return { error: 'Niet mogelijk na de start.' }
  const player = getPlayer(room, playerId)
  if (!player || !player.eligibleSwap || player.swapped) return { error: 'Geen wissel beschikbaar.' }
  const rankCounts = RANKS.map((rank) => player.hand.filter((card) => card.rank === rank).length)
  const targetRank = RANKS.find((rank, idx) => rankCounts[idx] === 3)
  if (!targetRank || room.game.drawPile.length === 0) return { error: 'Ongeldige hand of stapel leeg.' }
  const oddCard = player.hand.find((card) => card.rank !== targetRank)
  if (!oddCard) return { error: 'Geen afwijkende kaart gevonden.' }

  const newCard = room.game.drawPile.pop()
  const swapIndex = player.hand.findIndex((card) => card.suit === oddCard.suit && card.rank === oddCard.rank)
  player.hand[swapIndex] = newCard
  player.swapped = true
  log(room, `${player.name} wisselt één afwijkende kaart uit.`)
  broadcastRoom(room)
  return { ok: true }
}

function broadcastEffect(room, effect) {
  room.players.forEach((player) => {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      send(player.ws, { type: 'effect', payload: { id: makeId(), ...effect } })
    }
  })
}

function grantNewHand(room, player) {
  if (room.game.drawPile.length < 4) {
    log(room, 'Stapel is leeg — geen nieuwe kaarten meer beschikbaar.')
    return false
  }
  const newCards = []
  for (let i = 0; i < 4; i += 1) newCards.push(room.game.drawPile.pop())
  player.hand = newCards
  player.dirtyWashUsed = true
  return true
}

// Een speler claimt vuile was (mag bluffen). Anderen mogen controleren.
function claimWash(room, playerId) {
  if (room.phase !== 'preplay') return { error: 'Vuile was kan alleen vóór de ronde.' }
  if (!room.settings.houseDirtyWash) return { error: 'Vuile was staat uit in deze kamer.' }
  if (room.game.washClaim) return { error: 'Er loopt al een vuile-was-controle.' }
  const player = getPlayer(room, playerId)
  if (!player || player.score >= room.settings.maxPoints) return { error: 'Je kunt nu niet claimen.' }
  if (player.washResolved) return { error: 'Je hebt je vuile was al gehad deze ronde.' }

  const responders = room.players
    .filter((p) => p.id !== playerId && p.score < room.settings.maxPoints)
    .map((p) => p.id)

  if (responders.length === 0) {
    grantNewHand(room, player)
    player.washResolved = true
    log(room, `${player.name} claimt vuile was en krijgt nieuwe kaarten.`)
    broadcastRoom(room)
    return { ok: true }
  }

  room.game.washClaim = { claimerId: playerId, responders, index: 0 }
  log(room, `${player.name} claimt vuile was. Wie controleert?`)
  broadcastRoom(room)
  return { ok: true }
}

function respondWash(room, playerId, choice) {
  const wc = room.game.washClaim
  if (!wc) return { error: 'Er is geen vuile-was-controle.' }
  if (wc.responders[wc.index] !== playerId) return { error: 'Het is niet jouw beurt om te reageren.' }
  const claimer = getPlayer(room, wc.claimerId)
  const responder = getPlayer(room, playerId)
  if (!claimer || !responder) return { error: 'Speler niet gevonden.' }

  if (choice === 'check') {
    const truth = isVuileWasHand(claimer.hand)
    if (truth) {
      responder.score += 1
      grantNewHand(room, claimer)
      log(room, `${responder.name} controleert — het wás vuile was! ${responder.name} +1 strafpunt, ${claimer.name} krijgt nieuwe kaarten.`)
    } else {
      claimer.score += 1
      log(room, `${responder.name} controleert — bluf! ${claimer.name} speelt met deze kaarten en krijgt +1 strafpunt.`)
    }
    claimer.washResolved = true
    room.game.washClaim = null
    broadcastRoom(room)
    return { ok: true }
  }

  if (choice === 'believe') {
    wc.index += 1
    if (wc.index >= wc.responders.length) {
      grantNewHand(room, claimer)
      claimer.washResolved = true
      room.game.washClaim = null
      log(room, `Iedereen gelooft ${claimer.name} — nieuwe kaarten, geen controle.`)
    } else {
      log(room, `${responder.name} gelooft het.`)
    }
    broadcastRoom(room)
    return { ok: true }
  }

  return { error: 'Ongeldige keuze.' }
}

function fluiten(room, playerId) {
  const player = getPlayer(room, playerId)
  if (!player) return { error: 'Speler niet gevonden.' }
  if (countRank(player.hand, '10') !== 3) return { error: 'Je hebt geen drie tienen.' }
  log(room, `${player.name} fluit! 🤫`)
  broadcastEffect(room, { kind: 'fluiten', name: player.name })
  return { ok: true }
}

const createHits = new Map() // ip -> { count, windowStart }
function rateLimitCreate(ip) {
  const now = Date.now()
  const windowMs = 60 * 1000
  const max = 10
  const entry = createHits.get(ip)
  if (!entry || now - entry.windowStart > windowMs) {
    createHits.set(ip, { count: 1, windowStart: now })
    return true
  }
  entry.count += 1
  return entry.count <= max
}

app.post('/api/create', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'onbekend'
  if (!rateLimitCreate(ip)) {
    return res.status(429).json({ error: 'Te veel kamers achter elkaar. Probeer het zo opnieuw.' })
  }
  if (rooms.size >= MAX_ROOMS) {
    return res.status(503).json({ error: 'De server zit vol. Probeer het later opnieuw.' })
  }
  const name = sanitizeName(req.body.name)
  if (!name) return res.status(400).json({ error: 'Vul een naam in.' })
  const settings = req.body.settings || {}
  const { room, player } = createRoom(name, settings)
  res.json({ code: room.code, playerId: player.id, host: true, joinLink: `${req.protocol}://${req.get('host')}?room=${room.code}` })
})

app.post('/api/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase()
  const name = sanitizeName(req.body.name)
  const playerId = String(req.body.playerId || '').trim()
  const room = getRoom(code)
  if (!room) return res.status(404).json({ error: 'Kamer niet gevonden.' })
  if (room.players.length >= MAX_PLAYERS && !getPlayer(room, playerId)) {
    return res.status(400).json({ error: 'De kamer is vol.' })
  }
  if (!name) return res.status(400).json({ error: 'Vul een naam in.' })

  let player = getPlayer(room, playerId)
  if (!player) {
    player = createPlayer(name)
    room.players.push(player)
    log(room, `${player.name} komt binnen.`)
  } else {
    player.name = name
    player.connected = true
  }

  res.json({ code: room.code, playerId: player.id, host: room.hostId === player.id, joinLink: `${req.protocol}://${req.get('host')}?room=${room.code}` })
  broadcastRoom(room)
})

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code)
  if (!room) return res.status(404).json({ error: 'Kamer niet gevonden.' })
  res.json({ code: room.code, players: room.players.map((player) => ({ id: player.id, name: player.name, score: player.score })), settings: room.settings, phase: room.phase })
})

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'))
})

wss.on('connection', (ws, req) => {
  // Optionele origin-allowlist (zet ALLOWED_ORIGINS in productie achter HTTPS).
  if (ALLOWED_ORIGINS.length > 0) {
    const origin = req.headers.origin
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      try { ws.close(1008, 'Origin niet toegestaan') } catch (e) {}
      return
    }
  }

  let attached = null

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)
      const { type, payload } = data
      if (type === 'join') {
        const { code, playerId } = payload
        const room = getRoom(String(code || '').trim().toUpperCase())
        if (!room) return send(ws, { type: 'error', message: 'Kamer niet gevonden.' })
        const player = getPlayer(room, String(playerId || '').trim())
        if (!player) return send(ws, { type: 'error', message: 'Iemand met deze speler-ID bestaat niet in de kamer.' })
        if (player.ws && player.ws !== ws) {
          try { player.ws.close() } catch (e) {}
        }
        player.ws = ws
        player.connected = true
        attached = { room, player }
        setHostIfNeeded(room)
        log(room, `${player.name} is verbonden.`)
        broadcastRoom(room)
        return
      }

      if (!attached) return send(ws, { type: 'error', message: 'Eerst verbinden met een kamer.' })
      const { room, player } = attached
      if (type === 'startGame') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'Alleen de host kan starten.' })
        if (room.players.filter((p) => p.score < room.settings.maxPoints).length < 2) {
          return send(ws, { type: 'error', message: 'Minimaal twee spelers nodig om te starten.' })
        }
        startRound(room)
        broadcastRoom(room)
        return
      }
      if (type === 'chat') {
        pushChat(room, player, payload && payload.text)
        broadcastRoom(room)
        return
      }
      if (type === 'beginRound') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'Alleen de host kan de ronde starten.' })
        const result = beginPlay(room)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'playCard') {
        const result = playCard(room, player.id, payload.card)
        if (result && result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'toep') {
        const result = beginBetting(room, player.id)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'betChoice') {
        const result = processBet(room, player.id, payload.choice)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'swapCard') {
        const result = swapCard(room, player.id)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'claimWash') {
        const result = claimWash(room, player.id)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'washRespond') {
        const result = respondWash(room, player.id, payload && payload.choice)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'fluiten') {
        const result = fluiten(room, player.id)
        if (result.error) return send(ws, { type: 'error', message: result.error })
        return
      }
      if (type === 'nextRound') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'Alleen de host kan de volgende ronde starten.' })
        if (room.phase === 'game-over') return send(ws, { type: 'error', message: 'Het spel is afgelopen.' })
        startRound(room)
        broadcastRoom(room)
        return
      }
      if (type === 'revanche') {
        if (player.id !== room.hostId) return send(ws, { type: 'error', message: 'Alleen de host kan een revanche beginnen.' })
        room.players.forEach((p) => {
          p.score = 0
          p.inRound = true
          p.passed = false
          p.swapped = false
          p.dirtyWashUsed = false
          p.washResolved = false
        })
        room.phase = 'lobby'
        room.roundNumber = 0
        room.game = { dealerIndex: 0, currentTurnId: null, leadSuit: null, currentStake: 1, isBetting: false, toeperId: null, bettingOrder: [], bettingIndex: 0, trick: [], finishedTricks: [], drawPile: [], washClaim: null }
        log(room, 'Revanche gestart. Iedereen begint opnieuw bij 0 strafpunten.')
        broadcastRoom(room)
        return
      }
    } catch (err) {
      send(ws, { type: 'error', message: 'Kon bericht niet verwerken.' })
    }
  })

  ws.on('close', () => {
    if (attached) {
      attached.player.connected = false
      attached.player.ws = null
      log(attached.room, `${attached.player.name} is verbroken.`)
      setHostIfNeeded(attached.room)
      broadcastRoom(attached.room)
    }
  })
})

// Ruim inactieve rooms en oude rate-limit-entries periodiek op.
setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    const hasConnected = room.players.some((p) => p.ws && p.ws.readyState === WebSocket.OPEN)
    if (!hasConnected && now - (room.lastActivity || room.createdAt) > ROOM_TTL_MS) {
      rooms.delete(code)
    }
  }
  for (const [ip, entry] of createHits) {
    if (now - entry.windowStart > 5 * 60 * 1000) createHits.delete(ip)
  }
}, 10 * 60 * 1000).unref()

const port = process.env.PORT || 4173
server.listen(port, () => {
  console.log(`Toepen-server draait op http://localhost:${port}`)
})
