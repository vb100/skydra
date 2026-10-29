# Project-wide resources shared by all SkyDra environments: enabled APIs and the image registry.
# Applied once; each environment is a separate state of ../env.

terraform {
  required_version = ">= 1.13"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 8.8.0" }
  }
  backend "gcs" {
    prefix = "skydra/shared"
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

locals {
  services = [
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]
}

resource "google_project_service" "this" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "skydra" {
  repository_id = "skydra"
  location      = var.region
  format        = "DOCKER"
  description   = "SkyDra application images"

  # Keep the 20 most recent images; older untagged ones are removed.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }
  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state = "UNTAGGED"
    }
  }

  depends_on = [google_project_service.this]
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.skydra.repository_id}"
}
