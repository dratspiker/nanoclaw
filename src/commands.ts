import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Execute a host command script.
 * Scripts are located in scripts/host-commands/ within the project root.
 */
async function runHostCommand(
  scriptName: string,
  args: string[] = [],
): Promise<CommandResult> {
  const scriptPath = path.join(
    process.cwd(),
    'scripts',
    'host-commands',
    scriptName,
  );
  const command = `${scriptPath} ${args.join(' ')}`;

  logger.info({ scriptName, command }, 'Executing host command');

  try {
    const { stdout, stderr } = await execAsync(command);
    if (stderr) {
      logger.warn({ scriptName, stderr }, 'Host command stderr output');
    }
    return {
      success: true,
      output: stdout.trim(),
    };
  } catch (err: any) {
    logger.error(
      { scriptName, err: err.message },
      'Failed to execute host command',
    );
    return {
      success: false,
      output: err.stdout?.trim() || '',
      error: err.stderr?.trim() || err.message,
    };
  }
}

export async function handleSync(): Promise<CommandResult> {
  return runHostCommand('sync.sh');
}

export async function handleStatus(): Promise<CommandResult> {
  // For now, use a built-in command if status.sh doesn't exist
  // or implement status.sh to check system health
  return runHostCommand('status.sh');
}

export async function handleBriefing(): Promise<CommandResult> {
  return runHostCommand('briefing.sh');
}

export async function handleCapture(item: string): Promise<CommandResult> {
  return runHostCommand('capture.sh', [`"${item.replace(/"/g, '\\"')}"`]);
}

export async function handleEnergy(level: string): Promise<CommandResult> {
  return runHostCommand('energy.sh', [level]);
}

/**
 * Dispatch a command based on text input (e.g. "/briefing").
 */
export async function handleCommand(text: string): Promise<CommandResult> {
  const [cmd, ...args] = text.trim().split(/\s+/);

  switch (cmd.toLowerCase()) {
    case '/sync':
      return handleSync();
    case '/status':
      return handleStatus();
    case '/briefing':
      return handleBriefing();
    case '/capture':
      return handleCapture(args.join(' '));
    case '/energy':
      return handleEnergy(args[0] || 'low');
    default:
      return {
        success: false,
        output: '',
        error: `Unknown command: ${cmd}`,
      };
  }
}
