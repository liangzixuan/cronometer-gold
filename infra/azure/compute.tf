resource "azurerm_linux_virtual_machine" "beta" {
  name                            = "${var.name_prefix}-vm"
  computer_name                   = "nutrition-beta"
  location                        = azurerm_resource_group.beta.location
  resource_group_name             = azurerm_resource_group.beta.name
  size                            = local.vm_size
  admin_username                  = local.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.beta.id]
  provision_vm_agent              = true
  allow_extension_operations      = false
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  tags                            = local.required_tags

  admin_ssh_key {
    username   = local.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    name                 = "${var.name_prefix}-os"
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 64
  }

  source_image_reference {
    publisher = local.image_publisher
    offer     = local.image_offer
    sku       = local.image_sku
    version   = var.ubuntu_image_version
  }

  lifecycle {
    precondition {
      condition     = var.live_preflight.vm_sku == "Standard_E2ps_v5"
      error_message = "The only admitted VM size is Standard_E2ps_v5 (2 vCPU, 16 GiB, Arm64)."
    }
  }
}

resource "azurerm_managed_disk" "data" {
  name                 = "${var.name_prefix}-data"
  location             = azurerm_resource_group.beta.location
  resource_group_name  = azurerm_resource_group.beta.name
  storage_account_type = "StandardSSD_LRS"
  create_option        = "Empty"
  disk_size_gb         = 64
  tags                 = merge(local.required_tags, { "preservation" = "manual-delete-only" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.beta.id
  lun                = 0
  caching            = "None"
}

resource "azurerm_management_lock" "data" {
  name       = "${var.name_prefix}-data-delete-lock"
  scope      = azurerm_managed_disk.data.id
  lock_level = "CanNotDelete"
  notes      = "Preserve synthetic beta state across VM replacement; removal requires a separately reviewed manual operation."

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_dev_test_global_vm_shutdown_schedule" "beta" {
  virtual_machine_id    = azurerm_linux_virtual_machine.beta.id
  location              = azurerm_resource_group.beta.location
  enabled               = true
  daily_recurrence_time = formatdate("hhmm", var.first_session_shutdown_deadline_utc)
  timezone              = "UTC"
  tags                  = local.required_tags

  notification_settings {
    enabled         = true
    email           = local.shutdown_email
    time_in_minutes = 30
  }
}
