resource "azurerm_consumption_budget_resource_group" "beta" {
  name              = "${var.name_prefix}-monthly-budget"
  resource_group_id = azurerm_resource_group.beta.id
  amount            = var.monthly_budget_amount_usd
  time_grain        = "Monthly"

  time_period {
    start_date = var.budget_start_date_utc
  }

  notification {
    enabled        = true
    threshold      = 50
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.alert_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.alert_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_emails = var.alert_contact_emails
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_emails = var.alert_contact_emails
  }
}
