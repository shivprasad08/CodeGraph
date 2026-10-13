pipeline {
    agent any

    triggers {
        githubPush()
    }

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
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

                script {
                    env.CODEGRAPH_COMMIT = sh(
                        script: 'git rev-parse HEAD',
                        returnStdout: true
                    ).trim()

                    env.CODEGRAPH_BRANCH = sh(
                        script: "git branch -r --contains HEAD | sed -n 's#^[[:space:]]*origin/##p' | head -n 1 || true",
                        returnStdout: true
                    ).trim()

                    if (!env.CODEGRAPH_BRANCH) {
                        env.CODEGRAPH_BRANCH = 'main'
                    }
                }

                sh '''
                    set -eu
                    echo "Branch: ${CODEGRAPH_BRANCH}"
                    echo "Commit: ${CODEGRAPH_COMMIT}"
                    git log -1 --oneline
                '''
            }
        }

        stage('Backend Tests') {
            steps {
                sh '''
                    set -eu
                    cd backend

                    if [ ! -x .ci-venv/bin/python ]; then
                        python3 -m venv .ci-venv
                    fi

                    . .ci-venv/bin/activate

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

                    echo "Waiting for Kubernetes API and nodes to be Ready..."

                    ready_streak=0
                    attempt=1
                    error_file="$(mktemp)"
                    trap 'rm -f "$error_file"' EXIT

                    # Require two consecutive successful checks where
                    # every Kubernetes node reports Ready.
                    while [ "$attempt" -le 10 ]; do

                        if node_output=$(kubectl get nodes \
                            --no-headers \
                            --request-timeout=10s \
                            2>"$error_file"); then

                            if [ -n "$node_output" ] && \
                                printf '%s\\n' "$node_output" | \
                                awk 'NF {
                                    count++
                                    if ($2 != "Ready") bad=1
                                }
                                END {
                                    exit (count == 0 || bad)
                                }'; then

                                ready_streak=$((ready_streak + 1))

                                echo "Attempt $attempt: all nodes Ready ($ready_streak/2 consecutive checks)."

                                if [ "$ready_streak" -ge 2 ]; then
                                    break
                                fi
                            else
                                ready_streak=0

                                echo "Attempt $attempt: API responded, but at least one node is not Ready."
                                printf '%s\\n' "$node_output"
                            fi
                        else
                            ready_streak=0

                            echo "Attempt $attempt: Kubernetes API request failed."
                            cat "$error_file" || true
                        fi

                        if [ "$attempt" -eq 10 ]; then
                            echo "ERROR: Kubernetes did not remain Ready after 10 attempts."
                            kubectl get nodes -o wide \
                                --request-timeout=10s || true
                            exit 1
                        fi

                        attempt=$((attempt + 1))
                        sleep 5
                    done

                    echo "Kubernetes readiness confirmed."

                    echo "Deploying CodeGraph with Helm..."

                    helm upgrade --install codegraph \
                        "$WORKSPACE/helm/codegraph" \
                        --namespace codegraph \
                        --set backend.image=localhost:5000/codegraph-backend:${BUILD_NUMBER} \
                        --set frontend.image=localhost:5000/codegraph-frontend:${BUILD_NUMBER} \
                        --wait \
                        --timeout 8m

                    echo "Verifying backend rollout..."
                    kubectl rollout status \
                        deployment/codegraph-backend \
                        -n codegraph \
                        --timeout=120s

                    echo "Verifying frontend rollout..."
                    kubectl rollout status \
                        deployment/codegraph-frontend \
                        -n codegraph \
                        --timeout=120s

                    kubectl get pods -n codegraph -o wide

                    echo "Helm deployment and rollout verification completed."
                '''
            }
        }
    }

    post {
        always {
            echo """
==================== CodeGraph dashboards ====================
Build result : ${currentBuild.currentResult}
Branch       : ${env.CODEGRAPH_BRANCH ?: 'unknown'}
Commit       : ${env.CODEGRAPH_COMMIT ?: 'unknown'}
CodeGraph    : ${env.APP_URL}
Jenkins build: ${env.BUILD_URL ?: env.JENKINS_UI_URL}
Prometheus   : ${env.PROMETHEUS_URL} ${env.MONITORING_URL_NOTE}
Grafana      : ${env.GRAFANA_URL} ${env.MONITORING_URL_NOTE}
=============================================================="""

            script {
                def shortCommit = env.CODEGRAPH_COMMIT
                    ? env.CODEGRAPH_COMMIT.take(7)
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