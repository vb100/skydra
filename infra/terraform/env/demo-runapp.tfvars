# Fallback while demo.skydra.eu is not verified in Search Console: the deterministic run.app URL
# (SERVICE-PROJECT_NUMBER.REGION.run.app). Switch to demo.tfvars once the domain is verified.
env            = "demo"
public_app_url = "https://skydra-demo-915954505621.europe-north1.run.app"
domain         = ""
db_tier        = "db-custom-1-3840"
min_instances  = 0
max_instances  = 3
