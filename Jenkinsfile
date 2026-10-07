pipeline {
    agent any

    stages {

        stage('Checkout') {
            steps {
                checkout scm
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
                        --severity CRITICAL \
                        --exit-code 1 \
                        codegraph-backend:${BUILD_NUMBER}

                    echo "Scanning frontend image..."
                    trivy \
                        --config /dev/null \
                        --ignorefile /dev/null \
                        image \
                        --scanners vuln \
                        --severity CRITICAL \
                        --exit-code 1 \
                        codegraph-frontend:${BUILD_NUMBER}
                '''
            }
        }
    }

    post {
        always {
            sh '''
                rm -rf backend/.ci-venv
            '''
        }

        success {
            echo 'CI pipeline completed successfully.'
        }

        failure {
            echo 'CI pipeline failed. Check the stage logs above.'
        }
    }
}
