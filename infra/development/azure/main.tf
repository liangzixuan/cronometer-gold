locals {
  location        = "centralus"
  vm_size         = "Standard_B4ps_v2"
  admin_username  = "azureuser"
  image_publisher = "Canonical"
  image_offer     = "ubuntu-24_04-lts"
  image_sku       = "server-arm64"
  image_version   = "24.04.202609040"
  required_tags = {
    availability        = "single-server-non-ha"
    data-classification = "synthetic-only"
    environment         = "development"
    managed-by          = "terraform"
    purchase-model      = "on-demand"
    terraform-scope     = "empty-host-only"
  }
}
resource "azurerm_resource_group" "development" {
  name     = "${var.name_prefix}-rg"
  location = local.location
  tags     = local.required_tags
  lifecycle {
    precondition {
      condition = try(
        timecmp(var.live_preflight.checked_at_utc, plantimestamp()) <= 0 &&
        timecmp(var.live_preflight.checked_at_utc, timeadd(plantimestamp(), "-4h")) >= 0 &&
        timecmp(var.live_preflight.checked_at_utc, timestamp()) <= 0 &&
        timecmp(var.live_preflight.checked_at_utc, timeadd(timestamp(), "-4h")) >= 0,
        false,
      )
      error_message = "Fresh saved Azure responses are required at plan and apply."
    }
    precondition {
      condition = (
        var.live_preflight.subscription_id == var.subscription_id &&
        var.live_preflight.spending_limit == "On" && var.live_preflight.billing_limit == "On" &&
        var.live_preflight.credit_currency == "USD" && var.live_preflight.remaining_credit >= 20 &&
        var.live_preflight.regional_remaining >= 4 && var.live_preflight.family_remaining >= 4
      )
      error_message = "Keep both spending protections On, at least USD20 credit and four available regional/family cores. The auditor checks the original account/SKU/image/provider responses."
    }
    precondition {
      condition = try(
        timecmp(var.shutdown_deadline_utc, timeadd(plantimestamp(), "1h")) >= 0 &&
        timecmp(var.shutdown_deadline_utc, timeadd(plantimestamp(), "4h")) <= 0 &&
        timecmp(var.shutdown_deadline_utc, timeadd(timestamp(), "1h")) >= 0 &&
        timecmp(var.shutdown_deadline_utc, timeadd(timestamp(), "4h")) <= 0 &&
        formatdate("YYYY-MM-DD", var.shutdown_deadline_utc) == formatdate("YYYY-MM-DD", plantimestamp()) &&
        formatdate("YYYY-MM-DD", var.shutdown_deadline_utc) == formatdate("YYYY-MM-DD", timestamp()) &&
        timecmp(var.live_preflight.credit_expires_utc, timeadd(var.shutdown_deadline_utc, "744h")) >= 0,
        false,
      )
      error_message = "Shutdown must remain one to four hours away on the same UTC day; credit must cover the possible 31-day disk/IP retention. Recreate a stale plan."
    }
  }
}

resource "azurerm_virtual_network" "development" {
  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.development.location
  resource_group_name = azurerm_resource_group.development.name
  address_space       = ["10.43.0.0/16"]
  tags                = local.required_tags
}

resource "azurerm_subnet" "development" {
  name                            = "${var.name_prefix}-subnet"
  resource_group_name             = azurerm_resource_group.development.name
  virtual_network_name            = azurerm_virtual_network.development.name
  address_prefixes                = ["10.43.1.0/24"]
  default_outbound_access_enabled = false
}

resource "azurerm_network_security_group" "development" {
  name                = "${var.name_prefix}-nsg"
  location            = azurerm_resource_group.development.location
  resource_group_name = azurerm_resource_group.development.name
  tags                = local.required_tags

  security_rule {
    name                       = "allow-ssh-from-current-admin-ipv4"
    description                = "SSH from exactly one freshly verified operator IPv4 /32."
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_ipv4_cidr
    destination_address_prefix = "*"
  }


  security_rule {
    name                       = "allow-https-for-caddy"
    description                = "Public HTTPS reaches Caddy; Caddy must enforce the one-/32 synthetic development application allowlist."
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "deny-all-other-inbound"
    description                = "No public dependencies, HTTP or implicit VNet ingress."
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "development" {
  subnet_id                 = azurerm_subnet.development.id
  network_security_group_id = azurerm_network_security_group.development.id
}

resource "azurerm_public_ip" "development" {
  name                = "${var.name_prefix}-pip"
  location            = azurerm_resource_group.development.location
  resource_group_name = azurerm_resource_group.development.name
  allocation_method   = "Static"
  ip_version          = "IPv4"
  sku                 = "Standard"
  sku_tier            = "Regional"
  tags                = local.required_tags

}


resource "azurerm_network_interface" "development" {
  name                           = "${var.name_prefix}-nic"
  location                       = azurerm_resource_group.development.location
  resource_group_name            = azurerm_resource_group.development.name
  accelerated_networking_enabled = false
  ip_forwarding_enabled          = false
  tags                           = local.required_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.development.id
    private_ip_address_allocation = "Dynamic"
    private_ip_address_version    = "IPv4"
    public_ip_address_id          = azurerm_public_ip.development.id
    primary                       = true
  }
}

resource "azurerm_linux_virtual_machine" "development" {
  name                            = "${var.name_prefix}-vm"
  computer_name                   = "nutrition-development"
  location                        = azurerm_resource_group.development.location
  resource_group_name             = azurerm_resource_group.development.name
  size                            = local.vm_size
  admin_username                  = local.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.development.id]
  provision_vm_agent              = true
  allow_extension_operations      = false
  secure_boot_enabled             = false
  vtpm_enabled                    = false
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
    version   = local.image_version
  }

}

resource "azurerm_managed_disk" "data" {
  name                 = "${var.name_prefix}-data"
  location             = azurerm_resource_group.development.location
  resource_group_name  = azurerm_resource_group.development.name
  storage_account_type = "StandardSSD_LRS"
  create_option        = "Empty"
  disk_size_gb         = 64
  tags                 = local.required_tags

}

resource "azurerm_virtual_machine_data_disk_attachment" "data" {
  managed_disk_id    = azurerm_managed_disk.data.id
  virtual_machine_id = azurerm_linux_virtual_machine.development.id
  lun                = 0
  caching            = "None"
}


resource "azurerm_dev_test_global_vm_shutdown_schedule" "development" {
  virtual_machine_id    = azurerm_linux_virtual_machine.development.id
  location              = azurerm_resource_group.development.location
  enabled               = true
  daily_recurrence_time = formatdate("hhmm", var.shutdown_deadline_utc)
  timezone              = "UTC"
  tags                  = local.required_tags

  notification_settings {
    enabled = false
  }
}
