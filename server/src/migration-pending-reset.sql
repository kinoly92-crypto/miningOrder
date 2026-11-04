-- Apply explicitly with a privileged MySQL account after taking and checking a backup.
-- Existing rows keep their dispatch history and default to derived status.
ALTER TABLE projects ADD COLUMN pending_reset INTEGER NOT NULL DEFAULT 0;
