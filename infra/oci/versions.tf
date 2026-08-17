terraform {
  required_version = ">= 1.5.7, < 2.0.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "= 7.32.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "= 2.3.5"
    }
  }
}

provider "oci" {
  auth                = var.oci_auth
  config_file_profile = var.oci_config_profile
  region              = var.region
}
