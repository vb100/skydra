-- Local development only: the runtime login used by the API. In GCP this user is created by
-- Terraform with a generated password. Migrations grant its privileges.
CREATE ROLE skydra_app LOGIN PASSWORD 'skydra_app';
