-- Preserve existing tokens without expanding their permissions.
ALTER TABLE access_tokens ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'legacy'
 CHECK(permission_mode IN ('legacy','shared','all'));
-- A shared current skill must not expose a previously private historical version.
ALTER TABLE skill_versions ADD COLUMN published_visibility TEXT NOT NULL DEFAULT 'private'
 CHECK(published_visibility IN ('private','public'));
-- Existing data has no historical visibility record. Expose only the already-public latest version.
UPDATE skill_versions SET published_visibility='public'
 WHERE EXISTS(SELECT 1 FROM skills s WHERE s.project_slug=skill_versions.project_slug
 AND s.slug=skill_versions.slug AND s.latest_version=skill_versions.version AND s.visibility='public');
