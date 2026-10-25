# Turni di casa

App web per gestire i turni di casa tra Giulia, Ellen e Claudia.

## Pulizie
- Due compiti a settimana: **Bagno** e **Cucina & corridoio**; la terza persona è libera.
- Ogni turno dura una settimana, da martedì a lunedì, dal 27 ottobre fino a fine dicembre 2026.
- Prima settimana: Giulia bagno, Claudia cucina & corridoio, Ellen libera. Poi si ruota:
  chi era libera fa il bagno, chi ha fatto il bagno fa la cucina, chi ha fatto la cucina riposa.
- Richieste di scambio: scegli un tuo turno e un turno di un'altra da prendere in cambio.
  La destinataria accetta o rifiuta; se accetta, il calendario si aggiorna da solo.
- Ognuna può segnare il proprio turno come fatto.

## Sveglia
- Calendario mensile con gli orari di sveglia di tutte e tre, ognuna con il suo colore.
- Tocca un giorno per vedere chi si sveglia a che ora e impostare il tuo orario.
- Puoi ripetere l'orario: solo quel giorno, lo stesso giorno della settimana per 8 settimane, oppure fino al venerdì.
- Quando qualcuna salva o cambia l'orario, le altre ricevono una notifica sul telefono.
- In grassetto chi si sveglia per prima, ma solo quando un'altra si sveglia entro un'ora da lei.

### Attivare le notifiche
Ognuna apre l'app sul proprio telefono, va su **Sveglia** e tocca **Attiva notifiche**.
- **Android / computer**: funziona direttamente da Chrome, Firefox o Edge.
- **iPhone** (iOS 16.4 o successivo): prima bisogna aprire il sito in Safari, toccare Condividi →
  "Aggiungi alla schermata Home", e poi aprire l'app dall'icona. Solo così iOS consente le notifiche.

Le chiavi per le notifiche vengono create da sole al primo avvio e salvate nel database.
Facoltativo ma consigliato: in Railway aggiungi la variabile `VAPID_SUBJECT` con la tua email,
nel formato `mailto:nome@esempio.it` (Apple a volte rifiuta l'indirizzo di default).

## Spesa
- Lista condivisa: si scrive cosa manca (con la quantità, se serve) e compare a tutte.
- Al supermercato si spunta ciò che si è preso; la voce passa in "Già preso" con il nome di chi l'ha preso.
- "Svuota già presi" pulisce la lista. Se si riaggiunge qualcosa già preso in passato, torna semplicemente in lista.
- L'app si aggiorna da sola ogni 15 secondi, così vedi le aggiunte delle altre mentre sei al supermercato.

All'apertura l'app chiede "Chi sei?" e se lo ricorda su quel telefono.

## Deploy su Railway
1. Crea un repository su GitHub e carica questi file:
   ```bash
   git init && git add . && git commit -m "Turni di casa"
   git branch -M main
   git remote add origin https://github.com/TUO-UTENTE/turni-casa.git
   git push -u origin main
   ```
2. Su [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** e scegli il repository.
3. Nello stesso progetto: **+ New → Database → PostgreSQL**.
4. Apri il servizio dell'app → **Variables** → aggiungi `DATABASE_URL` con valore `${{Postgres.DATABASE_URL}}`.
5. **Settings → Networking → Generate Domain** per avere il link da condividere.

Al primo avvio l'app crea le tabelle e genera il calendario. Ogni `git push` ripubblica l'app senza toccare i dati.

## Modificare i turni di base
Persone, compiti, date e rotazione sono in cima a `server.js`. Il calendario viene generato
solo se il database è vuoto: per rigenerarlo, svuota le tabelle dal pannello del database su Railway
(`DROP TABLE swap_requests; DROP TABLE shifts;`, senza toccare la tabella `settings`, altrimenti le notifiche vanno riattivate) e riavvia il servizio.

## In locale
```bash
npm install
DATABASE_URL=postgres://utente:password@localhost:5432/turni npm start
```
Poi apri http://localhost:3000
