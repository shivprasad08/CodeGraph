pipeline {
    agent any

    stages {
        stage('Pull latest code') {
            steps {
                sh '''
                    cd /home/shivprasad/CodeGraph
                    git pull origin main
                '''
            }
        }
        stage('Deploy') {
            steps {
                sh '''
                    cd /home/shivprasad/CodeGraph
                    docker compose down
                    docker compose up -d --build
                '''
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    cd /home/shivprasad/CodeGraph
                    docker ps
                '''
            }
        }
    }
}
