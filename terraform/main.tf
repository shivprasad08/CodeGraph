provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

resource "google_compute_firewall" "allow_codegraph_ports" {
  name    = "allow-codegraph-ports"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22", "80", "8000"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["codegraph"]
}

resource "google_compute_instance" "codegraph_vm" {
  name         = "codegraph-server"
  machine_type = "e2-small"
  zone         = var.zone
  tags         = ["codegraph"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20
    }
  }

  network_interface {
    network = "default"
    access_config {}
  }

  metadata = {
    ssh-keys = "${var.ssh_user}:${file(var.ssh_pub_key_path)}"
  }
}

output "external_ip" {
  value = google_compute_instance.codegraph_vm.network_interface[0].access_config[0].nat_ip
}
