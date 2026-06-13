import { useEffect, useMemo, useRef, useState } from 'react'

const SUIT_ICONS = { harten: '♥', ruiten: '♦', klaveren: '♣', schoppen: '♠' }
const SUIT_NAMES = { harten: 'Harten', ruiten: 'Ruiten', klaveren: 'Klaveren', schoppen: 'Schoppen' }
const RED_SUITS = new Set(['harten', 'ruiten'])
const RANK_NAMES = { '10': '10', '9': '9', '8': '8', '7': '7', A: 'Aas', H: 'Koning', V: 'Vrouw', B: 'Boer' }
// Weergave op de kaart: Boer=J, Vrouw=Q, Heer=K.
const RANK_DISPLAY = { '10': '10', '9': '9', '8': '8', '7': '7', A: 'A', H: 'K', V: 'Q', B: 'J' }
const FACE_RANKS = ['B', 'V', 'H'] // plaatjes
const ROOM_STORAGE = 'toepen-player'
const STATUS_LABEL = { mee: '✓ mee', wacht: 'kiest…', toept: 'toept!', uit: 'gepast' }

function messageColor(text) {
  if (text.includes('toept') || text.includes('Toept')) return 'var(--accent)'
  if (text.includes('wint')) return 'var(--success)'
  return 'var(--text)'
}

// Gestileerde "plaatjes" voor Boer (J), Vrouw (Q) en Heer (K). Kleur volgt de suit.
function FaceFigure({ rank }) {
  if (rank === 'H') {
    return (
      <svg className="pc-figure" viewBox="0 0 100 100" aria-hidden="true">
        <rect x="46" y="6" width="8" height="16" rx="2" />
        <rect x="39" y="11" width="22" height="6" rx="2" />
        <polygon points="18,78 18,38 34,54 50,26 66,54 82,38 82,78" />
        <circle cx="18" cy="36" r="5" /><circle cx="50" cy="24" r="5" /><circle cx="82" cy="36" r="5" />
        <rect x="16" y="74" width="68" height="9" rx="2" />
      </svg>
    )
  }
  if (rank === 'V') {
    return (
      <svg className="pc-figure" viewBox="0 0 100 100" aria-hidden="true">
        <polygon points="23,77 23,45 38,57 50,33 62,57 77,45 77,77" />
        <circle cx="23" cy="43" r="5" /><circle cx="50" cy="31" r="6" /><circle cx="77" cy="43" r="5" />
        <circle cx="50" cy="61" r="5" />
        <rect x="21" y="74" width="58" height="8" rx="2" />
      </svg>
    )
  }
  // Boer (J): fleur-de-lis
  return (
    <svg className="pc-figure" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 10 C61 33 83 35 66 57 C87 49 84 83 50 67 C16 83 13 49 34 57 C17 35 39 33 50 10 Z" />
      <rect x="30" y="64" width="40" height="8" rx="4" />
    </svg>
  )
}

function CardFace({ card, size = 'md' }) {
  const red = RED_SUITS.has(card.suit)
  const isFace = FACE_RANKS.includes(card.rank)
  const display = RANK_DISPLAY[card.rank]
  return (
    <span className={`playing-card ${size} ${red ? 'red' : 'black'} ${isFace ? 'face' : ''}`} aria-label={`${RANK_NAMES[card.rank]} ${SUIT_NAMES[card.suit]}`}>
      <span className="pc-corner pc-top">
        <span className="pc-rank">{display}</span>
        <span className="pc-suit">{SUIT_ICONS[card.suit]}</span>
      </span>
      {isFace ? <FaceFigure rank={card.rank} /> : <span className="pc-pip">{SUIT_ICONS[card.suit]}</span>}
      <span className="pc-corner pc-bottom" aria-hidden="true">
        <span className="pc-rank">{display}</span>
        <span className="pc-suit">{SUIT_ICONS[card.suit]}</span>
      </span>
    </span>
  )
}

function App() {
  const [connected, setConnected] = useState(false)
  const [roomState, setRoomState] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [playerId, setPlayerId] = useState('')
  const [joinLink, setJoinLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [effect, setEffect] = useState(null)
  const [, setNowTick] = useState(0)
  const wsRef = useRef(null)
  const chatEndRef = useRef(null)
  const reconnectRef = useRef(null)
  const effectTimerRef = useRef(null)
  const closingRef = useRef(false)
  const credsRef = useRef({ code: '', id: '' })
  const [settings, setSettings] = useState({ maxPoints: 15, houseSwap: false, houseDirtyWash: true })

  useEffect(() => {
    const stored = window.localStorage.getItem(ROOM_STORAGE)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        setName(parsed.name || '')
        setPlayerId(parsed.playerId || '')
        setJoinCode(parsed.code || '')
      } catch (err) {}
    }
    const query = new URLSearchParams(window.location.search)
    const room = query.get('room')
    if (room) setJoinCode(room.toUpperCase())
    return () => {
      closingRef.current = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) {
        try { wsRef.current.close() } catch (e) {}
      }
    }
  }, [])

  useEffect(() => {
    if (playerId && joinCode) connectSocket(joinCode, playerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerId, joinCode])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [roomState?.chat?.length])

  // Laat de vuile-was-afteller elke halve seconde aftikken.
  useEffect(() => {
    if (!roomState?.washClaim?.deadline) return
    const t = setInterval(() => setNowTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [roomState?.washClaim?.deadline])

  function savePlayer(code, id) {
    setPlayerId(id)
    setJoinCode(code)
    window.localStorage.setItem(ROOM_STORAGE, JSON.stringify({ name, playerId: id, code }))
  }

  function connectSocket(code, id) {
    if (!code || !id) return
    credsRef.current = { code, id }
    closingRef.current = false
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    if (wsRef.current) {
      try { wsRef.current.close() } catch (e) {}
    }
    const socket = new WebSocket(`${window.location.origin.replace(/^http/, 'ws')}/ws`)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'join', payload: { code, playerId: id } }))
      setConnected(true)
      setError(null)
    })
    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'superseded') {
          // Deze sessie is elders overgenomen. Alleen pauzeren als dit nog onze
          // actuele socket is (niet bij ons eigen socket-vervangen).
          if (wsRef.current === socket) {
            closingRef.current = true
            if (reconnectRef.current) clearTimeout(reconnectRef.current)
            setError('Deze kamer is in een ander venster/apparaat geopend; deze sessie is gepauzeerd. Ververs om hier verder te gaan.')
          }
          return
        }
        if (data.type === 'state') setRoomState(data.payload)
        if (data.type === 'error') setError(data.message)
        if (data.type === 'effect') showEffect(data.payload)
        if (data.type === 'kicked') {
          closingRef.current = true
          if (reconnectRef.current) clearTimeout(reconnectRef.current)
          window.localStorage.removeItem(ROOM_STORAGE)
          setRoomState(null)
          setPlayerId('')
          setJoinCode('')
          setJoinLink('')
          setError('Je bent door de host uit de kamer verwijderd.')
          try { socket.close() } catch (e) {}
        }
      } catch (e) {}
    })
    socket.addEventListener('close', () => {
      // Alleen de actuele socket mag een reconnect plannen. Een socket die we
      // zelf hebben vervangen (wsRef wijst al naar een nieuwe) negeert z'n close,
      // anders ontstaat een reconnect-lus die elkaar steeds wegsluit.
      if (wsRef.current !== socket) return
      setConnected(false)
      if (closingRef.current) return
      const { code: c, id: i } = credsRef.current
      if (c && i) {
        reconnectRef.current = setTimeout(() => connectSocket(c, i), 1500)
      }
    })
    socket.addEventListener('error', () => {
      if (wsRef.current !== socket) return
      setError('Verbinding kwijt, opnieuw verbinden…')
    })
    wsRef.current = socket
  }

  async function callApi(path, body) {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Er ging iets mis.')
      return data
    } catch (err) {
      setError(err.message)
      return null
    } finally {
      setLoading(false)
    }
  }

  function handleCreate() {
    if (!name.trim()) return setError('Vul eerst je naam in.')
    callApi('/api/create', { name, settings }).then((data) => {
      if (!data) return
      savePlayer(data.code, data.playerId)
      setJoinLink(data.joinLink)
    })
  }

  function handleJoin() {
    if (!name.trim() || !joinCode.trim()) return setError('Vul naam en kamercode in.')
    callApi('/api/join', { name, code: joinCode.trim().toUpperCase(), playerId }).then((data) => {
      if (!data) return
      savePlayer(data.code, data.playerId)
      setJoinLink(data.joinLink)
    })
  }

  function sendAction(type, payload = {}) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return setError('Even geduld, verbinding wordt hersteld…')
    }
    wsRef.current.send(JSON.stringify({ type, payload }))
  }

  function sendChat(event) {
    if (event) event.preventDefault()
    const text = chatInput.trim()
    if (!text) return
    sendAction('chat', { text })
    setChatInput('')
  }

  function showEffect(payload) {
    setEffect(payload)
    if (effectTimerRef.current) clearTimeout(effectTimerRef.current)
    effectTimerRef.current = setTimeout(() => setEffect(null), 2000)
  }

  function restartGame() {
    if (window.confirm('Het spel nu opnieuw starten? Alle scores gaan terug naar 0.')) {
      sendAction('restartGame')
    }
  }

  function leaveRoom() {
    closingRef.current = true
    if (reconnectRef.current) clearTimeout(reconnectRef.current)
    if (wsRef.current) {
      try { wsRef.current.close() } catch (e) {}
    }
    window.localStorage.removeItem(ROOM_STORAGE)
    setRoomState(null)
    setPlayerId('')
    setJoinCode('')
    setJoinLink('')
  }

  const statusText = roomState
    ? `Kamer ${roomState.code} · Ronde ${roomState.roundNumber} · Inzet ${roomState.currentStake}`
    : 'Voer een naam in en maak een kamer of join met een roomcode.'

  const sortedHand = useMemo(() => {
    if (!roomState?.yourHand) return []
    return [...roomState.yourHand].sort((a, b) => {
      if (a.suit !== b.suit) return a.suit.localeCompare(b.suit)
      return b.order - a.order
    })
  }, [roomState?.yourHand])

  const playerList = roomState?.players || []
  const currentPlayer = playerList.find((p) => p.id === roomState?.currentTurnId)

  function copyLink() {
    const link = joinLink || window.location.href
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const visibleTrick = roomState?.trick || []
  const finishedTricks = roomState?.finishedTricks || []
  const isHost = roomState && roomState.hostId === roomState.yourId
  const hasLeadInHand = roomState?.leadSuit && sortedHand.some((c) => c.suit === roomState.leadSuit)
  const isYourTurn = roomState && roomState.currentTurnId === roomState.yourId
  const washSecondsLeft = roomState?.washClaim?.deadline
    ? Math.max(0, Math.ceil((roomState.washClaim.deadline - Date.now()) / 1000))
    : null

  let turnBanner = null
  if (roomState) {
    if (roomState.phase === 'preplay') {
      turnBanner = roomState.washClaim
        ? { mine: roomState.washRespond, text: `${roomState.washClaim.claimerName} claimt vuile was — nog ${washSecondsLeft ?? 10}s` }
        : { mine: false, text: 'Vóór de ronde — claim eventueel vuile was. Host start de ronde.' }
    } else if (roomState.phase === 'playing') {
      if (roomState.betting) {
        turnBanner = { mine: true, text: '✋ Jouw keuze: meegaan of passen?' }
      } else if (roomState.bettingChoiceAvailable) {
        turnBanner = { mine: false, text: `${currentPlayer?.name || 'Iemand'} kiest: meegaan of passen…` }
      } else if (isYourTurn) {
        turnBanner = { mine: true, text: '🎯 Jouw beurt — speel een kaart' }
      } else {
        turnBanner = { mine: false, text: `Aan de beurt: ${currentPlayer?.name || 'wachten'}` }
      }
    }
  }

  return (
    <div className="app-shell">
      <header>
        <div className="brand-block">
          <p className="brand">Toepen<span className="brand-suit red">♥</span></p>
          <p className="subtitle">Online multiplayer, zonder account.</p>
        </div>
        <div className="header-actions">
          {roomState && <span className={`conn-dot ${connected ? 'on' : 'off'}`} title={connected ? 'Verbonden' : 'Verbinden…'} />}
          <button className="help-button" onClick={() => setShowRules((value) => !value)}>{showRules ? 'Verberg regels' : 'Regels'}</button>
        </div>
      </header>

      {roomState?.washClaim && washSecondsLeft !== null && (
        <div className={`wash-countdown ${washSecondsLeft <= 3 ? 'urgent' : ''}`}>
          <span className="wash-countdown-num">{washSecondsLeft}</span>
          <div className="wash-countdown-text">
            <strong>{roomState.washClaim.claimerName}</strong> claimt vuile was
            <span>{roomState.washRespond ? 'Controleer of geloof het' : 'Wachten op de controle…'}</span>
          </div>
        </div>
      )}

      {showRules && (
        <section className="card rules">
          <h2>Speluitleg</h2>
          <p>Speel met 2-8 spelers. Je krijgt 4 kaarten en er worden 4 slagen gespeeld. De winnaar van de laatste slag wint de ronde. Je moet kleur bekennen als je dat kunt.</p>
          <p>Iedereen begint op 0. Wie de ronde verliest, krijgt strafpunten gelijk aan de inzet. <strong>Toepen</strong> verhoogt de inzet met 1 (ook over jezelf heen); anderen gaan mee of passen. Wie past, neemt de huidige inzet meteen als strafpunten. Wie eerst aan het maximum komt, ligt eruit.</p>
          <p><strong>Speciale handen:</strong> 4 dezelfde = direct gewonnen. <strong>Vuile was</strong> (4 plaatjes, of 3 plaatjes + een 7 — plaatjes = J/Q/K én Aas) mag je claimen voor nieuwe kaarten; anderen mogen controleren. Klopt het → de controleur krijgt een strafpunt; was het bluf → jij speelt je kaarten en krijgt een strafpunt.</p>
          <p><strong>Gimmicks:</strong> 4×10 = "op tafel". 3×10 = fluiten (🤫). Ligt er in de beslissende (laatste) slag een <strong>boer (J)</strong> — door wie dan ook gespeeld — dan zijn de strafpunten dubbel.</p>
        </section>
      )}

      <main>
        {!roomState && (
          <section className="card lobby">
            <h2>Speel mee</h2>
            <label>
              Je naam
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Bijv. Sanne" maxLength={20} />
            </label>
            <label>
              Max strafpunten
              <select value={settings.maxPoints} onChange={(event) => setSettings((prev) => ({ ...prev, maxPoints: Number(event.target.value) }))}>
                <option value={10}>10</option>
                <option value={15}>15</option>
              </select>
            </label>
            <div className="toggles">
              <label><input type="checkbox" checked={settings.houseDirtyWash} onChange={(event) => setSettings((prev) => ({ ...prev, houseDirtyWash: event.target.checked }))} /> Vuile was (4 plaatjes, of 3 + een 7; plaatjes = J/Q/K en Aas) — claimen &amp; controleren</label>
              <label><input type="checkbox" checked={settings.houseSwap} onChange={(event) => setSettings((prev) => ({ ...prev, houseSwap: event.target.checked }))} /> 3 gelijk + 1 afwijkend: verwissel één kaart</label>
              <p className="toggle-note">Vast: 4 dezelfde = direct gewonnen · 4×10 = op tafel · 3×10 = fluiten · boer in de laatste slag = dubbel.</p>
            </div>
            <button onClick={handleCreate} disabled={loading}>Maak kamer</button>
            <div className="divider">of</div>
            <label>
              Kamercode
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} placeholder="AAAA" maxLength={4} inputMode="text" autoCapitalize="characters" />
            </label>
            <button onClick={handleJoin} disabled={loading}>Doe mee met code</button>
          </section>
        )}

        {roomState && (
          <section className="card game-room">
            <div className="room-header">
              <div>
                <h2>Kamer {roomState.code}</h2>
                <p>{statusText}</p>
              </div>
              <div className="room-header-actions">
                {isHost && ['preplay', 'playing', 'round-end'].includes(roomState.phase) && (
                  <button className="ghost danger" onClick={restartGame}>↻ Opnieuw</button>
                )}
                <button className="ghost" onClick={copyLink}>{copied ? 'Gekopieerd ✓' : 'Kopieer link'}</button>
                <button className="ghost" onClick={leaveRoom}>Verlaten</button>
              </div>
            </div>

            <div className="players-panel">
              {playerList.map((player) => (
                <div key={player.id} className={`player-card ${player.id === roomState.currentTurnId ? 'active' : ''} ${player.eliminated ? 'eliminated' : ''}`}>
                  <span className="player-name">
                    {player.id === roomState.currentTurnId && <span className="turn-dot" />}
                    {player.name}
                    {!player.connected && <span className="offline">offline</span>}
                  </span>
                  {player.status && <span className={`status-pill s-${player.status}`}>{STATUS_LABEL[player.status]}</span>}
                  <span className="player-info">{player.score} pt</span>
                  {player.id === roomState.hostId && <span className="tag">Host</span>}
                  {isHost && player.id !== roomState.yourId && (
                    <button
                      className="kick-btn"
                      title={`${player.name} verwijderen`}
                      onClick={() => { if (window.confirm(`${player.name} uit de kamer verwijderen?`)) sendAction('kickPlayer', { targetId: player.id }) }}
                    >✕</button>
                  )}
                </div>
              ))}
            </div>

            <div className="table-panel">
              {turnBanner && (
                <div className={`turn-banner ${turnBanner.mine ? 'mine' : ''}`}>{turnBanner.text}</div>
              )}
              <div className="table-status">
                <span className="chip">Beurt: <strong>{currentPlayer?.name || 'Wachten'}</strong></span>
                <span className="chip">Inzet: <strong>{roomState.currentStake}</strong></span>
                {roomState.leadSuit && (
                  <span className="chip">Kleur: <strong className={RED_SUITS.has(roomState.leadSuit) ? 'red' : ''}>{SUIT_NAMES[roomState.leadSuit]} {SUIT_ICONS[roomState.leadSuit]}</strong></span>
                )}
              </div>

              <div className="trick-area">
                {visibleTrick.length === 0 && <p className="muted-note">Nog geen kaarten op tafel.</p>}
                <div className="trick-row">
                  {visibleTrick.map((play) => (
                    <div key={`${play.playerId}-${play.card.rank}-${play.card.suit}`} className="played-card">
                      <CardFace card={play.card} size="sm" />
                      <small>{playerList.find((p) => p.id === play.playerId)?.name}</small>
                    </div>
                  ))}
                </div>
                {finishedTricks.length > 0 && (
                  <div className="trick-history">
                    {finishedTricks.map((trick, index) => {
                      const plays = Array.isArray(trick) ? trick : (trick.plays || [])
                      const winnerId = Array.isArray(trick) ? null : trick.winnerId
                      return (
                        <div key={index} className="finished-trick">
                          <span className="ft-label">Slag {index + 1}</span>
                          <span className="ft-cards">
                            {plays.map((play) => {
                              const pname = playerList.find((p) => p.id === play.playerId)?.name || '?'
                              const won = play.playerId === winnerId
                              return (
                                <span key={`${play.playerId}-${play.card.rank}-${play.card.suit}`} className={`ft-play ${won ? 'won' : ''}`}>
                                  <CardFace card={play.card} size="xs" />
                                  <small>{won ? '🏆 ' : ''}{pname}</small>
                                </span>
                              )
                            })}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              <div className="actions">
                {roomState.phase === 'lobby' && (
                  isHost
                    ? <button onClick={() => sendAction('startGame')} disabled={!roomState.canStart}>{roomState.canStart ? 'Start spel' : 'Wacht op spelers (min. 2)'}</button>
                    : <p className="muted-note">Wachten tot de host start…</p>
                )}

                {roomState.phase === 'preplay' && (
                  <div className="preplay-actions">
                    {roomState.washClaim ? (
                      <div className="wash-claim">
                        <div className="wash-claim-head">
                          <p><strong>{roomState.washClaim.claimerName}</strong> claimt vuile was. Geloof je het, of controleer je?</p>
                          {washSecondsLeft !== null && <span className={`wash-timer ${washSecondsLeft <= 3 ? 'urgent' : ''}`}>⏳ {washSecondsLeft}s</span>}
                        </div>
                        {roomState.washRespond ? (
                          <div className="button-row">
                            <button className="ghost danger" onClick={() => sendAction('washRespond', { choice: 'check' })}>Controleer</button>
                            <button className="secondary" onClick={() => sendAction('washRespond', { choice: 'believe' })}>Geloof het</button>
                          </div>
                        ) : roomState.washClaim.claimerId === roomState.yourId ? (
                          <p className="muted-note">Wachten of iemand controleert…</p>
                        ) : (
                          <p className="muted-note">Iemand anders mag nu controleren…</p>
                        )}
                      </div>
                    ) : (
                      <div className="button-row">
                        {roomState.canSwap && <button className="secondary" onClick={() => sendAction('swapCard')}>Wissel kaart</button>}
                        {roomState.canClaimWash && <button className="secondary" onClick={() => sendAction('claimWash')}>Vuile was claimen</button>}
                        {roomState.canBeginRound && <button onClick={() => sendAction('beginRound')}>Begin de ronde</button>}
                        {!isHost && <p className="muted-note">Claim eventueel vuile was. Host start de ronde.</p>}
                      </div>
                    )}
                  </div>
                )}

                {roomState.phase === 'playing' && (
                  <div className="button-row">
                    <button onClick={() => sendAction('toep')} disabled={!roomState.canToep}>Toepen</button>
                    {roomState.bettingChoiceAvailable && roomState.betting && (
                      <>
                        <button className="secondary" onClick={() => sendAction('betChoice', { choice: 'agree' })}>Meegaan</button>
                        <button className="ghost danger" onClick={() => sendAction('betChoice', { choice: 'pass' })}>Passen</button>
                      </>
                    )}
                  </div>
                )}

                {roomState.phase === 'round-end' && (() => {
                  const youWon = roomState.winnerId === roomState.yourId
                  const winnerName = playerList.find((p) => p.id === roomState.winnerId)?.name || 'de winnaar'
                  return (isHost || youWon)
                    ? <button onClick={() => sendAction('nextRound')}>{youWon ? '🔀 Schudden & volgende ronde' : 'Volgende ronde'}</button>
                    : <p className="muted-note">Ronde klaar. {winnerName} schudt…</p>
                })()}

                {roomState.phase === 'game-over' && (
                  <div className="game-over">
                    <p className="winner-line">🏆 {playerList.find((p) => p.id === roomState.winnerId)?.name || 'Iemand'} wint het spel!</p>
                    {isHost && <button className="secondary" onClick={() => sendAction('revanche')}>Revanche starten</button>}
                  </div>
                )}
              </div>
            </div>

            {roomState.phase !== 'lobby' && (
              <div className="hand-panel">
                <div className="hand-head">
                  <h3>Jouw hand</h3>
                  {roomState.canFluiten && <button className="fluit-btn" onClick={() => sendAction('fluiten')}>Fluiten 🤫</button>}
                </div>
                {hasLeadInHand && roomState.canPlay && <p className="muted-note">Je moet {SUIT_NAMES[roomState.leadSuit]} bekennen.</p>}
                <div className="hand-grid">
                  {sortedHand.length === 0 && <p className="muted-note">Geen kaarten meer.</p>}
                  {sortedHand.map((card) => {
                    const playable = roomState.canPlay && (!hasLeadInHand || card.suit === roomState.leadSuit)
                    return (
                      <button
                        key={`${card.rank}-${card.suit}`}
                        className={`card-button ${playable ? 'playable' : 'disabled'}`}
                        disabled={!playable}
                        onClick={() => sendAction('playCard', { card })}
                      >
                        <CardFace card={card} size="md" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <section className="chat-panel">
              <h3>Chat</h3>
              <div className="chat-list">
                {(roomState.chat || []).length === 0 && <p className="muted-note">Nog geen berichten. Zeg hallo! 👋</p>}
                {(roomState.chat || []).map((msg) => (
                  <div key={msg.id} className={`chat-msg ${msg.playerId === roomState.yourId ? 'mine' : ''}`}>
                    <span className="chat-name">{msg.name}</span>
                    <span className="chat-text">{msg.text}</span>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Typ een bericht…"
                  maxLength={240}
                  aria-label="Chatbericht"
                />
                <button type="submit" className="ghost" disabled={!chatInput.trim()}>Stuur</button>
              </form>
            </section>

            <section className="log-panel">
              <h3>Laatste gebeurtenissen</h3>
              <div className="log-list">
                {roomState.logs.map((entry) => (
                  <div key={entry.id} className="log-item" style={{ color: messageColor(entry.message) }}>
                    {entry.message}
                  </div>
                ))}
              </div>
            </section>
          </section>
        )}

        {error && <div className="toast error" onClick={() => setError(null)}>{error}</div>}
        {loading && <div className="toast">Bezig…</div>}
      </main>

      {effect && (
        <div className={`effect-overlay ${effect.kind}`} aria-live="assertive">
          {effect.kind === 'fluiten' ? (
            <div className="effect-card">
              <div className="effect-icon">🤫</div>
              <p>{effect.name} fluit — even stil!</p>
            </div>
          ) : (
            <div className="effect-card">
              <div className="effect-icon">🍆</div>
              <p>{effect.name}: vier tienen — op tafel!</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default App
