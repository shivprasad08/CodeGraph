output "public_ip" {
  description = "Public (Elastic) IP of the server"
  value       = aws_eip.app.public_ip
}

output "frontend_url" {
  value = "http://${aws_eip.app.public_ip}"
}

output "backend_url" {
  value = "http://${aws_eip.app.public_ip}:8000"
}

output "ssh_command" {
  value = "ssh -i ${var.private_key_path} ubuntu@${aws_eip.app.public_ip}"
}