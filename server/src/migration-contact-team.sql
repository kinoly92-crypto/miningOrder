-- Apply explicitly after reviewing the release and verifying a recoverable backup.
-- MySQL DDL commits independently; inspect each table before retrying an interrupted upgrade.
ALTER TABLE projects
  ADD COLUMN client_contact TEXT NULL,
  ADD COLUMN client_phone TEXT NULL;
ALTER TABLE dispatches
  ADD COLUMN team_members TEXT NULL,
  ADD COLUMN signatory_one TEXT NULL,
  ADD COLUMN signatory_two TEXT NULL;
