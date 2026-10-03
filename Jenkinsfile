pipeline {
    agent any

    environment {
        ANSIBLE_CONFIG = "${WORKSPACE}/ansible/ansible.cfg"
        ANSIBLE_INVENTORY = "${WORKSPACE}/ansible/inventory.ini"
        ANSIBLE_PLAYBOOK = "${WORKSPACE}/ansible/playbook.yml"
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Validate AWS deployment') {
            steps {
                sh '''
                    set -eu
                    test -f "$ANSIBLE_INVENTORY"
                    test -f "$ANSIBLE_PLAYBOOK"
                    ansible-inventory -i "$ANSIBLE_INVENTORY" --graph
                    ansible-playbook -i "$ANSIBLE_INVENTORY" "$ANSIBLE_PLAYBOOK" --syntax-check
                '''
            }
        }

        stage('Deploy to AWS EC2') {
            steps {
                withCredentials([
                    sshUserPrivateKey(
                        credentialsId: 'codegraph-aws-ssh',
                        keyFileVariable: 'AWS_SSH_KEY'
                    ),
                    string(
                        credentialsId: 'codegraph-github-token',
                        variable: 'GITHUB_TOKEN'
                    ),
                    string(
                        credentialsId: 'codegraph-groq-api-key',
                        variable: 'GROQ_API_KEY'
                    ),
                    string(
                        credentialsId: 'codegraph-mistral-api-key',
                        variable: 'MISTRAL_API_KEY'
                    )
                ]) {
                    sh '''
                        set -eu
                        chmod 600 "$AWS_SSH_KEY"
                        ansible-playbook \
                            -i "$ANSIBLE_INVENTORY" \
                            "$ANSIBLE_PLAYBOOK" \
                            --private-key "$AWS_SSH_KEY"
                    '''
                }
            }
        }

        stage('Verify deployment') {
            steps {
                withCredentials([
                    sshUserPrivateKey(
                        credentialsId: 'codegraph-aws-ssh',
                        keyFileVariable: 'AWS_SSH_KEY'
                    )
                ]) {
                    sh '''
                        set -eu
                        ansible codegraph \
                            -i "$ANSIBLE_INVENTORY" \
                            --private-key "$AWS_SSH_KEY" \
                            -m shell \
                            -a 'docker compose -f /opt/codegraph/docker-compose.yml ps'
                    '''
                }
            }
        }
    }
}
