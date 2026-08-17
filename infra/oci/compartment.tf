resource "oci_identity_compartment" "pilot" {
  count = var.create_compartment ? 1 : 0

  compartment_id = local.parent_compartment_id
  description    = "Isolated compartment for the Cronometer Gold controlled-beta pilot"
  enable_delete  = true
  freeform_tags  = local.tags
  name           = var.compartment_name

  depends_on = [terraform_data.apply_guardrails]
}
