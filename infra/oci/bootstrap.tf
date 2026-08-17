data "external" "bootstrap_bundle" {
  program = ["python3", "${path.module}/files/compress-bootstrap.py"]

  query = {
    payload = jsonencode(local.bootstrap_files)
  }
}
