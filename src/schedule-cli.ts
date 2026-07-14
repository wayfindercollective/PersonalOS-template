import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import {
  initDatabase,
  createTask,
  getAllTasks,
  deleteTask,
  setTaskStatus,
  setTaskModel,
  setTaskOneShot,
} from './db.js'
import { resolveTaskModel } from './models.js'

function usage(): void {
  console.log(`
Usage: node dist/schedule-cli.js <command> [args]

Commands:
  create "<prompt>" "<cron>" <chat_id> [model] [--one-shot]   Create a new scheduled task
  list                                            List all tasks
  delete <id>                                     Delete a task
  pause <id>                                      Pause a task
  resume <id>                                     Resume a task
  set-model <id> <model>                          Change model for existing task
  set-one-shot <id> <true|false>                  Toggle one-shot (auto-pause after success)

Models: claude (default/latest), lmstudio/qwen, grok, haiku, sonnet, opus, fable
  Claude family names (opus/sonnet/haiku) auto-track the latest release.

Examples:
  node dist/schedule-cli.js create "Summarize my emails" "0 9 * * *" 123456789
  node dist/schedule-cli.js create "Check server status" "0 */4 * * *" 123456789 lmstudio
  node dist/schedule-cli.js create "Daily briefing" "0 9 * * *" 123456789 qwen
  node dist/schedule-cli.js list
  node dist/schedule-cli.js delete abc123
`)
}

function main(): void {
  initDatabase()

  const [, , command, ...args] = process.argv

  switch (command) {
    case 'create': {
      const oneShot = args.includes('--one-shot')
      const positional = args.filter((a) => a !== '--one-shot')
      if (positional.length < 3) {
        console.error('Usage: create "<prompt>" "<cron>" <chat_id> [model] [--one-shot]')
        process.exit(1)
      }
      const [prompt, cron, chatId, rawModel] = positional

      // Family aliases (opus/sonnet/haiku) auto-track latest Claude models
      const model = resolveTaskModel(rawModel) ?? undefined

      // Validate cron expression
      try {
        CronExpressionParser.parse(cron)
      } catch {
        console.error(`Invalid cron expression: ${cron}`)
        process.exit(1)
      }

      const id = randomUUID().slice(0, 8)
      const expr = CronExpressionParser.parse(cron)
      const nextRun = Math.floor(expr.next().getTime() / 1000)

      createTask(id, chatId, prompt, cron, nextRun, model, oneShot)
      console.log(`Task created: ${id}`)
      console.log(`  Prompt: ${prompt}`)
      console.log(`  Schedule: ${cron}`)
      console.log(`  Model: ${model ?? 'claude (default)'}`)
      console.log(`  One-shot: ${oneShot}`)
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        return
      }

      console.log(
        'ID'.padEnd(10) +
          'Status'.padEnd(10) +
          'Model'.padEnd(12) +
          'Schedule'.padEnd(18) +
          'Next Run'.padEnd(22) +
          'Prompt'
      )
      console.log('-'.repeat(92))

      for (const t of tasks) {
        const next = new Date(t.next_run * 1000).toLocaleString()
        const modelLabel = t.model === 'lmstudio' ? 'qwen' : (t.model ?? 'claude')
        console.log(
          t.id.padEnd(10) +
            t.status.padEnd(10) +
            modelLabel.padEnd(12) +
            t.schedule.padEnd(18) +
            next.padEnd(22) +
            t.prompt.slice(0, 40)
        )
      }
      break
    }

    case 'delete': {
      if (!args[0]) {
        console.error('Usage: delete <id>')
        process.exit(1)
      }
      deleteTask(args[0])
      console.log(`Deleted task: ${args[0]}`)
      break
    }

    case 'pause': {
      if (!args[0]) {
        console.error('Usage: pause <id>')
        process.exit(1)
      }
      setTaskStatus(args[0], 'paused')
      console.log(`Paused task: ${args[0]}`)
      break
    }

    case 'resume': {
      if (!args[0]) {
        console.error('Usage: resume <id>')
        process.exit(1)
      }
      setTaskStatus(args[0], 'active')
      console.log(`Resumed task: ${args[0]}`)
      break
    }

    case 'set-one-shot': {
      if (args.length < 2) {
        console.error('Usage: set-one-shot <id> <true|false>')
        process.exit(1)
      }
      const [taskId, rawFlag] = args
      const flag = rawFlag.toLowerCase()
      if (!['true', 'false', '1', '0'].includes(flag)) {
        console.error('Second argument must be true or false')
        process.exit(1)
      }
      const oneShot = flag === 'true' || flag === '1'
      setTaskOneShot(taskId, oneShot)
      console.log(`Task ${taskId} one_shot set to: ${oneShot}`)
      break
    }

    case 'set-model': {
      if (args.length < 2) {
        console.error('Usage: set-model <id> <model>')
        console.error('Models: claude, qwen/lmstudio, haiku, sonnet, opus')
        process.exit(1)
      }
      const [taskId, rawModelArg] = args
      const newModel = resolveTaskModel(rawModelArg)
      setTaskModel(taskId, newModel)
      const label = newModel === 'lmstudio' ? 'qwen' : (newModel ?? 'claude')
      console.log(`Task ${taskId} model set to: ${label}`)
      break
    }

    default:
      usage()
      process.exit(command ? 1 : 0)
  }
}

main()
