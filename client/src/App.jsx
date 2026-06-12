import { useEffect, useMemo, useRef, useState } from 'react'

const SUIT_ICONS = { harten: '♥', ruiten: '♦', klaveren: '♣', schoppen: '♠' }
const SUIT_NAMES = { harten: 'Harten', ruiten: 'Ruiten', klaveren: 'Klaveren', schoppen: 'Schoppen' }
const RED_SUITS = new Set(['harten', 'ruiten'])
const RANK_NAMES = { '10': '10', '9': '9', '8': '8', '7': '7', A: 'Aas', H: 'Heer', V: 'Vrouw', B: 'Boer' }
const ROOM_STORAGE = 'toepen-player'

function messageColor(text) {
  if (text.includes('toept') || text.includes('Toept')) return 'var(--accent)'
  if (text.includes('wint')) return 'var(--success)'
  return 'var(--text)'
}

function CardFace({ card, size = 'md' }) {
  const red = RED_SUITS.has(card.suit)
  return (
    <span className={`playing-card ${size} ${red ? 'red' : 'black'}`} aria-label={`${RANK_NAMES[card.rank]} ${SUIT_NAMES[card.suit]}`}>
      <span className="pc-corner pc-top">
        <span className="pc-rank">{card.rank}</span>
        <span className="pc-suit">{SUIT_ICONS[card.suit]}</span>
      </span>
      <span className="pc-pip">{SUIT_ICONS[card.suit]}</span>
      <span className="pc-corner pc-bottom" aria-hidden="true">
        <span className="pc-rank">{card.rank}</span>
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
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const closingRef = useRef(false)
  const credsRef = useRef({ code: '', id: '' })
  const [settings, setSettings] = useState({ maxPoints: 15, maxStake: 4, houseArmoe: false, houseSwap: false, houseDirtyWash: false })

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
        if (data.type === 'state') setRoomState(data.payload)
        if (data.type === 'error') setError(data.message)
      } catch (e) {}
    })
    socket.addEventListener('close', () => {
      setConnected(false)
      if (closingRef.current) return
      const { code: c, id: i } = credsRef.current
      if (c && i) {
        reconnectRef.current = setTimeout(() => connectSocket(c, i), 1500)
      }
    })
    socket.addEventListener('error', () => setError('Verbinding kwijt, opnieuw verbinden…'))
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

      {showRules && (
        <section className="card rules">
          <h2>Speluitleg</h2>
          <p>Speel met 2-8 spelers. Je krijgt 4 kaarten en er worden 4 slagen gespeeld. De winnaar van de laatste slag wint de ronde.</p>
          <p>Wie de ronde verliest, krijgt strafpunten gelijk aan de inzet. <strong>Toepen</strong> verhoogt de inzet met 1; anderen gaan mee of passen. Wie past, neemt de huidige inzet meteen als strafpunten.</p>
          <p>Je moet kleur bekennen als je dat kunt. Wie eerst aan het ingestelde maximum strafpunten komt, ligt eruit.</p>
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
            <div className="settings-row">
              <label>
                Max strafpunten
                <select value={settings.maxPoints} onChange={(event) => setSettings((prev) => ({ ...prev, maxPoints: Number(event.target.value) }))}>
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                </select>
              </label>
              <label>
                Max inzet
                <select value={settings.maxStake} onChange={(event) => setSettings((prev) => ({ ...prev, maxStake: Number(event.target.value) }))}>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                </select>
              </label>
            </div>
            <div className="toggles">
              <label><input type="checkbox" checked={settings.houseArmoe} onChange={(event) => setSettings((prev) => ({ ...prev, houseArmoe: event.target.checked }))} /> Vier gelijke – direct rondewinst</label>
              <label><input type="checkbox" checked={settings.houseSwap} onChange={(event) => setSettings((prev) => ({ ...prev, houseSwap: event.target.checked }))} /> 3 gelijk + 1 afwijkend: verwissel één kaart</label>
              <label><input type="checkbox" checked={settings.houseDirtyWash} onChange={(event) => setSettings((prev) => ({ ...prev, houseDirtyWash: event.target.checked }))} /> Vuile was: hele hand omruilen</label>
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
                  <span className="player-info">{player.score} pt</span>
                  {player.id === roomState.hostId && <span className="tag">Host</span>}
                </div>
              ))}
            </div>

            <div className="table-panel">
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
                    {finishedTricks.map((trick, index) => (
                      <div key={index} className="finished-trick">
                        <span className="ft-label">Slag {index + 1}</span>
                        <span className="ft-cards">
                          {trick.map((play) => (
                            <CardFace key={`${play.playerId}-${play.card.rank}-${play.card.suit}`} card={play.card} size="xs" />
                          ))}
                        </span>
                      </div>
                    ))}
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
                  <div className="button-row">
                    {roomState.canSwap && <button className="secondary" onClick={() => sendAction('swapCard')}>Wissel kaart</button>}
                    {roomState.canDirtyWash && <button className="secondary" onClick={() => sendAction('dirtyWash')}>Vuile was</button>}
                    {roomState.canBeginRound && <button onClick={() => sendAction('beginRound')}>Begin de ronde</button>}
                    {!roomState.canBeginRound && !roomState.canSwap && !roomState.canDirtyWash && <p className="muted-note">Wachten op huisregel-keuzes…</p>}
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

                {roomState.phase === 'round-end' && (
                  isHost
                    ? <button onClick={() => sendAction('nextRound')}>Volgende ronde</button>
                    : <p className="muted-note">Ronde klaar. Wachten op de host…</p>
                )}

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
                <h3>Jouw hand</h3>
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
    </div>
  )
}

export default App
