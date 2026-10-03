# CodeGraph on single-node k3s

These manifests deploy the existing FastAPI backend and Nginx-served React
frontend into a `codegraph` namespace. The PersistentVolume uses local host
storage because this is a single-node k3s demonstration. A real multi-node
cluster should use a proper StorageClass instead of `hostPath`.

## Install k3s on the AWS EC2 instance

Run these commands on the Ubuntu EC2 host. The installer enables the k3s server,
which includes the Kubernetes control plane, containerd, CoreDNS, and kubectl:

```bash
curl -sfL https://get.k3s.io | sh -
sudo systemctl status k3s --no-pager
sudo kubectl get nodes
```

For a regular non-root shell, configure kubectl to use the k3s kubeconfig:

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$USER:$USER" ~/.kube/config
kubectl get nodes
```

The node should show `Ready`. Ensure the EC2 security group allows TCP `30080`
for the NodePort demo. The backend port `8000` does not need to be exposed
because it is a `ClusterIP` service.

## Build images for k3s containerd

The simplest single-node workflow is to build with Docker, export each image,
and import it into k3s's containerd. Run from the repository root on the EC2
host:

```bash
export EC2_PUBLIC_IP="<your-ec2-public-ip>"

docker build -t codegraph-backend:latest ./backend
docker build \
  --build-arg VITE_API_URL="http://${EC2_PUBLIC_IP}:8000" \
  -t codegraph-frontend:latest \
  ./frontend

docker save codegraph-backend:latest -o /tmp/codegraph-backend.tar
docker save codegraph-frontend:latest -o /tmp/codegraph-frontend.tar
sudo k3s ctr images import /tmp/codegraph-backend.tar
sudo k3s ctr images import /tmp/codegraph-frontend.tar
sudo k3s ctr images list | grep codegraph
```

The frontend API URL is compiled into the React bundle during its image build.
Changing `VITE_API_URL` in the ConfigMap does not change an already-built
frontend image. The ConfigMap value is included for the assignment and is
available to the backend through `envFrom`.

## Prepare the manifests

Replace the `VITE_API_URL` placeholder in `01-configmap.yaml` with the real
value, for example `http://203.0.113.10:8000`. Replace every placeholder in
`02-secret.yaml` with the base64 encoding of the corresponding real value:

```bash
printf '%s' 'your-value' | base64 -w0
```

Base64 is only encoding, not encryption. Do not commit real credentials to Git.

## Apply in order

From the repository root, apply the numbered files in order:

```bash
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-secret.yaml
kubectl apply -f k8s/03-persistent-volume.yaml
kubectl apply -f k8s/04-persistent-volume-claim.yaml
kubectl apply -f k8s/05-backend-deployment.yaml
kubectl apply -f k8s/06-backend-service.yaml
kubectl apply -f k8s/07-frontend-deployment.yaml
kubectl apply -f k8s/08-frontend-service-nodeport.yaml
kubectl apply -f k8s/09-frontend-service-loadbalancer.yaml
kubectl apply -f k8s/10-externalname-service.yaml
```

Or apply all numbered files in one command; shell glob ordering preserves the
same dependency order:

```bash
kubectl apply -f k8s/
```

## Verify the deployment

Use these commands for the assignment screenshots and checks:

```bash
kubectl get all -n codegraph
kubectl get pods -n codegraph -o wide
kubectl describe configmap codegraph-config -n codegraph
kubectl get pvc -n codegraph
kubectl get svc -n codegraph
kubectl logs deployment/codegraph-backend -n codegraph
```

The `kubectl get svc` output is the best single screenshot for the assignment:
it shows all four service types together in the `TYPE` column, including
ClusterIP, NodePort, LoadBalancer, and ExternalName, along with the cluster IP,
node port, and external IP columns where applicable.

The frontend should be reachable at:

```text
http://<EC2-public-ip>:30080
```

The LoadBalancer Service is included to demonstrate the object type. On bare
k3s, its `EXTERNAL-IP` can remain `Pending`; k3s's built-in klipper load
balancer may instead assign the node's own IP.
