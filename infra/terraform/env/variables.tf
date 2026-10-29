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
  description = "External integrations. MOCK is refused by the application when env is prod."
  type = object({
    screening = string
    identity  = string
    registry  = string
  })
  default = { screening = "MOCK", identity = "MOCK", registry = "MOCK" }
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
