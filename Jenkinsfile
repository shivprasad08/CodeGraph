pipeline {
    agent any

    // Trigger automatically when GitHub sends a push webhook.
    triggers {
        githubPush()
    }

    options {
        // Checkout explicitly in the Checkout stage only once.
        skipDefaultCheckout(true)

        // Protect the small EC2 instance from concurrent builds.
        disableConcurrentBuilds()

        // Keep the latest 20 builds.
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    environment {
        APP_URL = "${env.CODEGRAPH_APP_URL ?: 'http://13.206.56.253:30081'}"
        JENKINS_UI_URL = "${env.CODEGRAPH_JENKINS_URL ?: 'http://13.206.56.253:8080'}"
        PROMETHEUS_URL = "${env.CODEGRAPH_PROMETHEUS_URL ?: 'http://localhost:9091'}"
        GRAFANA_URL = "${env.CODEGRAPH_GRAFANA_URL ?: 'http://localhost:3001'}"
        MONITORING_URL_NOTE = "${env.CODEGRAPH_MONITORING_NOTE ?: '(requires the local SSH tunnel)'}"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm

                sh '''
                    set -eu
                    echo "Branch: ${GIT_BRANCH:-unknown}"
                    echo "Commit: ${GIT_COMMIT:-unknown}"
                    git log -1 --oneline
                '''
            }
        }

        stage('Backend Tests') {
            steps {
                sh '''
                    set -eu
                    cd backend

                    # Reuse the virtual environment between builds.
                    if [ ! -x .ci-venv/bin/python ]; then
                        python3 -m venv .ci-venv
                    fi

                    . .ci-venv/bin/activate

                    # Install only missing or changed dependencies.
                    python -m pip install \
                        --disable-pip-version-check \
                        -r requirements-dev.txt

                    cd ..
                    pytest -q
                '''
            }
        }

        stage('Frontend Tests') {
            steps {
                sh '''
                    set -eu
                    cd frontend

                    npm ci
                    npm test
                '''
            }
        }

        // The production frontend build is performed by the
        // frontend Dockerfile, so a separate npm run build is redundant.
        stage('Docker Build') {
            steps {
                sh '''
                    set -eu

                    docker build \
                        -t codegraph-backend:${BUILD_NUMBER} \
                        ./backend

                    docker build \
                        -t codegraph-frontend:${BUILD_NUMBER} \
                        ./frontend
                '''
            }
        }

        stage('Trivy Security Scan') {
            steps {
                sh '''
                    set -eu

                    echo "Scanning backend image..."

                    trivy \
                        --config /dev/null \
                        --ignorefile /dev/null \
                        image \
                        --scanners vuln \
                        --severity HIGH,CRITICAL \
                        --ignore-unfixed \
                        --exit-code 1 \
                        codegraph-backend:${BUILD_NUMBER}

                    echo "Scanning frontend image..."

                    trivy \
                        --config /dev/null \
                        --ignorefile /dev/null \
                        image \
                        --scanners vuln \
                        --severity HIGH,CRITICAL \
                        --ignore-unfixed \
                        --exit-code 1 \
                        codegraph-frontend:${BUILD_NUMBER}
                '''
            }
        }

        stage('Push Images') {
            steps {
                sh '''
                    set -eu

                    echo "Tagging images for local registry..."

                    docker tag \
                        codegraph-backend:${BUILD_NUMBER} \
                        localhost:5000/codegraph-backend:${BUILD_NUMBER}

                    docker tag \
                        codegraph-frontend:${BUILD_NUMBER} \
                        localhost:5000/codegraph-frontend:${BUILD_NUMBER}

                    echo "Pushing backend image..."
                    docker push \
                        localhost:5000/codegraph-backend:${BUILD_NUMBER}

                    echo "Pushing frontend image..."
                    docker push \
                        localhost:5000/codegraph-frontend:${BUILD_NUMBER}

                    echo "Images pushed successfully."
                '''
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                sh '''
                    set -eu

                    export HOME=/var/lib/jenkins
                    export KUBECONFIG=/var/lib/jenkins/.kube/config

                    echo "Checking Kubernetes access..."
                    echo "Checking Kubernetes access with retries..."
                    for attempt in 1 2 3 4 5; do
                        if kubectl get nodes --request-timeout=15s; then
                            echo "Kubernetes API is responding."
                            break
                        fi

                        if [ "$attempt" -eq 5 ]; then
                            echo "Kubernetes API remained unavailable after 5 attempts."
                            exit 1
                        fi

                        echo "Attempt $attempt failed; retrying in 10 seconds..."
                        sleep 10
                    done

                    echo "Deploying CodeGraph with Helm..."

                    helm upgrade --install codegraph \
                        "$WORKSPACE/helm/codegraph" \
                        --namespace codegraph \
                        --set backend.image=localhost:5000/codegraph-backend:${BUILD_NUMBER} \
                        --set frontend.image=localhost:5000/codegraph-frontend:${BUILD_NUMBER} \
                        --wait \
                        --timeout 5m

                    echo "Helm deployment completed."
                '''
            }
        }
    }

    post {
        always {
            echo """
==================== CodeGraph dashboards ====================
Build result : ${currentBuild.currentResult}
Commit       : ${env.GIT_COMMIT ?: 'unknown'}
CodeGraph    : ${env.APP_URL}
Jenkins build: ${env.BUILD_URL ?: env.JENKINS_UI_URL}
Prometheus   : ${env.PROMETHEUS_URL} ${env.MONITORING_URL_NOTE}
Grafana      : ${env.GRAFANA_URL} ${env.MONITORING_URL_NOTE}
=============================================================="""

            script {
                def shortCommit = env.GIT_COMMIT
                    ? env.GIT_COMMIT.take(7)
                    : 'unknown'

                currentBuild.description =
                    "${shortCommit} | App: ${env.APP_URL} | Grafana: ${env.GRAFANA_URL}"
            }
        }

        success {
            echo 'CI pipeline completed successfully.'
        }

        failure {
            echo 'CI pipeline failed. Check the stage logs above.'
        }
    }
}