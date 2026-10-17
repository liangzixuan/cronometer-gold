# Retained storage has its own state and no host disposal entry point.
resource "azurerm_resource_group" "storage" {
  name     = "nourishing-storage-${var.suffix}"
  location = "centralus"
  tags     = { environment = "development", terraform_scope = "retained-storage" }
  timeouts {
    create = "2m"
    read   = "1m"
    update = "2m"
    delete = "2m"
  }
}
resource "azurerm_storage_account" "artifact" {
  name                              = "nourish${var.suffix}art"
  resource_group_name               = azurerm_resource_group.storage.name
  location                          = "centralus"
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  access_tier                       = "Hot"
  https_traffic_only_enabled        = true
  min_tls_version                   = "TLS1_2"
  shared_access_key_enabled         = false
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  public_network_access_enabled     = true
  infrastructure_encryption_enabled = true
  is_hns_enabled                    = false
  nfsv3_enabled                     = false
  sftp_enabled                      = false
  local_user_enabled                = false
  cross_tenant_replication_enabled  = false
  dns_endpoint_type                 = "Standard"
  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
    ip_rules       = var.ipv4_rules
  }
  blob_properties { versioning_enabled = false }
  tags = { environment = "development", terraform_scope = "retained-storage" }
  timeouts {
    create = "2m"
    read   = "1m"
    update = "2m"
    delete = "2m"
  }
}
resource "azurerm_storage_account" "erasure" {
  name                              = "nourish${var.suffix}era"
  resource_group_name               = azurerm_resource_group.storage.name
  location                          = "centralus"
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  access_tier                       = "Hot"
  https_traffic_only_enabled        = true
  min_tls_version                   = "TLS1_2"
  shared_access_key_enabled         = false
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  public_network_access_enabled     = true
  infrastructure_encryption_enabled = true
  is_hns_enabled                    = false
  nfsv3_enabled                     = false
  sftp_enabled                      = false
  local_user_enabled                = false
  cross_tenant_replication_enabled  = false
  dns_endpoint_type                 = "Standard"
  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
    ip_rules       = var.ipv4_rules
  }
  blob_properties { versioning_enabled = true }
  tags = { environment = "development", terraform_scope = "retained-storage" }
  timeouts {
    create = "2m"
    read   = "1m"
    update = "2m"
    delete = "2m"
  }
}
resource "azurerm_storage_account" "backup" {
  name                              = "nourish${var.suffix}bak"
  resource_group_name               = azurerm_resource_group.storage.name
  location                          = "centralus"
  account_kind                      = "StorageV2"
  account_tier                      = "Standard"
  account_replication_type          = "LRS"
  access_tier                       = "Hot"
  https_traffic_only_enabled        = true
  min_tls_version                   = "TLS1_2"
  shared_access_key_enabled         = false
  allow_nested_items_to_be_public   = false
  default_to_oauth_authentication   = true
  public_network_access_enabled     = true
  infrastructure_encryption_enabled = true
  is_hns_enabled                    = false
  nfsv3_enabled                     = false
  sftp_enabled                      = false
  local_user_enabled                = false
  cross_tenant_replication_enabled  = false
  dns_endpoint_type                 = "Standard"
  network_rules {
    default_action = "Deny"
    bypass         = ["None"]
    ip_rules       = var.ipv4_rules
  }
  blob_properties { versioning_enabled = true }
  tags = { environment = "development", terraform_scope = "retained-storage" }
  timeouts {
    create = "2m"
    read   = "1m"
    update = "2m"
    delete = "2m"
  }
}

# ARM owns the three nested containers through this one fixed deployment.
resource "azurerm_resource_group_template_deployment" "containers" {
  name                = "nourishing-containers-${var.suffix}"
  resource_group_name = azurerm_resource_group.storage.name
  deployment_mode     = "Incremental"
  parameters_content  = jsonencode({})
  tags                = { environment = "development", terraform_scope = "retained-storage" }
  depends_on = [
    azurerm_storage_account.artifact,
    azurerm_storage_account.erasure,
    azurerm_storage_account.backup,
  ]
  template_content = jsonencode({
    "$schema"      = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
    contentVersion = "1.0.0.0"
    parameters     = {}
    variables      = {}
    outputs        = {}
    resources = [
      {
        type       = "Microsoft.Storage/storageAccounts/blobServices/containers"
        apiVersion = "2025-06-01"
        name       = "${azurerm_storage_account.artifact.name}/default/nourishing-development-artifact"
        properties = {
          publicAccess                = "None"
          defaultEncryptionScope      = "$account-encryption-key"
          denyEncryptionScopeOverride = true
          metadata                    = {}
        }
      },
      {
        type       = "Microsoft.Storage/storageAccounts/blobServices/containers"
        apiVersion = "2025-06-01"
        name       = "${azurerm_storage_account.erasure.name}/default/nourishing-development-erasure"
        properties = {
          publicAccess                = "None"
          defaultEncryptionScope      = "$account-encryption-key"
          denyEncryptionScopeOverride = true
          metadata                    = {}
        }
      },
      {
        type       = "Microsoft.Storage/storageAccounts/blobServices/containers"
        apiVersion = "2025-06-01"
        name       = "${azurerm_storage_account.backup.name}/default/nourishing-development-backup"
        properties = {
          publicAccess                = "None"
          defaultEncryptionScope      = "$account-encryption-key"
          denyEncryptionScopeOverride = true
          metadata                    = {}
        }
      },
    ]
  })
  lifecycle { prevent_destroy = true }
  timeouts {
    create = "2m"
    read   = "1m"
    update = "2m"
    delete = "2m"
  }
}
