#!/usr/bin/env node
/**
 * Cascadia PLM Deployment Installer
 *
 * Interactive CLI tool for generating deployment configurations.
 *
 * Usage:
 *   npx tsx scripts/deploy/install.ts
 *   npm run deploy:install
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import ora from 'ora'
import chalk from 'chalk'
import { confirm } from '@inquirer/prompts'

import {
  promptCloudDatabaseConfig,
  promptCommonConfig,
  promptDeploymentType,
  promptDistributedConfig,
  promptKubernetesConfig,
  promptOutputOptions,
  promptSingleServerConfig,
} from './lib/prompts.js'

import { validateConfig } from './lib/validators/config.js'
import {
  buildConnectionString,
  validateDatabaseConnection,
} from './lib/validators/database.js'
import { maskSecret } from './lib/secrets.js'

import {
  generateCloudDatabaseEnv,
  generateDistributedEnv,
  generateKubernetesEnv,
  generateSingleServerEnv,
} from './lib/generators/env.js'

import {
  generateCloudDatabaseCompose,
  generateDistributedCompose,
  generateSingleServerCompose,
} from './lib/generators/docker-compose.js'

import { generateKubernetesManifests } from './lib/generators/kubernetes.js'
import type {
  DeploymentType,
  GeneratedFile,
  InstallerConfig,
  PreFlightCheck,
} from './lib/types.js'

/**
 * Print welcome banner
 */
function printBanner(): void {
  console.log('')
  console.log(chalk.bold.blue('  Cascadia PLM Deployment Installer'))
  console.log(chalk.gray('  ─────────────────────────────────────'))
  console.log('')
  console.log(
    chalk.gray('  This wizard will help you configure your deployment.'),
  )
  console.log(chalk.gray('  Press Ctrl+C at any time to cancel.'))
  console.log('')
}

/**
 * Gather configuration based on deployment type
 */
async function gatherConfig(
  deploymentType: DeploymentType,
): Promise<InstallerConfig> {
  const commonConfig = await promptCommonConfig()

  let specificConfig
  switch (deploymentType) {
    case 'single-server':
      specificConfig = await promptSingleServerConfig()
      break
    case 'distributed':
      specificConfig = await promptDistributedConfig()
      break
    case 'cloud-database':
      specificConfig = await promptCloudDatabaseConfig()
      break
    case 'kubernetes':
      specificConfig = await promptKubernetesConfig()
      break
  }

  const outputOptions = await promptOutputOptions(deploymentType)

  return {
    deploymentType,
    ...commonConfig,
    ...specificConfig,
    ...outputOptions,
  } as InstallerConfig
}

/**
 * Run pre-flight checks
 */
async function runPreFlightChecks(config: InstallerConfig): Promise<{
  pass: boolean
  checks: Array<PreFlightCheck>
}> {
  const checks: Array<PreFlightCheck> = []

  // 1. Validate configuration schema
  const validationResult = validateConfig(config)
  checks.push({
    name: 'Configuration',
    passed: validationResult.success,
    message: validationResult.success
      ? 'Valid configuration'
      : validationResult.errors?.join(', ') || 'Invalid configuration',
  })

  // 2. Check output directory
  try {
    const outputPath = path.resolve(config.outputDir)
    const parentDir = path.dirname(outputPath)

    if (fs.existsSync(parentDir)) {
      checks.push({
        name: 'Output Directory',
        passed: true,
        message: `Will write to ${outputPath}`,
      })
    } else {
      checks.push({
        name: 'Output Directory',
        passed: true,
        message: `Will create ${outputPath}`,
      })
    }
  } catch (error) {
    checks.push({
      name: 'Output Directory',
      passed: false,
      message: `Cannot access output directory: ${error}`,
    })
  }

  // 3. Database connection (if requested)
  if (config.validateDb) {
    let connectionString: string

    if (config.deploymentType === 'single-server') {
      const sc = config
      connectionString = buildConnectionString({
        host: 'localhost',
        port: sc.postgresPort,
        database: sc.postgresDb,
        user: sc.postgresUser,
        password: sc.postgresPassword || 'test',
      })
    } else if (config.deploymentType === 'cloud-database') {
      connectionString = config.databaseUrl
    } else if (config.deploymentType === 'kubernetes') {
      connectionString = config.databaseUrl
    } else {
      const dc = config
      connectionString = buildConnectionString({
        host: dc.infraHost,
        port: dc.postgresPort,
        database: dc.postgresDb,
        user: dc.postgresUser,
        password: dc.postgresPassword,
      })
    }

    if (connectionString) {
      const dbResult = await validateDatabaseConnection(connectionString)
      checks.push({
        name: 'Database Connection',
        passed: dbResult.success,
        message: dbResult.success
          ? 'Connected successfully'
          : dbResult.error || 'Connection failed',
      })
    }
  } else {
    checks.push({
      name: 'Database Connection',
      passed: true,
      message: 'Skipped (not requested)',
    })
  }

  // 4. Docker availability (if runDeploy requested)
  if (config.runDeploy) {
    const dockerAvailable = await checkDockerAvailable()
    checks.push({
      name: 'Docker',
      passed: dockerAvailable,
      message: dockerAvailable ? 'Docker is available' : 'Docker not found',
    })
  }

  return {
    pass: checks.every((c) => c.passed || c.name === 'Database Connection'),
    checks,
  }
}

/**
 * Check if Docker is available
 */
async function checkDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['--version'], { stdio: 'pipe', shell: true })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

/**
 * Generate deployment files based on configuration
 */
function generateFiles(config: InstallerConfig): {
  files: Array<GeneratedFile>
  credentials: Record<string, string>
} {
  let envResult
  let composeFiles: Array<GeneratedFile> = []

  switch (config.deploymentType) {
    case 'single-server':
      envResult = generateSingleServerEnv(config)
      composeFiles = [generateSingleServerCompose(config)]
      break
    case 'distributed':
      envResult = generateDistributedEnv(config)
      composeFiles = generateDistributedCompose(config)
      break
    case 'cloud-database':
      envResult = generateCloudDatabaseEnv(config)
      composeFiles = [generateCloudDatabaseCompose(config)]
      break
    case 'kubernetes':
      envResult = generateKubernetesEnv(config)
      composeFiles = generateKubernetesManifests(config)
      break
  }

  return {
    files: [...envResult.files, ...composeFiles],
    credentials: envResult.credentials,
  }
}

/**
 * Write generated files to disk
 */
function writeFiles(outputDir: string, files: Array<GeneratedFile>): void {
  const baseDir = path.resolve(outputDir)

  for (const file of files) {
    const filePath = path.join(baseDir, file.path)
    const fileDir = path.dirname(filePath)

    // Create directory if needed
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true })
    }

    // Write file
    fs.writeFileSync(filePath, file.content, 'utf-8')
  }
}

/**
 * Run docker compose up
 */
async function runDockerCompose(outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('')
    console.log(chalk.gray('  Running docker compose up -d...'))
    console.log('')

    const proc = spawn('docker', ['compose', 'up', '-d'], {
      cwd: path.resolve(outputDir),
      stdio: 'inherit',
      shell: true,
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`docker compose exited with code ${code}`))
      }
    })

    proc.on('error', (error) => {
      reject(error)
    })
  })
}

/**
 * Print summary and next steps
 */
function printSummary(
  config: InstallerConfig,
  files: Array<GeneratedFile>,
  credentials: Record<string, string>,
): void {
  console.log('')
  console.log(chalk.bold.green('  Done!'))
  console.log('')
  console.log(chalk.gray('  Files generated:'))
  for (const file of files) {
    const icon = file.isSecret ? chalk.yellow('!') : chalk.green('✓')
    const suffix = file.isSecret ? chalk.yellow(' (contains secrets)') : ''
    console.log(`    ${icon} ${file.path}${suffix}`)
  }

  if (Object.keys(credentials).length > 0) {
    console.log('')
    console.log(chalk.gray('  Auto-generated credentials:'))
    for (const [key, value] of Object.entries(credentials)) {
      console.log(`    ${chalk.cyan(key)}: ${maskSecret(value)}`)
    }
    console.log('')
    console.log(
      chalk.yellow(
        '  Save these credentials securely - they cannot be recovered!',
      ),
    )
  }

  console.log('')
  console.log(chalk.gray('  Next steps:'))

  if (config.deploymentType === 'kubernetes') {
    console.log(
      `    1. Review ${chalk.cyan('secrets.yaml')} and update with your actual secrets`,
    )
    console.log(
      `    2. Apply manifests: ${chalk.cyan(`kubectl apply -k ${config.outputDir}`)}`,
    )
    console.log(
      `    3. Check status: ${chalk.cyan(`kubectl get pods -n ${config.namespace}`)}`,
    )
  } else {
    console.log(`    1. ${chalk.cyan(`cd ${config.outputDir}`)}`)
    if (!config.runDeploy) {
      console.log(`    2. ${chalk.cyan('docker compose up -d')}`)
    }
    console.log(
      `    ${config.runDeploy ? '2' : '3'}. Access the application at ${chalk.cyan(config.baseUrl)}`,
    )
    console.log(
      `    ${config.runDeploy ? '3' : '4'}. Default login: ${chalk.cyan('admin')} / ${chalk.cyan('Cascadia')}`,
    )
  }

  console.log('')
}

/**
 * Main installer function
 */
async function main(): Promise<void> {
  printBanner()

  try {
    // Step 1: Select deployment type
    const deploymentType = await promptDeploymentType()

    // Step 2: Gather configuration
    const config = await gatherConfig(deploymentType)

    // Step 3: Run pre-flight checks
    console.log('')
    console.log(chalk.bold('  Pre-flight checks:'))
    console.log('')

    const preFlightResult = await runPreFlightChecks(config)

    for (const check of preFlightResult.checks) {
      const icon = check.passed ? chalk.green('✓') : chalk.red('✗')
      const color = check.passed ? chalk.gray : chalk.red
      console.log(`    ${icon} ${check.name}: ${color(check.message)}`)
    }

    if (!preFlightResult.pass) {
      console.log('')
      const continueAnyway = await confirm({
        message: 'Some checks failed. Continue anyway?',
        default: false,
      })

      if (!continueAnyway) {
        console.log('')
        console.log(chalk.yellow('  Aborted.'))
        console.log('')
        process.exit(1)
      }
    }

    // Step 4: Generate files
    console.log('')
    const spinner = ora('Generating configuration files...').start()

    const { files, credentials } = generateFiles(config)
    await writeFiles(config.outputDir, files)

    spinner.succeed(chalk.green('Configuration files generated'))

    // Step 5: Optionally run deployment
    if (config.runDeploy && config.deploymentType !== 'kubernetes') {
      try {
        await runDockerCompose(config.outputDir)
        console.log(chalk.green('  Deployment started successfully'))
      } catch (error) {
        console.log(chalk.red(`  Deployment failed: ${error}`))
      }
    }

    // Step 6: Print summary
    printSummary(config, files, credentials)
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('')
      console.log(chalk.yellow('  Cancelled.'))
      console.log('')
      process.exit(0)
    }

    console.error('')
    console.error(chalk.red('  Error:'), error)
    console.error('')
    process.exit(1)
  }
}

// Run the installer
main()
