# CodeGraph – SRE & Incident Management

## 1. Service Level Indicators (SLIs)

### Availability
Percentage of successful CodeGraph service availability.

### Latency
Percentage of requests completed within the defined response-time threshold.

### Error Rate
Percentage of requests resulting in HTTP 5xx errors.

### Pod Reliability
Number of unexpected Kubernetes container restarts.

## 2. Service Level Objectives (SLOs)

| SLI | SLO |
|---|---|
| Availability | >= 99% |
| Request Latency | 95% of requests < 500 ms |
| Error Rate | < 1% HTTP 5xx |
| Pod Reliability | No unexpected restarts during normal operation |

## 3. Monitoring

Prometheus collects infrastructure and Kubernetes metrics.

Grafana provides dashboards for:

- EC2 CPU usage
- EC2 memory usage
- Kubernetes pod status
- Pod restart count
- Pod CPU usage
- Pod memory usage

## 4. Centralized Logging

Application logs are collected using:

Kubernetes -> Grafana Alloy -> Loki -> Grafana

Example LogQL query:

{namespace="codegraph", container="backend"}

## 5. Alerting

Alert: CodeGraph Pod Restart Alert

Condition: A CodeGraph pod restart is detected within the previous 5 minutes.

Evaluation interval: 1 minute

Severity: Warning

Alert lifecycle:

Normal -> Pending -> Firing -> Normal

## 6. Incident Demonstration

### Incident

The CodeGraph backend container was deliberately terminated to simulate an application failure.

Command:

kubectl exec -n codegraph deploy/codegraph-backend -- sh -c 'kill 1'

### Detection

Prometheus detected the increased Kubernetes container restart count.

### Alert

Grafana changed the alert state:

Normal -> Pending -> Firing

### Recovery

Kubernetes automatically restarted the failed container.

The backend returned to:

1/1 Running

The Grafana alert subsequently returned to:

Normal

### Impact

A short backend interruption occurred during the controlled test.

### Root Cause

The incident was intentionally caused by terminating the backend container's main process.

### Corrective Actions

- Prometheus monitoring
- Grafana alerting
- Kubernetes automatic container recovery
- Centralized logging with Loki
- Continuous CI/CD validation
- Container security scanning using Trivy

## 7. SRE Architecture

GitHub
  |
Jenkins
  |
Automated Tests
  |
Docker Build
  |
Trivy Security Scan
  |
Local Docker Registry
  |
Helm
  |
Kubernetes / K3s
  |
CodeGraph Application
  |
+----------------------+
|                      |
Prometheus           Alloy
|                      |
Grafana                Loki
|                      |
+----------+-----------+
           |
        Grafana
           |
       SRE Alert
           |
       Incident
           |
 Kubernetes Recovery

## 8. Conclusion

The CodeGraph project implements DevOps and SRE practices across the complete application lifecycle.

The system demonstrates:

- Continuous Integration and Continuous Deployment
- Automated backend and frontend testing
- Docker containerization
- Trivy security scanning
- Kubernetes deployment
- Helm-based deployment management
- Prometheus monitoring
- Grafana dashboards
- Centralized logging with Loki and Grafana Alloy
- Grafana-based alerting
- Kubernetes automatic recovery
- SLI and SLO definition
- Incident detection and post-incident recovery
