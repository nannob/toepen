# Toepen

Een Nederlandse online multiplayer versie van het kaartspel Toepen.

## Wat deze app doet
- Room-based online multiplayer met eigen kamerlink en 4-letter roomcode
- Geen account nodig: alleen je naam en je browser
- Privé handen: alleen jij ziet jouw 4 kaarten
- Realtime gedeelde tafelstatus met scores, slag, inzet en turn
- Toepen, passen, meen en ronde-einde in de standaardregels
- Compacte mobiele UI met toetsenbord/vindbaarheid

## Projectstructuur
- `server/index.js` bevat de server, room management en spelregels
- `client/src/App.jsx` bevat de React frontend en realtime UI
- `client/src/styles.css` bevat de mobiele styling
- `vite.config.mjs` configureert de frontend build
- `.github/workflows/deploy.yml` bevat de deploy pipeline

## Lokale installatie
1. Open een terminal in de projectmap
2. `npm install`
3. `npm run build`
4. `npm start`
5. Open `http://localhost:4173`

## Ontwikkeling
- `npm run dev` start de Vite devserver voor snelle frontend-ontwikkelwerkzaamheden
- `npm run start` start de Express server met WebSocket backend

## Deployen naar de VPS met GitHub Actions

> **Belangrijk:** dit is géén statische site. Er moet een Node-proces blijven draaien
> (Express + WebSocket). De app draait daarom op een VPS, niet op static/FTP-hosting.

De workflow in `.github/workflows/deploy.yml` draait bij een push naar `main` (of handmatig
via *Run workflow*). Host en user staan hardcoded (`159.69.211.153`, `root`). De workflow:

1. bouwt de frontend (`dist/`),
2. uploadt `server/`, `dist/` en `package*.json` naar `/opt/toepen` op de VPS,
3. installeert (alleen de eerste keer) Node 20, pm2 en nginx,
4. zet een nginx reverse proxy op poort 80 → Node op `127.0.0.1:4173` (met WebSocket-upgrade),
5. (her)start de app met pm2 onder de naam `toepen`.

### Benodigde GitHub secret
- `SSH_PASS` – het root-wachtwoord van de VPS. (Verplicht.)
- `ALLOWED_ORIGINS` – optioneel; komma-gescheiden origin-allowlist voor de WebSocket,
  bijv. `https://toepenmet.nanno.nu`.

Zet deze onder **Settings → Secrets and variables → Actions**, push naar `main`, en de
eerste run richt de hele server in.

### Domein + HTTPS
1. Wijs in je DNS een **A-record** van `toepenmet.nanno.nu` naar `159.69.211.153`.
2. Regel daarna eenmalig een TLS-certificaat op de VPS:
   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d toepenmet.nanno.nu
   ```
   Omdat de client `wss://` afleidt uit `https://`, werkt de WebSocket daarna automatisch.
3. Optioneel: zet `ALLOWED_ORIGINS=https://toepenmet.nanno.nu` als secret voor strakkere
   WebSocket-beveiliging.

### Firewall
Open de benodigde poorten op de VPS:
```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## Waar je regels en uiterlijk aanpast
- Speelregels en game state: `server/index.js`
- UI-tekst en knoppen: `client/src/App.jsx`
- Layout, kleuren en kaartweergave: `client/src/styles.css`

## Extra opmerkingen
- Rooms leven in het geheugen van de server; als de server herstart moet je opnieuw beginnen
- Voor productie gebruik je een VPS of host met vaste URL
- Elke speler verbindt via de businessroomlink of roomcode
