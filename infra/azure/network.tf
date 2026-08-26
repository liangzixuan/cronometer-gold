resource "azurerm_virtual_network" "beta" {
  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.beta.location
  resource_group_name = azurerm_resource_group.beta.name
  address_space       = ["10.42.0.0/16"]
  tags                = local.required_tags
}

resource "azurerm_subnet" "beta" {
  name                            = "${var.name_prefix}-subnet"
  resource_group_name             = azurerm_resource_group.beta.name
  virtual_network_name            = azurerm_virtual_network.beta.name
  address_prefixes                = ["10.42.1.0/24"]
  default_outbound_access_enabled = false
}

resource "azurerm_network_security_group" "beta" {
  name                = "${var.name_prefix}-nsg"
  location            = azurerm_resource_group.beta.location
  resource_group_name = azurerm_resource_group.beta.name
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
    name                       = "allow-http-for-caddy-acme-only"
    description                = "Public HTTP is solely for Caddy ACME handling; the runtime must reject non-ACME traffic outside its beta /32 allowlist."
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "allow-https-for-caddy"
    description                = "Public HTTPS reaches Caddy; Caddy must enforce the one-/32 synthetic beta application allowlist."
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "beta" {
  subnet_id                 = azurerm_subnet.beta.id
  network_security_group_id = azurerm_network_security_group.beta.id
}

resource "azurerm_public_ip" "beta" {
  name                = "${var.name_prefix}-pip"
  location            = azurerm_resource_group.beta.location
  resource_group_name = azurerm_resource_group.beta.name
  allocation_method   = "Static"
  ip_version          = "IPv4"
  sku                 = "Standard"
  sku_tier            = "Regional"
  tags                = local.required_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_management_lock" "public_ip" {
  name       = "${var.name_prefix}-pip-delete-lock"
  scope      = azurerm_public_ip.beta.id
  lock_level = "CanNotDelete"
  notes      = "Do not release this OCI network-source trust anchor before revoking every retained-OCI credential and verifying denial."

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_network_interface" "beta" {
  name                           = "${var.name_prefix}-nic"
  location                       = azurerm_resource_group.beta.location
  resource_group_name            = azurerm_resource_group.beta.name
  accelerated_networking_enabled = false
  ip_forwarding_enabled          = false
  tags                           = local.required_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.beta.id
    private_ip_address_allocation = "Dynamic"
    private_ip_address_version    = "IPv4"
    public_ip_address_id          = azurerm_public_ip.beta.id
    primary                       = true
  }
}
