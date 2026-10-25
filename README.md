# Turni di casa

App web per Giulia, Ellen e Claudia: calendario condiviso con turni di pulizia e orari di sveglia, più la lista della spesa.

## Come funziona
- **Accesso**: ognuna entra con il proprio nome e sceglie un colore. Un colore già scelto da un'altra non si può prendere.
  Il colore si può cambiare in qualsiasi momento dalla scheda "Tu".
- **Calendario** (stile calendario Apple): si apre sulla vista **Settimana**, con l'elenco giorno per giorno;
  con **Mese** si allarga a tutto il mese. In ogni giorno si vedono i turni di pulizia e gli orari di sveglia, con il colore di ognuna.
  Si scorre con le frecce o con il dito.
- **Sveglia**: ognuna segna entro le 23:00 a che ora si sveglia il giorno dopo. Alle 23:00 chi non l'ha ancora fatto riceve un promemoria.
  Quando qualcuna segna o cambia l'orario, le altre ricevono una notifica. In grassetto chi va per prima in bagno,
  quando un'altra si sveglia entro un'ora. L'orario si può ripetere ogni settimana per 4 settimane (es. ogni lunedì)
  oppure su giorni specifici scelti, e si può modificare o eliminare, anche tutta la serie.
- **Pulizie**: Bagno e Cucina & Corridoio, a rotazione tra le tre, dal 27 ottobre a fine dicembre 2026.
  Ogni turno parte fisso il martedì. Di ogni turno si può cambiare la data, il tipo di pulizia e la persona assegnata;
  se si sceglie il tipo o la persona dell'altro turno della settimana, i due turni si scambiano. Le altre ricevono una notifica.
- **Spesa**: lista condivisa da spuntare; toccando una voce si modificano nome e quantità, o la si elimina.

## Deploy su Railway
1. Carica i file su GitHub (la cartella `public` deve esserci con tutti i suoi file).
2. Su [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** e scegli il repository.
3. Nello stesso progetto: **+ New → Database → PostgreSQL**.
4. Nel servizio dell'app → **Variables** → aggiungi `DATABASE_URL` con valore `${{Postgres.DATABASE_URL}}`.
5. **Settings → Networking → Generate Domain** per avere il link.

Facoltativo: `VAPID_SUBJECT` = `mailto:tuaemail@esempio.it` (consigliato per le notifiche su iPhone),
`REMINDER_HOUR` per cambiare l'ora del promemoria (default 23).

## Notifiche
Dalla scheda "Tu" → **Attiva**. Su iPhone (iOS 16.4+) bisogna prima aggiungere il sito alla schermata Home
da Safari (Condividi → "Aggiungi alla schermata Home") e aprire l'app da lì.

## Modificare persone, date e rotazione
Sono in cima a `server.js`. Il calendario dei turni viene generato solo se il database è vuoto.
