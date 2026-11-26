CREATE TABLE IF NOT EXISTS admin_sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS billing_snapshot (
    id INTEGER PRIMARY KEY CHECK(id=1), cents INTEGER NOT NULL, organization TEXT NOT NULL, checked TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generation_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, details TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0, read_success INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS menus (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, restaurant_key TEXT NOT NULL,
    date TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS published_menus ON menus(state, date DESC, created DESC);
  CREATE TABLE IF NOT EXISTS dish_objects (
  menu_id TEXT NOT NULL REFERENCES menus(id), position INTEGER NOT NULL, object_key TEXT NOT NULL,
  PRIMARY KEY(menu_id,position)
);
  CREATE TABLE IF NOT EXISTS object_cleanup (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    state TEXT NOT NULL, pages TEXT NOT NULL, result TEXT, error TEXT, read_ip TEXT
  );
  CREATE TRIGGER IF NOT EXISTS discard_draft_photos AFTER DELETE ON drafts BEGIN
    INSERT OR IGNORE INTO object_cleanup SELECT value FROM json_each(OLD.pages)
      WHERE value LIKE 'originals/%' AND value NOT IN (
        SELECT value FROM menus, json_each(menus.payload,'$.originals') WHERE menus.id=OLD.id);
  END;
CREATE TABLE IF NOT EXISTS generation_runs (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, restaurant TEXT NOT NULL,
      recorded TEXT NOT NULL, upload_ip TEXT, image_ip TEXT, legacy INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS generation_cities (
      run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
      ip TEXT NOT NULL, city TEXT NOT NULL, PRIMARY KEY(run_id,ip)
    );
    CREATE TABLE IF NOT EXISTS generation_calls (
      seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES generation_runs(id), started TEXT NOT NULL,
      kind TEXT NOT NULL, label TEXT NOT NULL, model TEXT NOT NULL, level TEXT NOT NULL, ip TEXT,
      state TEXT NOT NULL, usd REAL, basis TEXT NOT NULL DEFAULT 'unknown', usage TEXT
    );
    CREATE INDEX IF NOT EXISTS generation_calls_run ON generation_calls(run_id,seq);

CREATE TABLE IF NOT EXISTS billing_call_holds (
  call_seq INTEGER PRIMARY KEY REFERENCES generation_calls(seq),
  reserved_usd REAL,
  exhausted INTEGER NOT NULL DEFAULT 0,
  finished TEXT
);
CREATE TRIGGER IF NOT EXISTS close_billing_hold AFTER UPDATE OF state ON generation_calls
WHEN OLD.state = 'running' AND NEW.state <> 'running' BEGIN
  UPDATE billing_call_holds SET finished = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE call_seq = NEW.seq;
END;
