# The public marketing site (skydra.eu): static pages served by nginx on Cloud Run. It has its own
# state and shares nothing with the application environments: no database, secrets or roles.

terraform {
  required_version = ">= 1.13"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.8.0" }
  }
  backend "gcs" {
    prefix = "skydra/landing"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  type    = string
  default = "melodic-casing-501208-a3" # "ESV project"
}

variable "region" {
  type    = string
  default = "europe-north1"
}

variable "image" {
  description = "Landing image, tagged with the commit (set by infra/scripts/deploy-landing.sh)."
  type        = string
}

# Its own identity without any role: the default compute account has project-wide Editor.
resource "google_service_account" "landing" {
  account_id   = "skydra-landing"
  display_name = "SkyDra landing (no permissions)"
}

resource "google_cloud_run_v2_service" "landing" {
  name     = "skydra-landing"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  # Stateless: it can always be recreated from the image.
  deletion_protection = false

  template {
    service_account = google_service_account.landing.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image = var.image
      ports {
        container_port = 8080
      }
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.landing.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_url" {
  value = google_cloud_run_v2_service.landing.uri
}
