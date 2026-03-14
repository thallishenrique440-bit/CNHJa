-- Add start_time_utc to appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS start_time_utc TIMESTAMPTZ;

-- Backfill existing data assuming UTC-3 (Brazil/Sao_Paulo)
UPDATE appointments 
SET start_time_utc = (date || ' ' || start_time || ':00-03')::timestamptz 
WHERE start_time_utc IS NULL;

-- Create a simple RPC to get server time
CREATE OR REPLACE FUNCTION get_server_time()
RETURNS timestamptz
LANGUAGE sql
AS $$
  SELECT now();
$$;
