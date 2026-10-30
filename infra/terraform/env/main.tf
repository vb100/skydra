# One SkyDra environment (demo or prod) in the "ESV project". Each environment has its own state
# (backend prefix), database instance, secrets, service accounts and Cloud Run resources; names
# carry the environment as a prefix so environments in the same project never share anything.

terraform {
  required_version = ">= 1.13"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.8.0" }
    random = { source = "hashicorp/random", version = "~> 3.9" }
  }
  # Bucket and prefix are given at init: -backend-config="prefix=skydra/env/demo".
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  name       = "skydra-${var.env}"
  connection = google_sql_database_instance.db.connection_name
  # node-postgres connects through the Cloud SQL socket that Cloud Run mounts at /cloudsql; the
  # "localhost" host only keeps the URL valid for config validation, `host=` overrides it.
  db_url = {
    app      = "postgres://skydra_app:${random_password.app.result}@localhost/skydra?host=/cloudsql/${local.connection}"
    migrator = "postgres://skydra_migrator:${random_password.migrator.result}@localhost/skydra?host=/cloudsql/${local.connection}"
  }
  common_env = {
    APP_ENV            = var.env
    PUBLIC_APP_URL     = var.public_app_url
    SCREENING_PROVIDER = var.integrations.screening
    IDENTITY_PROVIDER  = var.integrations.identity
    REGISTRY_PROVIDER  = var.integrations.registry
  }
}

# ---------------------------------------------------------------------------------------------
# Database. Only the migration owner is a Cloud SQL user; the runtime role skydra_app is created
# by migration 0001 and gets its password from the migration job, so it never joins
# cloudsqlsuperuser.

resource "google_sql_database_instance" "db" {
  name                = "${local.name}-pg"
  database_version    = "POSTGRES_17"
  region              = var.region
  deletion_protection = var.deletion_protection

  settings {
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      # Public IP without authorized networks: reachable only through the Cloud SQL connector
      # (IAM-authorized), as Cloud Run does.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      location                       = "eu"
      backup_retention_settings {
        retained_backups = 14
      }
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 2
    }

    insights_config {
      query_insights_enabled = true
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }
}

resource "google_sql_database" "skydra" {
  name     = "skydra"
  instance = google_sql_database_instance.db.name
}

resource "random_password" "migrator" {
  length  = 40
  special = false
}

resource "random_password" "app" {
  length  = 40
  special = false
}

resource "google_sql_user" "migrator" {
  name     = "skydra_migrator"
  instance = google_sql_database_instance.db.name
  password = random_password.migrator.result
}

# 32 random bytes, base64: encrypts TOTP secrets, personal codes and document numbers.
resource "random_bytes" "encryption_key" {
  length = 32
}

# ---------------------------------------------------------------------------------------------
# Secrets. The service reads only what it needs; the migration owner's credentials are readable
# only by the job identity.

locals {
  secrets = {
    "database-url"           = local.db_url.app
    "migration-database-url" = local.db_url.migrator
    "app-db-password"        = random_password.app.result
    "secret-encryption-key"  = random_bytes.encryption_key.base64
  }
  service_secrets = ["database-url", "secret-encryption-key"]
  job_secrets     = keys(local.secrets)
}

resource "google_secret_manager_secret" "this" {
  for_each  = local.secrets
  secret_id = "${local.name}-${each.key}"
  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

resource "google_secret_manager_secret_version" "this" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.this[each.key].id
  secret_data = each.value
}

resource "google_service_account" "service" {
  account_id   = "${local.name}-run"
  display_name = "SkyDra ${var.env}: application service"
}

resource "google_service_account" "jobs" {
  account_id   = "${local.name}-jobs"
  display_name = "SkyDra ${var.env}: migrations and seed jobs"
}

resource "google_project_iam_member" "sql_client" {
  for_each = {
    service = google_service_account.service.email
    jobs    = google_service_account.jobs.email
  }
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${each.value}"
}

resource "google_secret_manager_secret_iam_member" "service" {
  for_each  = toset(local.service_secrets)
  secret_id = google_secret_manager_secret.this[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.service.email}"
}

resource "google_secret_manager_secret_iam_member" "jobs" {
  for_each  = toset(local.job_secrets)
  secret_id = google_secret_manager_secret.this[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# ---------------------------------------------------------------------------------------------
# Application service: API and web app from one image, one origin.

resource "google_cloud_run_v2_service" "app" {
  name                = local.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account = google_service_account.service.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.connection]
      }
    }
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }
      dynamic "env" {
        for_each = local.common_env
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.this["database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SECRET_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.this["secret-encryption-key"].secret_id
            version = "latest"
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 10
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.service,
  ]
}

# The application has its own authentication; Cloud Run lets the requests through.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------------------------
# Jobs from the same image: migrations (each deploy) and, outside prod, the demo data.

locals {
  jobs = merge(
    { migrate = ["node", "dist/database/migrate.js"] },
    var.env == "prod" ? {} : { "seed-demo" = ["node", "dist/database/seed-demo.js"] },
  )
}

resource "google_cloud_run_v2_job" "this" {
  for_each            = local.jobs
  name                = "${local.name}-${each.key}"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    task_count = 1
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      timeout         = "600s"
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.connection]
        }
      }
      containers {
        image   = var.image
        command = each.value
        dynamic "env" {
          for_each = local.common_env
          content {
            name  = env.key
            value = env.value
          }
        }
        dynamic "env" {
          for_each = {
            DATABASE_URL           = "database-url"
            MIGRATION_DATABASE_URL = "migration-database-url"
            APP_DB_PASSWORD        = "app-db-password"
            SECRET_ENCRYPTION_KEY  = "secret-encryption-key"
          }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.this[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  # deploy.sh applies the jobs alone (-target) before migrating, so everything the migration job
  # needs at run time must be reachable from here: the database, its owner and the SQL client role.
  depends_on = [
    google_secret_manager_secret_version.this,
    google_secret_manager_secret_iam_member.jobs,
    google_sql_database.skydra,
    google_sql_user.migrator,
    google_project_iam_member.sql_client,
  ]
}

# ---------------------------------------------------------------------------------------------
# Custom domain (e.g. demo.skydra.eu). The domain must first be verified in Google Search Console
# by the identity running Terraform; DNS records to add at the registrar are in the outputs.

resource "google_cloud_run_domain_mapping" "app" {
  count    = var.domain == "" ? 0 : 1
  name     = var.domain
  location = var.region
  metadata {
    namespace = var.project_id
  }
  spec {
    route_name = google_cloud_run_v2_service.app.name
  }
}
