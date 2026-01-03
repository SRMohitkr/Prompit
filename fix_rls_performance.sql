-- Optimizing RLS Policies for Performance
-- Run this script in your Supabase SQL Editor to fix the performance warnings.

-- 1. Fix: device_metadata
DROP POLICY IF EXISTS "Devices can manage metadata" ON "public"."device_metadata";
CREATE POLICY "Devices can manage metadata" ON "public"."device_metadata"
AS PERMISSIVE FOR ALL
TO public
USING (
  device_id = (select current_setting('request.headers', true)::json->>'x-device-id')
)
WITH CHECK (
  device_id = (select current_setting('request.headers', true)::json->>'x-device-id')
);

-- 2. Fix: prompt_saves
DROP POLICY IF EXISTS "Users and Devices can manage their own prompts" ON "public"."prompt_saves";
CREATE POLICY "Users and Devices can manage their own prompts" ON "public"."prompt_saves"
AS PERMISSIVE FOR ALL
TO public
USING (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
)
WITH CHECK (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
);

-- 3. Fix: folders (View)
DROP POLICY IF EXISTS "Users and Devices can view own folders" ON "public"."folders";
CREATE POLICY "Users and Devices can view own folders" ON "public"."folders"
AS PERMISSIVE FOR SELECT
TO public
USING (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
);

-- 4. Fix: folders (Create)
DROP POLICY IF EXISTS "Users and Devices can create own folders" ON "public"."folders";
CREATE POLICY "Users and Devices can create own folders" ON "public"."folders"
AS PERMISSIVE FOR INSERT
TO public
WITH CHECK (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
);

-- 5. Fix: folders (Update)
DROP POLICY IF EXISTS "Users and Devices can update own folders" ON "public"."folders";
CREATE POLICY "Users and Devices can update own folders" ON "public"."folders"
AS PERMISSIVE FOR UPDATE
TO public
USING (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
)
WITH CHECK (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
);

-- 6. Fix: folders (Delete)
DROP POLICY IF EXISTS "Users and Devices can delete own folders" ON "public"."folders";
CREATE POLICY "Users and Devices can delete own folders" ON "public"."folders"
AS PERMISSIVE FOR DELETE
TO public
USING (
  (user_id = (select auth.uid())) OR 
  (device_id = (select current_setting('request.headers', true)::json->>'x-device-id'))
);
