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