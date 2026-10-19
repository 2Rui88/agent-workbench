import type { ZodType } from 'zod';
import { CoordinatorError } from './errors.js';

export type { RoleId } from './roles.js';
import type { RoleId } from './roles.js';

export interface Actor {
  groupId: string;
  roleId: RoleId;
  bindingGeneration: number;
  capabilityId: string;
}

export interface CommandDefinition<TInput, TOutput> {
  inputSchema: ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput> | TOutput;
}

export interface DryRunResult<TInput> {
  command: string;
  normalizedInput: TInput;
  sideEffects: false;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition<unknown, unknown>>();

  register<TInput, TOutput>(name: string, definition: CommandDefinition<TInput, TOutput>): void {
    if (this.commands.has(name)) {
      throw new CoordinatorError('COMMAND_EXISTS', `Command already registered: ${name}`, 'Choose a unique command name.');
    }
    this.commands.set(name, definition as CommandDefinition<unknown, unknown>);
  }

  async dryRun<TInput>(name: string, input: unknown): Promise<DryRunResult<TInput>> {
    const definition = this.commands.get(name);
    if (!definition) {
      throw new CoordinatorError('COMMAND_NOT_FOUND', `Unknown command: ${name}`, 'Register the command before previewing it.');
    }
    const parsed = await definition.inputSchema.parseAsync(input);
    return { command: name, normalizedInput: parsed as TInput, sideEffects: false };
  }
}
