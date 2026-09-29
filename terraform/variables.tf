variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "EC2 instance type (t3.small recommended: the frontend build needs >1 GB RAM)"
  type        = string
  default     = "t3.small"
}

variable "project_name" {
  description = "Name prefix for all resources"
  type        = string
  default     = "codegraph"
}

variable "public_key_path" {
  description = "Path to the SSH public key uploaded to AWS"
  type        = string
  default     = "~/.ssh/codegraph_key.pub"
}

variable "private_key_path" {
  description = "Path to the matching SSH private key (used in the Ansible inventory)"
  type        = string
  default     = "~/.ssh/codegraph_key"
}

variable "ssh_cidr" {
  description = "CIDR allowed to SSH in. Use your own IP/32 if you can."
  type        = string
  default     = "0.0.0.0/0"
}

variable "root_volume_size" {
  description = "Root disk size in GB"
  type        = number
  default     = 20
}