# 🗄️ Migration Guard

**Database migration safety checker for GitHub Actions.**

Catches dangerous SQL operations — data loss, long table locks, backward-incompatible changes — before they reach production.

> **Gap filled:** Existing marketplace actions (dbt-checkpoint, dbt-semguard) only cover dbt. Nothing checks general SQL migrations from Rails, Django, Flyway, Liquibase, raw SQL, etc.

## Supported Databases
- PostgreSQL (12 rules)
- MySQL (6 rules)
- SQLite (2 rules)

## What It Catches

| Rule | Level | Pattern |
|------|-------|---------|
| MG001 | 🔴 Error | `DROP TABLE` — permanent data loss |
| MG002 | 🔴 Error | `DROP COLUMN` — immediate data loss |
| MG003 | 🔴 Error | `NOT NULL` without `DEFAULT` — locks + fails |
| MG004 | 🟡 Warning | Column type change — full table rewrite |
| MG005 | 🟡 Warning | Index creation without `CONCURRENTLY` |
| MG006 | 🔴 Error | Explicit `LOCK TABLE` |
| MG007 | 🔴 Error | `TRUNCATE` — deletes all rows |
| MG008 | 🟡 Warning | Column rename — breaks existing queries |
| MG009 | 🟡 Warning | FK constraint without `NOT VALID` |
| MG010 | 🟡 Warning | `UPDATE` without `WHERE` clause |
| MG011 | 🟡 Warning | Table rename — breaks all references |
| MG012 | ℹ️ Info | Enum value addition (transaction warning) |

## Usage

```yaml
- uses: your-org/migration-guard@v1
  with:
    migrations-dir: 'db/migrations'
    database-type: 'postgres'
    fail-on-errors: 'true'
    fail-on-warnings: 'false'
```

## Supported Migration Formats
- Raw `.sql` files
- Rails migrations (`.rb` with `execute`)
- Django migrations (`.py` with `RunSQL`)
- Any file containing SQL strings
