-- Local development only. In GCP these users are created by Terraform with generated passwords.
--
-- skydra_migrator owns the schema and runs migrations. Like the migration user on Cloud SQL it is
-- not a superuser, so row-level security behaves locally exactly as in production.
CREATE ROLE skydra_migrator LOGIN PASSWORD 'skydra_migrator' CREATEROLE;
ALTER DATABASE skydra OWNER TO skydra_migrator;

-- The runtime login used by the API. Migrations grant its privileges.
CREATE ROLE skydra_app LOGIN PASSWORD 'skydra_app';
