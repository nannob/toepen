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

## Deployen met GitHub Actions

> **Belangrijk:** dit is géén statische site. Er moet een Node-proces blijven draaien
> (Express + WebSocket). Klassieke shared hosting met alleen `public_html` werkt niet —
> je hebt een VPS of een host nodig waar je een Node-app kunt draaien (bijv. via pm2).

De workflow in `.github/workflows/deploy.yml` wordt getriggerd bij een push naar `main`
(of handmatig via *Run workflow*). Hij bouwt de frontend, uploadt `server/`, `dist/` en
de `package*.json` naar `~/toepen` op de server, doet `npm ci --omit=dev` en (her)start
het proces met pm2 onder de naam `toepen`.

Voeg in GitHub repository secrets toe:
- `SSH_HOST` – serveradres (bijv. `toepenmet.nanno.nu`)
- `SSH_USER` – SSH-gebruiker
- `SSH_PASS` – SSH-wachtwoord **of** `SSH_KEY` – private key (laat de ongebruikte leeg)
- `SSH_PORT` – optioneel, standaard `22`
- `APP_PORT` – optioneel, poort waarop Node luistert (standaard `4173`)
- `ALLOWED_ORIGINS` – optioneel, komma-gescheiden lijst van toegestane origins voor de
  WebSocket, bijv. `https://toepenmet.nanno.nu`

### Reverse proxy (nginx) + HTTPS
Zet een reverse proxy voor de Node-app zodat HTTPS en de WebSocket-upgrade werken:

```nginx
server {
  server_name toepenmet.nanno.nu;

  location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Regel daarna een certificaat (bijv. met certbot). Omdat de client `wss://` afleidt uit
`https://`, werkt de WebSocket automatisch zodra de site via HTTPS draait.

## Waar je regels en uiterlijk aanpast
- Speelregels en game state: `server/index.js`
- UI-tekst en knoppen: `client/src/App.jsx`
- Layout, kleuren en kaartweergave: `client/src/styles.css`

## Extra opmerkingen
- Rooms leven in het geheugen van de server; als de server herstart moet je opnieuw beginnen
- Voor productie gebruik je een VPS of host met vaste URL
- Elke speler verbindt via de businessroomlink of roomcode
