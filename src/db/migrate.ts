import bcrypt from 'bcryptjs'
import { pool } from './pool'

// Hash generated at run time so the seeded admin password (Admin@1234) is guaranteed to match.
// The first admin account. Set ADMIN_EMAIL / ADMIN_PASSWORD in the environment BEFORE the first deploy
// (the defaults are public, so never keep them on an online server).
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@deepweed.app'
if (!/^[^\s'"\\;]+@[^\s'"\\;]+$/.test(ADMIN_EMAIL)) { console.error('ADMIN_EMAIL is not a valid email'); process.exit(1) }
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@1234'
if (process.env.NODE_ENV === 'production' && ADMIN_PASSWORD === 'Admin@1234') console.warn('WARNING: ADMIN_PASSWORD is not set - the default, publicly known admin password is being used!')
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10)

const migrations = [
  `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'farmer' CHECK (role IN ('farmer', 'admin')),
    farm_location TEXT,
    primary_crop TEXT DEFAULT 'Maize',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
  `,
  `
  CREATE TABLE IF NOT EXISTS weed_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weed_name TEXT NOT NULL,
    confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
    crop_type TEXT NOT NULL DEFAULT 'Unknown',
    image_url TEXT,
    recommendations TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS weed_scans_user_idx ON weed_scans (user_id, created_at DESC);
  `,
  `
  CREATE TABLE IF NOT EXISTS herbicide_db (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    weed_name TEXT NOT NULL,
    herbicide_name TEXT NOT NULL,
    active_ingredient TEXT,
    dosage TEXT NOT NULL,
    application_method TEXT,
    safety_notes TEXT,
    created_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS herbicide_weed_idx ON herbicide_db (weed_name);
  `,
  `
  CREATE TABLE IF NOT EXISTS feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved')),
    admin_note TEXT,
    reviewed_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback (status, created_at DESC);
  `,
  `
  -- herbicide_db had no unique key, so "ON CONFLICT DO NOTHING" in the seed never fired and
  -- every re-run of the migration inserted the seed rows again. Remove duplicates, add the key.
  DELETE FROM herbicide_db a USING herbicide_db b
   WHERE a.ctid > b.ctid AND a.weed_name = b.weed_name AND a.herbicide_name = b.herbicide_name;
  CREATE UNIQUE INDEX IF NOT EXISTS herbicide_weed_herbicide_uq ON herbicide_db (weed_name, herbicide_name);
  `,
  `
  -- Seed default admin account (password: Admin@1234)
  INSERT INTO users (email, password_hash, first_name, last_name, role)
  VALUES (
    '__ADMIN_EMAIL__',
    '__ADMIN_HASH__',
    'System', 'Admin', 'admin'
  )
  ON CONFLICT (email) DO UPDATE
    SET password_hash = EXCLUDED.password_hash, updated_at = now()
    -- repair databases seeded with the original hash, which never matched Admin@1234
    WHERE users.password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lHqq';

  -- Seed herbicide data
  INSERT INTO herbicide_db (weed_name, herbicide_name, active_ingredient, dosage, application_method, safety_notes)
  VALUES
    ('Blackjack (Bidens pilosa)', 'Roundup', 'Glyphosate 360g/L', '2L per 100L water', 'Foliar spray', 'Wear gloves and mask. Avoid water sources.'),
    ('Stinging Nettle (Urtica dioica)', 'MCPA 500', 'MCPA 500g/L', '1.5L per 100L water', 'Directed spray', 'Keep away from livestock for 7 days.'),
    ('Blackgrass (Alopecurus myosuroides)', 'Atlantis OD', 'Mesosulfuron + Iodosulfuron', '0.5L per hectare', 'Foliar spray', 'Apply when actively growing.'),
    ('Wild Oat (Avena fatua)', 'Axial One', 'Pinoxaden 100g/L', '1L per hectare', 'Post-emergence spray', 'Apply at 2-3 leaf stage.'),
    ('Pigweed (Amaranthus hybridus)', 'Dual Gold', 'S-metolachlor 960g/L', '1.2L per hectare', 'Pre-emergence', 'Apply before crop emergence.')
  ON CONFLICT DO NOTHING;
  `,
  `
  ALTER TABLE weed_scans ADD COLUMN IF NOT EXISTS top3 JSONB;
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS is_correct BOOLEAN;
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS scan_id UUID REFERENCES weed_scans(id) ON DELETE SET NULL;
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS corrected_weed_name TEXT;
  `,
  `
  ALTER TABLE herbicide_db ADD COLUMN IF NOT EXISTS application_timing TEXT;
  ALTER TABLE herbicide_db ADD COLUMN IF NOT EXISTS crop TEXT;
  ALTER TABLE herbicide_db ADD COLUMN IF NOT EXISTS mode_of_action TEXT;
  ALTER TABLE herbicide_db ADD COLUMN IF NOT EXISTS pre_harvest_interval TEXT;
  -- the same herbicide can be recommended for the same weed on different crops
  DROP INDEX IF EXISTS herbicide_weed_herbicide_uq;
  CREATE UNIQUE INDEX IF NOT EXISTS herbicide_weed_herbicide_crop_uq
    ON herbicide_db (weed_name, herbicide_name, COALESCE(crop, ''));
  `,
  `
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
  ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply_seen_at TIMESTAMPTZ;
  -- replies written before these columns existed: treat as already read
  UPDATE feedback SET replied_at = updated_at, reply_seen_at = now()
   WHERE admin_note IS NOT NULL AND replied_at IS NULL;
  CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id, created_at DESC);
  `,
]

async function migrate() {
  console.log('Running migrations…')
  const client = await pool.connect()
  try {
    for (let i = 0; i < migrations.length; i++) {
      console.log(`  Migration ${i + 1}/${migrations.length}`)
      await client.query(migrations[i].replace('__ADMIN_HASH__', () => ADMIN_HASH).replace('__ADMIN_EMAIL__', () => ADMIN_EMAIL))
    }
    console.log('Migrations complete.')
  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

migrate()
