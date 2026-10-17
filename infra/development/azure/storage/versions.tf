terraform {
  required_version = "= 1.5.7"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "= 4.79.0" }
  }
}
provider "azurerm" {
  subscription_id                 = var.subscription_id
  resource_provider_registrations = "none"
  features {
    skip_import_check_on_create_and_allow_overwriting_existing_resources = false
    resource_group { prevent_deletion_if_contains_resources = true }
    storage { data_plane_available = false }
    template_deployment { delete_nested_items_during_deletion = false }
  }
}
