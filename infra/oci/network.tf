data "oci_core_vcn" "existing" {
  vcn_id = var.existing_vcn_ocid
}

data "oci_core_internet_gateways" "existing" {
  compartment_id = data.oci_core_vcn.existing.compartment_id
  vcn_id         = var.existing_vcn_ocid

  filter {
    name   = "id"
    values = [var.existing_internet_gateway_ocid]
  }
}

# The tenancy currently has one internet gateway and no NAT-gateway allowance.
# Creating a second VCN would strand it without internet egress. This module
# therefore adds only isolated child resources to the explicitly selected VCN;
# it never changes the VCN default route table, DHCP options, or security list.
resource "oci_core_route_table" "edge" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-edge-routes"
  freeform_tags  = local.tags
  vcn_id         = data.oci_core_vcn.existing.id

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = var.existing_internet_gateway_ocid
  }

  route_rules {
    destination       = data.oci_core_services.object_storage.services[0].cidr_block
    destination_type  = "SERVICE_CIDR_BLOCK"
    network_entity_id = oci_core_service_gateway.object_storage.id
  }

  depends_on = [terraform_data.apply_guardrails]

  lifecycle {
    precondition {
      condition     = data.oci_core_vcn.existing.state == "AVAILABLE"
      error_message = "The selected existing VCN is not AVAILABLE."
    }

    precondition {
      condition     = contains(data.oci_core_vcn.existing.cidr_blocks, var.vcn_cidr)
      error_message = "vcn_cidr does not match a CIDR on the selected live VCN."
    }

    precondition {
      condition     = length(data.oci_core_internet_gateways.existing.gateways) == 1
      error_message = "The explicit internet-gateway OCID did not resolve exactly once inside the selected VCN."
    }

    precondition {
      condition     = try(data.oci_core_internet_gateways.existing.gateways[0].vcn_id == data.oci_core_vcn.existing.id && data.oci_core_internet_gateways.existing.gateways[0].enabled && data.oci_core_internet_gateways.existing.gateways[0].state == "AVAILABLE", false)
      error_message = "The selected internet gateway must be enabled and attached to the selected VCN."
    }
  }
}

# Explicitly attaching a module-owned, deny-by-default security list avoids any
# provider ambiguity around an empty security_list_ids value inheriting the
# legacy VCN default security list. All allowed traffic is declared in the NSG.
resource "oci_core_security_list" "edge_deny_by_default" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-edge-deny-by-default"
  freeform_tags  = local.tags
  vcn_id         = data.oci_core_vcn.existing.id
}

resource "oci_core_subnet" "edge" {
  cidr_block                 = var.public_subnet_cidr
  compartment_id             = local.target_compartment_id
  display_name               = "${var.name_prefix}-public-edge"
  dns_label                  = "goldedge"
  freeform_tags              = local.tags
  prohibit_internet_ingress  = false
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.edge.id
  security_list_ids          = [oci_core_security_list.edge_deny_by_default.id]
  vcn_id                     = data.oci_core_vcn.existing.id
}

resource "oci_core_network_security_group" "edge" {
  compartment_id = local.target_compartment_id
  display_name   = "${var.name_prefix}-edge-nsg"
  freeform_tags  = local.tags
  vcn_id         = data.oci_core_vcn.existing.id
}

resource "oci_core_network_security_group_security_rule" "http" {
  network_security_group_id = oci_core_network_security_group.edge.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"

  tcp_options {
    destination_port_range {
      max = 80
      min = 80
    }
  }
}

resource "oci_core_network_security_group_security_rule" "https" {
  network_security_group_id = oci_core_network_security_group.edge.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = "0.0.0.0/0"
  source_type               = "CIDR_BLOCK"

  tcp_options {
    destination_port_range {
      max = 443
      min = 443
    }
  }
}

resource "oci_core_network_security_group_security_rule" "ssh" {
  for_each = var.admin_cidrs

  network_security_group_id = oci_core_network_security_group.edge.id
  direction                 = "INGRESS"
  protocol                  = "6"
  source                    = each.value
  source_type               = "CIDR_BLOCK"

  tcp_options {
    destination_port_range {
      max = 22
      min = 22
    }
  }
}

resource "oci_core_network_security_group_security_rule" "egress" {
  network_security_group_id = oci_core_network_security_group.edge.id
  destination               = "0.0.0.0/0"
  destination_type          = "CIDR_BLOCK"
  direction                 = "EGRESS"
  protocol                  = "all"
}
