# Discord HC Verification Bot

Discord bot za automatski prijem članova, izbor ranka, HC potvrdu i dodelu role.

## Funkcije

- Kandidat klikne dugme na panelu i dobija privatni Discord prozor za prijavu.
- Rank se bira kroz privatni Discord Select Menu, bez slanja DM poruka.
- Nakon izbora ranka otvara se modal za ime, prezime, ID i ime osobe koja ga je ubacila.
- HC dobija prijavu sa dugmadima za odobrenje ili odbijanje.
- Odbijanje podržava opcionalan razlog.
- Odobrenje dodeljuje rank rolu i postavlja nadimak u formatu `Ime Prezime | ID`.
- Aktivne i potvrđene duple prijave sa istim ID-jem se blokiraju.
- Sve odluke se zapisuju u poseban log kanal.
- `/copy-role` kopira dostupne role postavke i channel/category overwrite dozvole nakon potvrde.

## Zahtevi

- Node.js 24
- pnpm
- Discord bot aplikacija sa tokenom

## Pokretanje

1. Instaliraj zavisnosti:

   ```bash
   pnpm install
   ```

2. Kopiraj `.env.example` u `.env` i upiši Discord bot token:

   ```bash
   cp .env.example .env
   ```

   U Replit-u koristi Secret naziva `DISCORD_BOT_TOKEN` umesto `.env` fajla. Stvarni token nikada ne commituj na GitHub.

3. Pokreni server:

   ```bash
   pnpm --filter @workspace/api-server run dev
   ```

Server sluša na vrednosti `PORT` varijable i health endpoint je dostupan na:

```text
/api/healthz
```

## Railway deploy bez terminala

Projekat već sadrži `railway.json` i `railpack.json`, tako da Railway automatski
instalira zavisnosti, builda bot i pokreće ga bez ručnog pokretanja `pnpm`,
`npm` ili drugih komandi.

1. U Railway-u napravi novi projekat iz ovog GitHub repozitorijuma ili zip
   projekta.
2. U **Variables** dodaj `DISCORD_BOT_TOKEN` i nalepi token Discord bot
   aplikacije.
3. Klikni **Deploy**. Railway automatski koristi `PORT` koji dodeli servisu i
   proverava `/api/healthz`.

Runtime je bundlovan u jedan fajl `artifacts/api-server/dist/main.mjs`.
Izvorni bot i HTTP health server dele jedan ulazni fajl
`artifacts/api-server/src/discord-bot.ts`, dok Railway sam izvršava build i
start podešavanja iz konfiguracije.

Nakon prvog pokretanja podešavanje servera se radi Discord slash komandama
navedenim ispod, bez korišćenja terminala.

## Discord bot dozvole

Botu su potrebne sledeće dozvole:

- View Channel
- Send Messages
- Read Message History
- Embed Links
- Manage Roles
- Manage Channels
- Manage Nicknames
- Use Application Commands

Botova najviša rola mora biti iznad svih rank rola koje dodeljuje ili menja. Za `/copy-role` target rola ne sme biti managed/integration rola.

Gateway intents koje bot koristi:

- `Guilds`

Privileged `Guild Members` intent nije potreban.

## Komande

### Objavljivanje panela za prijave

```text
/verification-setup
```

Komanda traži:

- `target_channel` — kanal u koji bot objavljuje panel sa dugmetom
- `hc_channel` — kanal za nove prijave
- `log_channel` — kanal za odluke

Bot automatski objavljuje poruku sa dugmetom **Otvori prijavu**. Klik na
dugme otvara privatni rank meni, a zatim i modal za unos svih podataka.

### Rankovi

```text
/rank-add rank:1 role:@Rank 1
/rank-remove rank:1
/rank-list
```

Rankovi su podržani od 1 do 10.

### HC dozvole

Za izbor više Admin/HC rola odjednom koristi:

```text
/hc-role-setup
```

Administrator kroz Discord role picker može odabrati, na primer, `@Owner`,
`@Head Admin`, `@Admin` i `@HC`. Sve odabrane role mogu potvrditi ili odbiti
prijave, a bot ih sve tagira u poruci nove prijave.

Postoje i komande za pojedinačno dodavanje ili uklanjanje rola:

```text
/hc-role-add role:@HC
/hc-role-remove role:@HC
/hc-role-list
```

Administratori i podešene HC role mogu obrađivati prijave.

### Kopiranje role

```text
/copy-role
```

Korisnik bira:

- `source_role`
- `target_role`

Bot prvo prikazuje izabrane role i gumb `✅ Kopiraj sve`. Kopiranje počinje tek nakon klika.

Kopiraju se:

- permissions
- hoist
- mentionable
- role icon i unicode emoji kada ih Discord API dopušta
- source role Allow/Deny overwrite dozvole na kanalima i kategorijama

Ime i boja Target Role ostaju nepromenjeni.

Ako source nema overwrite na kanalu, postojeći target overwrite se uklanja kako bi postavke ostale usklađene. Hijerarhijska pozicija se ne kopira jer Discord ne može imati dve role na istoj poziciji.

Za ovu komandu bot mora imati `Manage Roles` i `Manage Channels`.

## Stanje prijava

Konfiguracija servera i prijave se čuvaju u:

```text
<RAILWAY_VOLUME_MOUNT_PATH>/verification-state.json
```

Za trajno čuvanje na Railway-u jednom dodaj Volume na bot servis:

1. Otvori Railway projekat i izaberi bot servis.
2. Otvori **Volumes** → **Add Volume**.
3. Kao **Mount Path** upiši `/app/data`.
4. Redeploy servis.

Railway će automatski postaviti `RAILWAY_VOLUME_MOUNT_PATH`, a bot će koristiti
taj Volume za `verification-state.json`. Ne treba dodavati novu promenljivu
ruku niti pokretati komande. Bez Volume-a bot i dalje radi, ali podaci ostaju
na privremenom filesystemu i mogu nestati nakon zamene instance.

## Provere

```bash
pnpm run typecheck
PORT=8081 BASE_PATH=/__mockup pnpm run build
```

`PORT` i `BASE_PATH` su potrebni za build postojećeg komponentnog preview artifacta kada se projekat builda izvan Replit workflowa.

## Struktura

- `artifacts/api-server/src/discord-bot.ts` — Discord komande, eventovi i verification tok
- `artifacts/api-server/src/discord-bot.ts` — Discord bot, Express server i health endpoint
- `artifacts/api-server/src/routes/health.ts` — health endpoint
- `lib/api-spec` i `lib/api-zod` — API specifikacija i generisani tipovi
- `artifacts/mockup-sandbox` — postojeći komponentni preview artifact
- `pnpm-lock.yaml` — zaključane verzije zavisnosti