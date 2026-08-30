variable "project_id" {
  description = "Your GCP project ID"
  type        = string
}

variable "region" {
  default = "us-central1"
}

variable "zone" {
  default = "us-central1-a"
}

variable "ssh_user" {
  description = "Username to SSH in as (matches your key comment)"
  type        = string
}

variable "ssh_pub_key_path" {
  default = "~/.ssh/codegraph-key.pub"
}
