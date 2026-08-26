output "resource_group_name" {
  description = "Dedicated synthetic-beta resource group."
  value       = azurerm_resource_group.beta.name
}

output "vm_id" {
  description = "Resource ID of the single non-HA Arm64 VM."
  value       = azurerm_linux_virtual_machine.beta.id
}

output "public_ipv4_address" {
  description = "Static IPv4 for later, separately reviewed Name.com DNS cutover. DNS is not managed by this module."
  value       = azurerm_public_ip.beta.ip_address
}

output "ssh_command" {
  description = "SSH command restricted by the NSG to admin_ipv4_cidr."
  value       = "ssh ${local.admin_username}@${azurerm_public_ip.beta.ip_address}"
}

output "preserved_data_disk_id" {
  description = "Delete-locked, prevent-destroy 64 GiB Standard SSD managed disk intended for /var/lib/nutrition-tracker."
  value       = azurerm_managed_disk.data.id
}

output "beta_allowed_ipv4_cidr" {
  description = "The exact /32 the not-yet-integrated Caddy runtime must use for BETA_ALLOWED_CIDRS."
  value       = var.beta_allowed_ipv4_cidr
}

output "runtime_deployment_status" {
  description = "Permanent scope warning: this Terraform module creates empty-host infrastructure and never attests or deploys the application runtime."
  value       = "EMPTY_HOST_ONLY: runtime admission is external to this module; keep OCI storage and Name.com DNS unchanged until separately reviewed evidence passes"
}
