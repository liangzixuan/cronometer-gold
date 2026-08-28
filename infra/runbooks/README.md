# Operations runbooks

Unless an entry is explicitly marked blocked or historical, runbooks are
executable safety checklists. Replace angle-bracket placeholders, record the
operator/ticket/time, and prefer a second reviewer for shared or production
environments. Blocked and historical entries are reference material only.

- [Local dependencies](./local-development.md)
- [Forward-only database migrations](./database-migrations.md)
- [PostgreSQL backup and restore](./postgres-backup-and-restore.md)
- [Privacy export and account erasure](./privacy-export-and-erasure.md)
- [Platform-health and reminder release](./platform-health-release.md)
- [Windows-host/WSL2 physical-device private HTTPS — offline framework; live use blocked](./physical-device-windows-wsl2-private-https.md)
- [Physical-device private HTTPS — historical, non-executable, non-release-compatible](./physical-device-private-https.md)
- [Synthetic P0 client-smoke review package](./p0-client-smoke.md)
- [Food-source release promotion](./food-source-release.md)
- [Official food-source release catalogue](../../docs/ingestion/official-source-releases.md)

Never paste secrets, nutrition exports, health payloads, or production database
URLs into tickets, chat, shell history, or repository files.
