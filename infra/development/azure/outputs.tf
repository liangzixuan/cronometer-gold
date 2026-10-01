output "resource_group_name" {
  value = azurerm_resource_group.development.name
}
output "vm_id" {
  value = azurerm_linux_virtual_machine.development.id
}
output "public_ipv4_address" {
  value = azurerm_public_ip.development.ip_address
}
output "data_disk_id" {
  value = azurerm_managed_disk.data.id
}
output "shutdown_deadline_utc" {
  value = var.shutdown_deadline_utc
}
output "runtime_deployment_status" {
  value = "EMPTY_HOST_ONLY: actual ownership, shutdown readback, cleanup, Caddy access control and runtime admission remain separate"
}
