import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { AscApiError, AscNetworkError, type AscClient } from "../asc/client.js";
import { ConfigError, type Config } from "../config.js";

/**
 * - read: never changes anything.
 * - write: additive or easily reversed changes (notes, adding a build to a group).
 * - destructive: deletes something or can't be taken back (deleting screenshots, offers or
 *   testers, submitting for review). These take `dry_run`, which defaults to true.
 */
export type ToolKind = "read" | "write" | "destructive";

export interface Services {
  asc: AscClient;
  config: Config;
}

export interface Runtime {
  /** Returns the API client and config, or throws ConfigError if the environment is incomplete. */
  services(): Services;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface ToolContext extends Services {
  signal: AbortSignal;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Sends an MCP progress notification if the client asked for them. Never throws. */
  progress(message: string, progress?: number, total?: number): Promise<void>;
  /** For write tools: true when this call only plans. */
  dryRun: boolean;
}

/** An error whose message is meant for the agent as-is: what went wrong and what to do next. */
export class UserError extends Error {
  override name = "UserError";
}

export interface ToolDefinition<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  /** Re-running with the same input is safe (true for nearly every tool here). */
  idempotent?: boolean;
  /** A read tool that can also write and gates that itself (asc_request). */
  gatesOwnWrites?: boolean;
  input: Shape;
  run(args: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: ToolContext): Promise<string>;
}

export const dryRunInput = (kind: ToolKind) =>
  z
    .boolean()
    .optional()
    .describe(
      kind === "destructive"
        ? "Defaults to true: return the plan without changing anything. Call again with dry_run: false to apply it."
        : "If true, return the plan without changing anything.",
    );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export function defineTool<Shape extends ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return tool;
}

/** The tool's input schema as clients see it: write tools also get dry_run. */
export function inputShape(tool: AnyTool): ZodRawShape {
  return tool.kind === "read" ? tool.input : { ...tool.input, dry_run: dryRunInput(tool.kind) };
}

export function registerTools(server: McpServer, tools: readonly AnyTool[], runtime: Runtime): void {
  for (const tool of tools) {
    const shape = inputShape(tool);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: describe(tool),
        inputSchema: shape,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.kind === "read" && !tool.gatesOwnWrites,
          destructiveHint: tool.kind === "destructive" || tool.gatesOwnWrites === true,
          idempotentHint: tool.idempotent ?? true,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, extra) => {
        const progressToken = extra._meta?.progressToken;
        let step = 0;
        const progress = async (message: string, value?: number, total?: number) => {
          if (progressToken === undefined) return;
          step++;
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: value ?? step, ...(total !== undefined ? { total } : {}), message },
            });
          } catch {
            // Progress is best-effort.
          }
        };
        return invoke(tool, args, runtime, { signal: extra.signal, progress });
      },
    );
  }
}

/** Runs one tool call. Exported so tests can call tools without an MCP transport. */
export async function invoke(
  tool: AnyTool,
  args: Record<string, unknown>,
  runtime: Runtime,
  extra: { signal?: AbortSignal; progress?: ToolContext["progress"] } = {},
): Promise<CallToolResult> {
  try {
    const services = runtime.services();
    const dryRun = tool.kind === "read" ? false : ((args.dry_run as boolean | undefined) ?? tool.kind === "destructive");
    if (tool.kind !== "read" && !dryRun && !services.config.write) {
      throw new UserError(
        `${tool.name} changes App Store Connect, and this server is read-only. ` +
          "Ask the user to restart it with ASC_WRITE=1 to allow changes. You can still call it with dry_run: true to see the plan.",
      );
    }
    const ctx: ToolContext = {
      ...services,
      signal: extra.signal ?? new AbortController().signal,
      sleep: runtime.sleep,
      now: runtime.now,
      progress: extra.progress ?? (async () => {}),
      dryRun,
    };
    const text = await tool.run(args, ctx);
    return { content: [{ type: "text", text: dryRun ? `DRY RUN: nothing was changed.\n${text}` : text }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: errorText(error) }] };
  }
}

function errorText(error: unknown): string {
  if (error instanceof UserError || error instanceof ConfigError || error instanceof AscApiError || error instanceof AscNetworkError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "AbortError") return "Cancelled. Steps already done stay done; re-running continues from there.";
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

function describe(tool: AnyTool): string {
  const suffix =
    tool.kind === "read"
      ? ""
      : tool.kind === "destructive"
        ? "\n\nDestructive: dry_run defaults to true and returns the plan. Show it to the user, then call again with dry_run: false. Needs ASC_WRITE=1."
        : "\n\nChanges App Store Connect (needs ASC_WRITE=1). Safe to re-run: steps already done are skipped.";
  return tool.description + suffix;
}
