# Contract-half migrations

Migrations here are **authored but deliberately not applied**. They are NOT under
`db/migrations/`, because `db/migrate.ts` runs `prisma migrate deploy`, which
applies every pending migration it finds — and the whole point of these files is
that they must land *after* an application rollout, not with it.

## Applying one

Move the directory into `db/migrations/` and run `npm run db:migrate`:

```
git mv db/contract/<name> db/migrations/<name>
npm run db:migrate
```

## Current contents

### `20260908220000_admin_sessions_family_fk`

The `admin_sessions.family_id → admin_session_families.id` foreign key.

Held back because of the expand/contract sequence in
`20260908210000_admin_session_families`. Until every old application instance has
drained, old code is still running the previous `createFirstGeneration`, which
inserts a generation with no family row. The instant this FK exists, that becomes a
foreign-key violation on **every sign-in served by an old instance**.

Apply it only after step 3 of the deployment sequence — no old-version instance is
still serving traffic.

Nothing about the F01 fix depends on this constraint. The locking needs the family
ROW to exist, which the expand migration guarantees for all pre-existing data and
the new `createFirstGeneration` guarantees for everything after it. The FK is
integrity insurance, plus the defence in depth noted in the file itself.
