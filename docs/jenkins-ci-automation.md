# Jenkins CI/CD Automation (GitHub Webhook)

A push to `main` on `shivprasad08/CodeGraph` triggers the `CodeGraph-CI` Jenkins job via a GitHub webhook.
The pipeline stages are unchanged:

```text
git push origin main -> GitHub push webhook -> Jenkins /github-webhook/ -> CodeGraph-CI (Jenkinsfile)
  Checkout -> Backend Tests -> Frontend Tests -> Frontend Build -> Docker Build
  -> Trivy Security Scan -> Push Images (localhost:5000) -> Deploy to Kubernetes (Helm / K3s)
```

## How triggering works

1. GitHub POSTs a `push` event to `http://13.206.56.253:8080/github-webhook/`.
2. The Jenkins **GitHub plugin** finds jobs whose SCM URL matches the pushed repository and whose
   `githubPush()` trigger is enabled.
3. Jenkins polls the job's configured SCM. It builds only if the configured branch (`*/main`) has new
   commits, so a push to another branch does not start a build.
4. If several commits arrive in one push, Jenkins builds the newest one once.

`Jenkinsfile` declares `triggers { githubPush() }`, which matches the job's **GitHub hook trigger for
GITScm polling** checkbox. Both settings configure the same trigger. Do **not** also enable **Poll SCM**
unless the webhook cannot be made to work (see the fallback below).

## Jenkins configuration (one-time)

1. **Plugins**: *Manage Jenkins -> Plugins -> Installed*. Check that **GitHub plugin** (`github`) and
   **Git plugin** (`git`) are installed. Installing the suggested plugins during Jenkins setup includes
   both, through *GitHub Branch Source*. If the GitHub plugin is missing, install it from *Available
   plugins*. Choose **Restart Jenkins when installation is complete and no jobs are running**.
2. **Job**: *CodeGraph-CI -> Configure*
   - *Build Triggers*: tick **GitHub hook trigger for GITScm polling**. Leave **Poll SCM** unticked.
   - *Pipeline -> Definition*: Pipeline script from SCM, Git
     - Repository URL: `https://github.com/shivprasad08/CodeGraph.git`. It must be this repository, or
       the webhook will not match the job.
     - Branch Specifier: `*/main`
     - Script Path: `Jenkinsfile`
     - **Lightweight checkout**: keep ticked.
   - Optional: *GitHub project* -> Project url `https://github.com/shivprasad08/CodeGraph/`
3. **Webhook secret**: *Manage Jenkins -> Credentials -> System -> Global -> Add Credentials*
   - Kind: **Secret text**, ID: `github-webhook-secret`, Secret: a random value. Generate one with
     `openssl rand -hex 32`.
   - *Manage Jenkins -> System -> GitHub -> Advanced -> Shared secrets -> Add*: select
     `github-webhook-secret`.
   - Store the secret only in Jenkins and GitHub. Never commit it.
4. **Dashboard URL overrides (optional)**: *Manage Jenkins -> System -> Global properties ->
   Environment variables*. You can set `CODEGRAPH_APP_URL`, `CODEGRAPH_JENKINS_URL`,
   `CODEGRAPH_PROMETHEUS_URL`, `CODEGRAPH_GRAFANA_URL` and `CODEGRAPH_MONITORING_NOTE`. Without them,
   the `Jenkinsfile` defaults apply. Once the unified reverse proxy is working (a later module), set
   these to the proxy URLs and clear `CODEGRAPH_MONITORING_NOTE`. No Jenkinsfile edit is needed.

## Network prerequisite (EC2 security group)

The Terraform security group (`terraform/main.tf`) opens only ports 22, 80, 8000 and 30081. **Port 8080
is not opened by Terraform.** GitHub's servers must be able to reach `13.206.56.253:8080`, or the
webhook deliveries will fail with a timeout.

Add an inbound rule manually in *EC2 -> Security Groups -> codegraph SG -> Edit inbound rules*. Do not
re-apply Terraform for this.

- TCP 8080 from your own IP (`x.x.x.x/32`), for browser access to Jenkins.
- TCP 8080 from GitHub's webhook ranges: the `hooks` list from `curl https://api.github.com/meta`
  (currently `192.30.252.0/22`, `185.199.108.0/22`, `140.82.112.0/20` and `143.55.64.0/20`, plus IPv6).
  Avoid `0.0.0.0/0`.

Check reachability from outside: `curl -i -X POST http://13.206.56.253:8080/github-webhook/`.
Any HTTP response, typically `400`, `403` or `500` for an empty payload, shows the endpoint is
reachable. A timeout means the port is blocked.

## GitHub webhook configuration

*GitHub -> CodeGraph -> Settings -> Webhooks -> Add webhook*

| Field | Value |
|---|---|
| Payload URL | `http://13.206.56.253:8080/github-webhook/` (trailing slash required) |
| Content type | `application/json` |
| Secret | same value as the Jenkins `github-webhook-secret` |
| SSL verification | not applicable over HTTP; enable it once Jenkins is served over HTTPS |
| Events | **Just the push event** |
| Active | ticked |

Webhooks cannot be filtered by branch. The `*/main` branch specifier in Jenkins handles that: pushes
to other branches are delivered but produce no build.

After saving, *Recent Deliveries* shows a `ping` event. A green tick with response `200` means Jenkins
accepted it.

## Security considerations

- **HTTP only**: the payload and the `X-Hub-Signature-256` header travel in clear text. The HMAC
  secret stops forged payloads from being accepted, but not traffic inspection. The payload holds no
  credentials, only commit metadata.
- The secret proves the payload came from GitHub. Jenkins still re-fetches the code itself, so a forged
  hook could at most trigger a poll.
- Restrict port 8080 to your IP and GitHub's hook ranges. Do not expose it to `0.0.0.0/0`.
- Recommended: put Jenkins behind Nginx with TLS on 443, for example with Let's Encrypt and a DNS name
  pointing at the Elastic IP. Then use an `https://.../github-webhook/` URL with SSL verification
  enabled and close 8080 to the public.
- Keep the Jenkins admin password strong, disable sign-up, and keep plugins updated.

## Fallback: SCM polling

If inbound traffic from GitHub to Jenkins cannot be allowed, untick the GitHub hook trigger and
replace `githubPush()` in `Jenkinsfile` with `pollSCM('H/5 * * * *')`. Do not keep both. Polling runs
`git ls-remote` every ~5 minutes, so builds start up to 5 minutes after a push, not immediately.

## Preflight checks (run on EC2 before the test push)

```bash
df -h /                                          # need several GB free for image builds
docker system df                                 # check image/cache usage
systemctl is-active jenkins
sudo -u jenkins kubectl get nodes                # Jenkins can read its kubeconfig
sudo -u jenkins helm list -A                     # codegraph release listed
curl -s http://localhost:5000/v2/_catalog        # registry healthy, lists codegraph-* repos
kubectl -n codegraph get pods                    # backend and frontend Running
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:30081/
```

Validate the Jenkinsfile with the declarative linter. Use an API token, never a password in shell
history.

```bash
curl -s -X POST -u "<user>:<api-token>" -F "jenkinsfile=<Jenkinsfile" \
  http://13.206.56.253:8080/pipeline-model-converter/validate
# Expected: "Jenkinsfile successfully validated."
```

## Harmless test push (from the local repo)

```powershell
git status                                   # confirm only the intended files are listed
git add docs/automation-test.md
git commit -m "test: verify GitHub webhook triggers Jenkins"
git push origin main
```

Then verify each of the following:

1. **GitHub -> Settings -> Webhooks -> Recent Deliveries**: the `push` delivery shows response `200`.
2. **Jenkins -> CodeGraph-CI**: a new build starts without Build Now. Its cause reads
   *"Started by GitHub push by shivprasad08"*.
3. **Checkout stage log**: `Commit:` matches `git rev-parse HEAD` locally.
4. All eight stages run. The final line is `Finished: SUCCESS` or `FAILURE`.
5. The `CodeGraph dashboards` block is printed, and the build description shows the commit and app URL.
6. Only **one** new build appears for the push.

## Troubleshooting

| Symptom | Check first | Expected / fix |
|---|---|---|
| Jenkins does not receive the webhook | GitHub *Recent Deliveries* response | Timeout: port 8080 is blocked in the security group or Jenkins is down. Open 8080 to GitHub's hook ranges and run `systemctl status jenkins`. |
| GitHub reports a failed delivery | Delivery's *Response* tab | `404`: wrong URL or missing trailing `/github-webhook/`, or the GitHub plugin is missing. `403`/`400` with an invalid signature: the secrets differ between GitHub and Jenkins. `302`: Jenkins URL or proxy redirect. |
| Delivery is 200 but no build starts | *Manage Jenkins -> System Log* (GitHub logger), the job's *GitHub Hook Log* | The job's repository URL must match `shivprasad08/CodeGraph` exactly, and **GitHub hook trigger for GITScm polling** must be enabled. The push must change `main`. |
| Required plugins are missing | *Manage Jenkins -> Plugins -> Installed* | Install **GitHub plugin** and **Git plugin**, then restart safely. `githubPush()` errors with "No such DSL method" until the plugin is installed. |
| Wrong branch is checked out | Job *Branch Specifier* | Must be `*/main`. The Checkout log prints `Branch: origin/main`. |
| Multiple builds for one push | Job *Build Triggers* | Enable only the GitHub hook trigger and turn off **Poll SCM**. Remove duplicate webhooks in GitHub. Only one job should point at this repository with the trigger. |
| Jenkins cannot read its kubeconfig | `sudo -u jenkins kubectl get nodes` | `/var/lib/jenkins/.kube/config` must exist, be owned by `jenkins` and point at `https://127.0.0.1:6443`. Re-copy it from `/etc/rancher/k3s/k3s.yaml` if needed. |
| Helm cannot connect to K3s | `sudo -u jenkins helm list -A` | "Kubernetes cluster unreachable": run `systemctl status k3s` and check the kubeconfig above. The pipeline sets `HOME=/var/lib/jenkins` so Helm finds it. |
| Docker image push fails | `curl localhost:5000/v2/_catalog`, `docker ps` | The registry container must be running on port 5000. Check `df -h` for a full disk. Check `jenkins` is in the `docker` group. |
| Trivy fails | Trivy stage log | Vulnerabilities found: exit code 1 by design. Fix the dependency or base image; **do not** lower the gate. DB download error: check outbound internet and disk, then retry once. |
| Build passes tests but deployment fails | `kubectl -n codegraph get pods`, `kubectl -n codegraph describe pod <pod>`, `helm history codegraph -n codegraph` | ImagePullBackOff: check the registry and the image tag. CrashLoopBackOff: check pod logs. Roll back with `helm rollback codegraph <rev> -n codegraph`. Do not delete the cluster, volumes or Secrets. |
