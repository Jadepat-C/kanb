-- Several single sign-on providers side by side. The settings (app_settings 'sso') become a list; the 0.4 shape is
-- read as a list of one by the app, so nothing changes here for it.
-- Which provider a sign-in on its way was started with (NULL: started before this version: the only provider).
ALTER TABLE sso_flows ADD COLUMN provider text;
-- Which provider an account was connected through, for its name on the Profile page (NULL: before this version).
ALTER TABLE user_identities ADD COLUMN provider text;
