pipeline {
    agent any

    // Build automatically when GitHub sends a push webhook to /github-webhook/.
    // Requires the GitHub plugin; the job's SCM branch specifier (*/main)
    // limits builds to pushes that change main.
    triggers {
        githubPush()
    }

    options {
        // One build at a time on the resource-constrained EC2 host.
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    // Dashboard links shown in the build log and build description.
    // Override any of these via Manage Jenkins -> System -> Global properties
    // -> Environment variables (e.g. once the unified reverse-proxy URLs exist).
    environment {
        APP_URL        = "${env.CODEGRAPH_APP_URL ?: 'http://13.206.56.253:30081'}"
        JENKINS_UI_URL = "${env.CODEGRAPH_JENKINS_URL ?: 'http://13.206.56.253:8080'}"
        PROMETHEUS_URL = "${env.CODEGRAPH_PROMETHEUS_URL ?: 'http://localhost:9091'}"
        GRAFANA_URL    = "${env.CODEGRAPH_GRAFANA_URL ?: 'http://localhost:3001'}"
        MONITORING_URL_NOTE = "${env.CODEGRAPH_MONITORING_NOTE ?: '(requires the local SSH tunnel)'}"
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                sh '''
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

                    python3 -m venv .ci-venv
                    . .ci-venv/bin/activate

                    python -m pip install --upgrade pip
                    pip install -r requirements-dev.txt

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

        stage('Frontend Build') {
            steps {
                sh '''
                    set -eu

                    cd frontend
                    npm run build
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

                    echo "Deploying CodeGraph to Kubernetes..."

                    export HOME=/var/lib/jenkins

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
            sh '''
                rm -rf backend/.ci-venv
            '''

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
                def shortCommit = env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : 'unknown'
                currentBuild.description = "${shortCommit} | App: ${env.APP_URL} | Grafana: ${env.GRAFANA_URL}"
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