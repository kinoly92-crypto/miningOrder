-- Apply explicitly after reviewing the release and verifying a recoverable backup.
-- MySQL DDL commits independently; inspect each table before retrying an interrupted upgrade.
ALTER TABLE projects
  ADD COLUMN business_source TEXT NULL,
  ADD COLUMN business_level VARCHAR(20) NULL;
