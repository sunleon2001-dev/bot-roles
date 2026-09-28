# Discord HC Rank Verification Bot

Discord bot koji prikuplja prijave novih članova, šalje ih HC-u na potvrdu i nakon odobrenja dodeljuje rank rolu i nadimak.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — pokretanje API servera i Discord bota
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_BOT_TOKEN` — Discord bot token

## Railway

- Railway automatically installs dependencies and uses `railway.json` to build
  and start the bot; no manual terminal command is required after import.
- Set only `DISCORD_BOT_TOKEN` in Railway Variables. Railway supplies `PORT`.
- Attach a Railway Volume to `/app/data`; Railway supplies
  `RAILWAY_VOLUME_MOUNT_PATH` automatically so bot settings survive restarts.
- The bundled runtime starts from `artifacts/api-server/dist/main.mjs`.
- Railway health checks use `/api/healthz`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/discord-bot.ts` — Discord događaji, komande i verifikacioni tok
- `<RAILWAY_VOLUME_MOUNT_PATH>/verification-state.json` — podešavanje servera i prijave na Railway Volume-u

## Architecture decisions

- Prijava se otvara iz privatnog interaction prozora nakon klika na dugme panela; bot ne šalje kandidatima DM poruke.
- Rankovi se biraju kroz Discord Select Menu i povezuju sa rolama komandom `/rank-add`, pa se promena radi bez izmene koda.
- Samo administratori i role podešene komandom `/hc-role-add` mogu obrađivati prijave.
- Komanda `/copy-role` kopira podešene role-level postavke i role overwrite dozvole na kanalima/kategorijama nakon potvrde dugmetom; hijerarhijska pozicija role se ne kopira jer Discord ne može imati dve role na istoj poziciji.
- Odobrene i odbijene prijave kopiraju se u poseban log kanal.
- Podaci i odluke se čuvaju u JSON fajlu, tako da restart bota ne briše prijave.

## Product

Nakon klika na dugme panela kandidat privatno bira rank, zatim u modalu popunjava ime, prezime, ID i Discord mention/ID osobe koja ga je ubacila. HC dobija prijavu sa dugmadima za odobrenje/odbijanje i opcionalnim razlogom odbijanja. Odobrenje dodaje izabranu rolu i postavlja nadimak u formatu `Ime Prezime | ID`, a odluka se šalje i u log kanal.

## User preferences

- Rank role mapping se podešava po Discord serveru komandama, za rankove 1–10.
- Panel, HC kanal i log kanal se podešavaju komandom `/verification-setup`.
- HC dozvole se podešavaju komandama `/hc-role-add`, `/hc-role-remove` i `/hc-role-list`.
- Kopiranje rolea se pokreće komandom `/copy-role`, uz `Source Role`, `Target Role` i potvrdu `✅ Kopiraj sve`.

## Gotchas

- Bot mora imati `Manage Roles`, `Manage Channels`, `Manage Nicknames`, `View Channel`, `Send Messages`, `Read Message History`, `Embed Links` i `Use Application Commands`.
- Discord bot rola mora biti iznad svih rank rola koje dodeljuje.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
