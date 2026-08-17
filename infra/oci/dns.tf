resource "oci_dns_rrset" "api" {
  count = var.create_oci_dns_records ? 1 : 0

  domain          = local.api_fqdn
  rtype           = "A"
  zone_name_or_id = var.dns_zone_name_or_id

  items {
    domain = local.api_fqdn
    rdata  = oci_core_public_ip.pilot.ip_address
    rtype  = "A"
    ttl    = var.dns_ttl_seconds
  }
}
resource "oci_dns_rrset" "web" {
  count = var.create_oci_dns_records ? 1 : 0

  domain          = local.web_fqdn
  rtype           = "A"
  zone_name_or_id = var.dns_zone_name_or_id

  items {
    domain = local.web_fqdn
    rdata  = oci_core_public_ip.pilot.ip_address
    rtype  = "A"
    ttl    = var.dns_ttl_seconds
  }
}
