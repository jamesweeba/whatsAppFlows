pipeline {
    agent {
        label "docker3"
    }
    environment {
        DOCKERHUB_CRED      = credentials('DOCKERHUB_CRED')
        REG_AML_CRED        = credentials('REG_AML_CRED')
        USER_CREDENTIALS    = credentials('dev-swarm-manager-user-password')
        SERVICE             = "whatsappflows"
        STACK               = "test"
        registry_URL        = "reg-aml.esoko.com"

        // Dev image
        IMAGE_BACKEND       = "reg-aml.esoko.com/deveops-test.img/whatsappflows-backend"
        TAG                 = "alpha"

        // Prod image
        imageName_BACKEND   = "reg-aml.esoko.com/deveops-test.img/whatsappflows-backend"

        imageTag            = "${env.BUILD_ID}"
    }

    triggers {
        githubPush()
    }

    stages {

        stage('Init Environment') {
            steps {
                script {
                    env.TAG_NAME = sh(script: "git tag --points-at=HEAD || echo 'none'", returnStdout: true).trim()
                    echo "TAG_NAME = ${env.TAG_NAME}"
                }
            }
        }

        stage("Trivy Repo Scan") {
            steps {
                script {
                    echo "Running Trivy File System Scan (pre-build)..."
                    sh """
                        mkdir -p trivy-reports

                        docker run --rm \
                          -v \$(pwd):/src \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 fs /src \
                          --exit-code 0 \
                          --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
                          --format json \
                          --output /reports/trivy-fs-report.json

                        docker run --rm \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 convert \
                          --format template --template "@/contrib/html.tpl" \
                          --output /reports/trivy-fs-report.html \
                          /reports/trivy-fs-report.json
                    """
                }
            }
            post {
                always {
                    publishHTML(target: [
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'trivy-reports',
                        reportFiles: 'trivy-fs-report.html',
                        reportName: 'Trivy Repo (FS) Scan'
                    ])
                    archiveArtifacts artifacts: 'trivy-reports/trivy-fs-report.*', fingerprint: true
                }
            }
        }

        stage("Build and Push - Dev") {
            when {
                anyOf { branch 'develop'; branch 'Sprint*'; branch 'Hotfix*'; branch 'master'; branch 'main'; branch 'sprint*'; branch 'feature/*'; branch 'cicd-feature/*' }
            }
            steps {
                sh "echo '${REG_AML_CRED_PSW}' | docker login -u ${REG_AML_CRED_USR} --password-stdin ${registry_URL}"
                sh "docker build -f Dockerfile -t ${env.IMAGE_BACKEND}:${env.TAG} ."
                sh "docker push ${env.IMAGE_BACKEND}:${env.TAG}"
            }
        }

        stage("Prune after Dev build") {
            when {
                anyOf { branch 'develop'; branch 'Sprint*'; branch 'Hotfix*'; branch 'master'; branch 'main'; branch 'sprint*'; branch 'feature/*'; branch 'cicd-feature/*' }
            }
            steps {
                sh "docker system prune -f"
            }
        }

        stage("Trivy Image Scan Dev") {
            when {
                anyOf { branch 'develop'; branch 'Sprint*'; branch 'Hotfix*'; branch 'master'; branch 'main'; branch 'sprint*'; branch 'feature/*'; branch 'cicd-feature/*' }
            }
            steps {
                script {
                    echo "Running Trivy Image Scan (post-build)..."
                    sh """
                        mkdir -p trivy-reports

                        docker run --rm \
                          -v /var/run/docker.sock:/var/run/docker.sock \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 image \
                          --username ${REG_AML_CRED_USR} \
                          --password ${REG_AML_CRED_PSW} \
                          --exit-code 0 \
                          --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
                          --format json \
                          --output /reports/trivy-backend-image-report.json \
                          ${env.IMAGE_BACKEND}:${env.TAG}

                        docker run --rm \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 convert \
                          --format template --template "@/contrib/html.tpl" \
                          --output /reports/trivy-backend-image-report.html \
                          /reports/trivy-backend-image-report.json
                    """
                }
            }
            post {
                always {
                    publishHTML(target: [
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'trivy-reports',
                        reportFiles: 'trivy-backend-image-report.html',
                        reportName: 'Trivy Image Scan - Backend'
                    ])
                    archiveArtifacts artifacts: 'trivy-reports/trivy-backend-image-report.*', fingerprint: true

                    script {
                        def c = 0, h = 0, m = 0
                        try {
                            c = sh(script: "jq '[.Results[] | select(.Vulnerabilities != null) | .Vulnerabilities[] | select(.Severity==\"CRITICAL\")] | length' trivy-reports/trivy-backend-image-report.json 2>/dev/null || echo 0", returnStdout: true).trim().toInteger()
                            h = sh(script: "jq '[.Results[] | select(.Vulnerabilities != null) | .Vulnerabilities[] | select(.Severity==\"HIGH\")] | length' trivy-reports/trivy-backend-image-report.json 2>/dev/null || echo 0", returnStdout: true).trim().toInteger()
                            m = sh(script: "jq '[.Results[] | select(.Vulnerabilities != null) | .Vulnerabilities[] | select(.Severity==\"MEDIUM\")] | length' trivy-reports/trivy-backend-image-report.json 2>/dev/null || echo 0", returnStdout: true).trim().toInteger()
                        } catch (Exception e) {
                            echo "Warning: Could not count backend vulnerabilities: ${e.message}"
                        }

                        def color  = (c > 0) ? '#FF0000' : (h > 0) ? '#FFA500' : (m > 0) ? '#FFD700' : '#36a64f'
                        def status = (c > 0) ? '*CRITICAL VULNERABILITIES FOUND*' : (h > 0) ? 'High severity vulnerabilities found' : (m > 0) ? 'Medium severity vulnerabilities found' : 'No critical, high, or medium vulnerabilities'
                        def branchName = env.GIT_BRANCH ?: sh(script: 'git rev-parse --abbrev-ref HEAD', returnStdout: true).trim()

                        // slackSend(
                        //     color: color,
                        //     message: """
                        //     *Security Scan Completed for* `${env.SERVICE} - ${branchName}`
                        //     ${status}
                        //
                        //     *Backend:* CRITICAL: ${c} | HIGH: ${h} | MEDIUM: ${m}
                        //
                        //     📊 [Backend Report](${env.BUILD_URL}Trivy_Image_Scan_-_Backend/)
                        //     """.stripIndent(),
                        //     channel: '#devops-notify'
                        // )
                    }
                }
            }
        }

        stage("Build - prod") {
            when { tag "v*" }
            steps {
                sh "docker build -f Dockerfile -t ${env.imageName_BACKEND}:${env.TAG_NAME} ."
            }
        }

        stage("Trivy Image Scan - PROD") {
            when { tag "v*" }
            steps {
                script {
                    echo "Running Trivy Image Scan for PROD image..."
                    sh """
                        mkdir -p trivy-reports

                        docker run --rm \
                          -v /var/run/docker.sock:/var/run/docker.sock \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 image \
                          --exit-code 0 \
                          --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
                          --format json \
                          --output /reports/trivy-prod-backend-image-report.json \
                          ${env.imageName_BACKEND}:${env.TAG_NAME}

                        docker run --rm \
                          -v \$(pwd)/trivy-reports:/reports \
                          reg-aml.esoko.com/develop.esoko/trivy:0.69.3 convert \
                          --format template --template "@/contrib/html.tpl" \
                          --output /reports/trivy-prod-backend-image-report.html \
                          /reports/trivy-prod-backend-image-report.json
                    """
                }
            }
            post {
                always {
                    publishHTML(target: [
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'trivy-reports',
                        reportFiles: 'trivy-prod-backend-image-report.html',
                        reportName: 'Trivy PROD Image Scan - Backend'
                    ])
                    archiveArtifacts artifacts: 'trivy-reports/trivy-prod-backend-image-report.*', fingerprint: true
                }
            }
        }

        stage("release") {
            when { tag "v*" }
            steps {
                sh "echo '${REG_AML_CRED_PSW}' | docker login -u ${REG_AML_CRED_USR} --password-stdin ${registry_URL}"
                sh "docker push ${env.imageName_BACKEND}:${env.TAG_NAME}"
            }
        }
    }

    post {
        // success {
        //     script {
        //         slackSend(
        //             color: '#00FF00',
        //             message: "Build succeeded: ${currentBuild.fullDisplayName}",
        //             channel: '#devops-notify'
        //         )
        //     }
        // }
        // failure {
        //     script {
        //         slackSend(
        //             color: '#FF0000',
        //             message: "Build FAILED: ${currentBuild.fullDisplayName}\nLogs: ${env.BUILD_URL}",
        //             channel: '#devops-notify'
        //         )
        //     }
        // }
        always {
            cleanWs(
                cleanWhenNotBuilt: false,
                deleteDirs: true,
                disableDeferredWipeout: true,
                notFailBuild: true,
                patterns: [[pattern: '.gitignore', type: 'INCLUDE'],
                           [pattern: '.propsfile', type: 'EXCLUDE']]
            )
        }
    }
}
