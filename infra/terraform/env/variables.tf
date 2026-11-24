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
