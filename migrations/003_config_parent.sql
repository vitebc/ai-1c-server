ALTER TABLE config_profiles ADD COLUMN parent_id TEXT REFERENCES config_profiles(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_config_profiles_parent ON config_profiles(parent_id);
