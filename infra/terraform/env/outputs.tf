output "service_url" {
  value = google_cloud_run_v2_service.app.uri
}

output "jobs" {
  value = { for k, j in google_cloud_run_v2_job.this : k => j.name }
}

output "database_instance" {
  value = google_sql_database_instance.db.connection_name
}

# Records to create at the DNS provider (Hostinger) for the custom domain.
output "domain_dns_records" {
  value = var.domain == "" ? [] : [
    for r in google_cloud_run_domain_mapping.app[0].status[0].resource_records :
    { name = r.name, type = r.type, rrdata = r.rrdata }
  ]
}
