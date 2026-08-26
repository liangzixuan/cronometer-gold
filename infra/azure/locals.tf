locals {
  exact_deployment_acknowledgement = "I ACKNOWLEDGE THIS IS A SYNTHETIC-ONLY NON-HA ON-DEMAND AZURE BETA THAT CAN CONSUME CREDIT; THE HOST STARTS EMPTY; NO PAID FALLBACK OR AUTOMATIC START IS AUTHORIZED"

  location       = "eastus2"
  admin_username = "azureuser"
  vm_size        = "Standard_E2ps_v5"

  image_publisher = "Canonical"
  image_offer     = "ubuntu-24_04-lts"
  image_sku       = "server-arm64"

  required_resource_providers = toset([
    "Microsoft.Authorization",
    "Microsoft.Compute",
    "Microsoft.Consumption",
    "Microsoft.DevTestLab",
    "Microsoft.Network",
    "Microsoft.Resources",
  ])

  required_tags = {
    "data-classification" = "synthetic-only"
    "availability"        = "single-server-non-ha"
    "purchase-model"      = "on-demand"
    "environment"         = "beta"
    "managed-by"          = "terraform"
    "terraform-scope"     = "empty-host-only"
  }

  shutdown_email = sort(tolist(var.alert_contact_emails))[0]
}
