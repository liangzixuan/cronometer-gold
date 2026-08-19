output "compartment_id" {
  description = "Compartment containing the pilot resources."
  value       = local.target_compartment_id
}

output "availability_domain" {
  description = "Availability domain selected for the A1 VM."
  value       = local.availability_domain
}

output "instance_id" {
  description = "OCID of the non-HA pilot VM."
  value       = oci_core_instance.pilot.id
}

output "reserved_public_ip" {
  description = "Reserved public IPv4 address. Create matching API and web A records before enabling the stack."
  value       = oci_core_public_ip.pilot.ip_address
}

output "api_origin" {
  description = "Expected CIDR-restricted synthetic-data beta API origin after DNS and TLS are live."
  value       = "https://${local.api_fqdn}"
}

output "web_origin" {
  description = "Expected CIDR-restricted synthetic-data beta browser origin after DNS and TLS are live."
  value       = "https://${local.web_fqdn}"
}

output "ssh_command" {
  description = "SSH command; replace the identity path with the private key matching an authorized public key."
  value       = "ssh -i /path/to/private-key opc@${oci_core_public_ip.pilot.ip_address}"
}

output "edge_subnet_id" {
  description = "Dedicated edge subnet; its custom route table and explicit security list leave the existing VCN defaults untouched."
  value       = oci_core_subnet.edge.id
}

output "boot_volume_backup_policy_assignment_id" {
  description = "Assignment proving the preserved encrypted boot volume has an automated backup policy."
  value       = oci_core_volume_backup_policy_assignment.boot.id
}

output "boot_volume_backup_policy_id" {
  description = "Module-owned same-region daily incremental policy retaining two days."
  value       = oci_core_volume_backup_policy.pilot.id
}

output "object_storage" {
  description = "Nonsecret OCI Object Storage runtime coordinates. Customer Secret Keys and the restore private key are intentionally absent from Terraform."
  value = {
    namespace          = data.oci_objectstorage_namespace.current.namespace
    s3_endpoint        = local.object_s3_endpoint
    export_bucket_name = oci_objectstorage_bucket.exports.name
    ledger_bucket_name = oci_objectstorage_bucket.ledger.name
    public_cidrs       = local.object_storage_public_cidrs
  }
}

output "object_storage_iam_user_ids" {
  description = "IAM user OCIDs consumed by the offline credential-provisioning runbook; these are identifiers, not credentials."
  value       = { for role, user in oci_identity_user.object_storage_role : role => user.id }
}

output "non_ha_warning" {
  description = "Persistent topology warning."
  value       = "SYNTHETIC-DATA CONTROLLED BETA ONLY: one VM contains every runtime dependency; any VM, boot-volume, or AD failure causes an outage."
}
