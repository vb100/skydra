variable "project_id" {
  type    = string
  default = "melodic-casing-501208-a3" # "ESV project"
}

variable "region" {
  type    = string
  default = "europe-north1"
}

variable "env" {
  type = string
  validation {
    condition     = contains(["demo", "prod"], var.env)
    error_message = "env is demo or prod."
  }
}

variable "image" {
  description = "Full image reference, e.g. europe-north1-docker.pkg.dev/PROJECT/skydra/skydra:GIT_SHA."
  type        = string
}

variable "public_app_url" {
  description = "Origin the browser uses (invitation links, Origin check), e.g. https://demo.skydra.eu."
  type        = string
}

variable "domain" {
  description = "Custom domain to map to the service; empty for the run.app URL only."
  type        = string
  default     = ""
}

variable "integrations" {
  description = "External integrations: screening MOCK | MANUAL | OPENSANCTIONS, identity MOCK | MANUAL | DOKOBIT, registry MOCK | MANUAL | REGISTRU_CENTRAS. MOCK is refused by the application when env is prod."
  type = object({
    screening = string
    identity  = string
    registry  = string
  })
  default = { screening = "MOCK", identity = "MOCK", registry = "MOCK" }

  validation {
    condition = (
      contains(["MOCK", "MANUAL", "OPENSANCTIONS"], var.integrations.screening)
      && contains(["MOCK", "MANUAL", "DOKOBIT"], var.integrations.identity)
      && contains(["MOCK", "MANUAL", "REGISTRU_CENTRAS"], var.integrations.registry)
    )
    error_message = "Unknown provider code for screening, identity or registry."
  }
}

variable "screening_threshold" {
  description = "OpenSanctions score (0.5–0.99) from which a result is a strong match that must be reviewed."
  type        = number
  default     = 0.7

  validation {
    condition     = var.screening_threshold >= 0.5 && var.screening_threshold <= 0.99
    error_message = "screening_threshold must be between 0.5 and 0.99."
  }
}

variable "adverse_media" {
  description = "Adverse-media sources searched with OpenSanctions: Brave Search (needs its key in Secret Manager) and GDELT (no key; only once the client's DPIA covers it)."
  type = object({
    brave = bool
    gdelt = bool
  })
  default = { brave = false, gdelt = false }
}

variable "monitoring" {
  description = "Ongoing screening monitoring: a party of an open case is screened again when its latest check is interval_days old. schedule is a cron expression in Europe/Vilnius time for Cloud Scheduler (null: no schedule, the job runs only by hand); scheduler_region where Cloud Scheduler runs (null: the region of the environment)."
  type = object({
    interval_days    = optional(number, 7)
    batch            = optional(number, 200)
    schedule         = optional(string)
    scheduler_region = optional(string)
  })
  default = {}

  validation {
    condition     = var.monitoring.interval_days >= 1 && var.monitoring.interval_days <= 365
    error_message = "monitoring.interval_days must be between 1 and 365."
  }
}

variable "db_tier" {
  description = "Cloud SQL machine type (Enterprise edition)."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_high_availability" {
  type    = bool
  default = false
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 3
}

variable "deletion_protection" {
  type    = bool
  default = true
}
