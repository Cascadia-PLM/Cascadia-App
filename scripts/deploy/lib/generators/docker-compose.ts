/**
 * Docker Compose file generators for each deployment type
 */

import YAML from 'yaml'
import type {
  CloudDatabaseConfig,
  DistributedConfig,
  GeneratedFile,
  SingleServerConfig,
} from '../types.js'

/**
 * Generate docker-compose.yml for single-server deployment
 */
export function generateSingleServerCompose(
  config: SingleServerConfig,
): GeneratedFile {
  const compose: Record<string, unknown> = {
    name: 'cascadia',
    services: {
      postgres: {
        image: 'postgres:18-alpine',
        restart: 'unless-stopped',
        environment: {
          POSTGRES_DB: '${POSTGRES_DB}',
          POSTGRES_USER: '${POSTGRES_USER}',
          POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
        },
        ports: ['${POSTGRES_PORT:-5432}:5432'],
        volumes: ['postgres_data:/var/lib/postgresql/data'],
        healthcheck: {
          test: [
            'CMD-SHELL',
            'pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}',
          ],
          interval: '10s',
          timeout: '5s',
          retries: 5,
        },
        networks: ['cascadia-network'],
      },
      app: {
        build: {
          context: '.',
          dockerfile: 'docker/app.Dockerfile',
          target: 'production',
        },
        restart: 'unless-stopped',
        environment: {
          NODE_ENV: '${NODE_ENV}',
          DATABASE_URL: '${DATABASE_URL}',
          SESSION_SECRET: '${SESSION_SECRET}',
          BASE_URL: '${BASE_URL}',
          VAULT_MODE: '${VAULT_MODE:-embedded}',
          VAULT_TYPE: '${VAULT_TYPE:-local}',
          VAULT_ROOT: '${VAULT_ROOT:-/app/vault}',
          JOBS_MODE: '${JOBS_MODE:-embedded}',
        },
        ports: ['${APP_PORT:-3000}:3000'],
        volumes: ['app_storage:/app/storage', 'app_vault:/app/vault'],
        depends_on: {
          postgres: { condition: 'service_healthy' },
        },
        command: 'sh -c "npx drizzle-kit push --force && npm run serve"',
        healthcheck: {
          test: [
            'CMD',
            'wget',
            '-q',
            '--spider',
            'http://localhost:3000/api/health',
          ],
          interval: '30s',
          timeout: '10s',
          retries: 3,
          start_period: '40s',
        },
        networks: ['cascadia-network'],
      },
    },
    volumes: {
      postgres_data: {},
      app_storage: {},
      app_vault: {},
    },
    networks: {
      'cascadia-network': {
        driver: 'bridge',
      },
    },
  }

  // Add pgAdmin if requested
  if (config.includePgAdmin) {
    ;(compose.services as Record<string, unknown>).pgadmin = {
      image: 'dpage/pgadmin4:latest',
      restart: 'unless-stopped',
      profiles: ['tools'],
      environment: {
        PGADMIN_DEFAULT_EMAIL: '${PGADMIN_EMAIL:-admin@cascadia.local}',
        PGADMIN_DEFAULT_PASSWORD: '${PGADMIN_PASSWORD}',
        PGADMIN_LISTEN_PORT: 80,
      },
      ports: ['${PGADMIN_PORT:-5050}:80'],
      volumes: ['pgadmin_data:/var/lib/pgadmin'],
      depends_on: ['postgres'],
      networks: ['cascadia-network'],
    }
    ;(compose.volumes as Record<string, unknown>).pgadmin_data = {}
  }

  const content = YAML.stringify(compose, { lineWidth: 0 })
  return { path: 'docker-compose.yml', content }
}

/**
 * Generate docker-compose files for distributed deployment
 */
export function generateDistributedCompose(
  config: DistributedConfig,
): Array<GeneratedFile> {
  const files: Array<GeneratedFile> = []

  // Infrastructure docker-compose
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'infrastructure'
  ) {
    const infraCompose: Record<string, unknown> = {
      name: 'cascadia-infrastructure',
      services: {
        postgres: {
          image: 'postgres:18-alpine',
          restart: 'unless-stopped',
          environment: {
            POSTGRES_DB: '${POSTGRES_DB}',
            POSTGRES_USER: '${POSTGRES_USER}',
            POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
          },
          ports: ['${POSTGRES_PORT:-5432}:5432'],
          volumes: ['postgres_data:/var/lib/postgresql/data'],
          command: [
            'postgres',
            '-c',
            "listen_addresses='*'",
            '-c',
            'max_connections=200',
            '-c',
            'shared_buffers=256MB',
          ],
          healthcheck: {
            test: [
              'CMD-SHELL',
              'pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}',
            ],
            interval: '10s',
            timeout: '5s',
            retries: 5,
          },
          networks: ['cascadia-infra'],
        },
        rabbitmq: {
          image: 'rabbitmq:3-management-alpine',
          restart: 'unless-stopped',
          environment: {
            RABBITMQ_DEFAULT_USER: '${RABBITMQ_USER}',
            RABBITMQ_DEFAULT_PASS: '${RABBITMQ_PASSWORD}',
            RABBITMQ_DEFAULT_VHOST: '${RABBITMQ_VHOST}',
          },
          ports: ['5672:5672', '15672:15672'],
          volumes: ['rabbitmq_data:/var/lib/rabbitmq'],
          healthcheck: {
            test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping'],
            interval: '30s',
            timeout: '10s',
            retries: 5,
          },
          networks: ['cascadia-infra'],
        },
        minio: {
          image: 'minio/minio:latest',
          restart: 'unless-stopped',
          environment: {
            MINIO_ROOT_USER: '${MINIO_ROOT_USER}',
            MINIO_ROOT_PASSWORD: '${MINIO_ROOT_PASSWORD}',
          },
          ports: ['9000:9000', '9001:9001'],
          volumes: ['minio_data:/data'],
          command: 'server /data --console-address ":9001"',
          healthcheck: {
            test: ['CMD', 'mc', 'ready', 'local'],
            interval: '30s',
            timeout: '10s',
            retries: 3,
          },
          networks: ['cascadia-infra'],
        },
      },
      volumes: {
        postgres_data: {},
        rabbitmq_data: {},
        minio_data: {},
      },
      networks: {
        'cascadia-infra': {
          driver: 'bridge',
        },
      },
    }

    // Add pgAdmin if requested
    if (config.includePgAdmin) {
      ;(infraCompose.services as Record<string, unknown>).pgadmin = {
        image: 'dpage/pgadmin4:latest',
        restart: 'unless-stopped',
        profiles: ['tools'],
        environment: {
          PGADMIN_DEFAULT_EMAIL: '${PGADMIN_EMAIL:-admin@cascadia.local}',
          PGADMIN_DEFAULT_PASSWORD: '${PGADMIN_PASSWORD}',
        },
        ports: ['5050:80'],
        volumes: ['pgadmin_data:/var/lib/pgadmin'],
        depends_on: ['postgres'],
        networks: ['cascadia-infra'],
      }
      ;(infraCompose.volumes as Record<string, unknown>).pgadmin_data = {}
    }

    files.push({
      path: 'infrastructure/docker-compose.yml',
      content: YAML.stringify(infraCompose, { lineWidth: 0 }),
    })
  }

  // App docker-compose
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'app'
  ) {
    const appCompose: Record<string, unknown> = {
      name: 'cascadia-app',
      services: {
        app: {
          image: 'cascadia/app:${APP_VERSION:-latest}',
          restart: 'unless-stopped',
          environment: {
            NODE_ENV: '${NODE_ENV}',
            DATABASE_URL: '${DATABASE_URL}',
            SESSION_SECRET: '${SESSION_SECRET}',
            BASE_URL: '${BASE_URL}',
            VAULT_MODE: '${VAULT_MODE:-embedded}',
            VAULT_TYPE: '${VAULT_TYPE:-s3}',
            S3_ENDPOINT: '${S3_ENDPOINT}',
            S3_ACCESS_KEY: '${S3_ACCESS_KEY}',
            S3_SECRET_KEY: '${S3_SECRET_KEY}',
            S3_BUCKET: '${S3_BUCKET}',
            JOBS_MODE: '${JOBS_MODE:-service}',
            RABBITMQ_URL: '${RABBITMQ_URL}',
          },
          ports: ['${APP_PORT:-3000}:3000'],
          healthcheck: {
            test: [
              'CMD',
              'wget',
              '-q',
              '--spider',
              'http://localhost:3000/api/health',
            ],
            interval: '30s',
            timeout: '10s',
            retries: 3,
            start_period: '40s',
          },
          networks: ['cascadia-app'],
        },
      },
      networks: {
        'cascadia-app': {
          driver: 'bridge',
        },
      },
    }

    files.push({
      path: 'app/docker-compose.yml',
      content: YAML.stringify(appCompose, { lineWidth: 0 }),
    })
  }

  // Jobs docker-compose
  if (
    config.distributedComponent === 'all' ||
    config.distributedComponent === 'jobs'
  ) {
    const jobsCompose: Record<string, unknown> = {
      name: 'cascadia-jobs',
      services: {
        worker: {
          image: 'cascadia/jobs:${JOBS_VERSION:-latest}',
          restart: 'unless-stopped',
          environment: {
            NODE_ENV: '${NODE_ENV}',
            DATABASE_URL: '${DATABASE_URL}',
            RABBITMQ_URL: '${RABBITMQ_URL}',
            S3_ENDPOINT: '${S3_ENDPOINT}',
            S3_ACCESS_KEY: '${S3_ACCESS_KEY}',
            S3_SECRET_KEY: '${S3_SECRET_KEY}',
            S3_BUCKET: '${S3_BUCKET}',
            WORKER_CONCURRENCY: '${WORKER_CONCURRENCY:-5}',
            JOB_TYPES: '${JOB_TYPES:-*}',
            JOB_TIMEOUT: '${JOB_TIMEOUT:-300000}',
          },
          deploy: {
            replicas: '${WORKER_REPLICAS:-2}',
          },
          healthcheck: {
            test: [
              'CMD',
              'wget',
              '-q',
              '--spider',
              'http://localhost:3002/health',
            ],
            interval: '30s',
            timeout: '10s',
            retries: 3,
          },
          networks: ['cascadia-jobs'],
        },
      },
      networks: {
        'cascadia-jobs': {
          driver: 'bridge',
        },
      },
    }

    files.push({
      path: 'jobs/docker-compose.yml',
      content: YAML.stringify(jobsCompose, { lineWidth: 0 }),
    })
  }

  return files
}

/**
 * Generate docker-compose.yml for cloud database deployment
 */
export function generateCloudDatabaseCompose(
  config: CloudDatabaseConfig,
): GeneratedFile {
  const compose: Record<string, unknown> = {
    name: 'cascadia',
    services: {
      app: {
        image: 'cascadia/app:${APP_VERSION:-latest}',
        restart: 'unless-stopped',
        environment: {
          NODE_ENV: '${NODE_ENV}',
          DATABASE_URL: '${DATABASE_URL}',
          SESSION_SECRET: '${SESSION_SECRET}',
          BASE_URL: '${BASE_URL}',
          VAULT_MODE: '${VAULT_MODE:-embedded}',
          VAULT_TYPE: '${VAULT_TYPE:-local}',
          JOBS_MODE: '${JOBS_MODE:-embedded}',
        },
        ports: ['${APP_PORT:-3000}:3000'],
        healthcheck: {
          test: [
            'CMD',
            'wget',
            '-q',
            '--spider',
            'http://localhost:3000/api/health',
          ],
          interval: '30s',
          timeout: '10s',
          retries: 3,
          start_period: '40s',
        },
        networks: ['cascadia-network'],
      },
    },
    networks: {
      'cascadia-network': {
        driver: 'bridge',
      },
    },
  }

  // Add volume and env vars based on vault type
  const appService = (
    compose.services as Record<string, Record<string, unknown>>
  ).app
  if (config.vaultType === 'local') {
    appService.environment = {
      ...(appService.environment as Record<string, unknown>),
      VAULT_ROOT: '${VAULT_ROOT:-/app/vault}',
    }
    appService.volumes = ['app_storage:/app/storage', 'app_vault:/app/vault']
    compose.volumes = {
      app_storage: {},
      app_vault: {},
    }
  } else {
    appService.environment = {
      ...(appService.environment as Record<string, unknown>),
      S3_BUCKET: '${S3_BUCKET}',
      S3_REGION: '${S3_REGION}',
      S3_ACCESS_KEY: '${S3_ACCESS_KEY}',
      S3_SECRET_KEY: '${S3_SECRET_KEY}',
    }
    if (config.s3Endpoint) {
      appService.environment = {
        ...(appService.environment as Record<string, unknown>),
        S3_ENDPOINT: '${S3_ENDPOINT}',
      }
    }
  }

  const content = YAML.stringify(compose, { lineWidth: 0 })
  return { path: 'docker-compose.yml', content }
}
