-- Create a secure RPC function to register/update FCM tokens bypassing RLS
CREATE OR REPLACE FUNCTION public.register_fcm_token(
  p_token TEXT,
  p_device_type TEXT DEFAULT 'web'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER -- This is the key: it runs with admin privileges, bypassing RLS
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Get the currently authenticated user ID
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Upsert the token
  -- If the token already exists (even if it belonged to a previous user on this device),
  -- it will be reassigned to the current user and the last_used_at timestamp will be updated.
  INSERT INTO public.fcm_tokens (user_id, token, device_type, last_used_at)
  VALUES (v_user_id, p_token, p_device_type, now())
  ON CONFLICT (token) DO UPDATE
  SET 
    user_id = EXCLUDED.user_id,
    device_type = EXCLUDED.device_type,
    last_used_at = now();
END;
$$;
